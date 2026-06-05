import type { Request, Response as ExpressResponse } from 'express';
import { callUpstream, isRetryableError, UPSTREAM_CHAT_PATH, UPSTREAM_RESPONSES_PATH } from '../upstream.js';
import { normalizeResponses } from '../utils/normalize.js';
import { initSSE, writeSSEEvent, parseSSELine } from '../utils/sse.js';
import crypto from 'crypto';

export async function handleResponses(req: Request, res: ExpressResponse): Promise<void> {
  const reqId = crypto.randomUUID().slice(0, 8);
  const normalized = normalizeResponses(req.body);
  const stream = normalized.stream;
  const start = Date.now();

  async function attempt(path: string, attemptNum: number): Promise<void> {
    const upstreamRes = await callUpstream(path, normalized, stream);

    if (!upstreamRes.ok && attemptNum < 2 && isRetryableError(upstreamRes)) {
      const altPath = path === UPSTREAM_CHAT_PATH ? UPSTREAM_RESPONSES_PATH : UPSTREAM_CHAT_PATH;
      console.log(`[${reqId}] retry ${path} -> ${altPath} (status ${upstreamRes.status})`);
      return attempt(altPath, attemptNum + 1);
    }

    if (!upstreamRes.ok) {
      const errBody = await upstreamRes.text();
      console.log(`[${reqId}] fail ${upstreamRes.status}`);
      res.status(upstreamRes.status).json({ error: { message: errBody, status: upstreamRes.status } });
      return;
    }

    const latency = Date.now() - start;
    console.log(`[${reqId}] route=${path} model=${normalized.model} stream=${stream} ${latency}ms ok`);

    if (stream) {
      await responsesStream(upstreamRes, res, normalized.model);
    } else {
      const json = await upstreamRes.json();
      const mapped = openAIToResponses(json, normalized.model);
      res.json(mapped);
    }
  }

  try {
    await attempt(UPSTREAM_CHAT_PATH, 1);
  } catch (err: any) {
    const latency = Date.now() - start;
    console.log(`[${reqId}] fail error=${err.message} ${latency}ms`);
    if (!res.headersSent) {
      res.status(502).json({ error: { message: 'upstream request failed', detail: err.message } });
    }
  }
}

function openAIToResponses(openai: any, model: string): any {
  const choice = openai.choices?.[0] || {};
  const now = Math.floor(Date.now() / 1000);
  return {
    id: `resp_${crypto.randomUUID().slice(0, 8)}`,
    object: 'response',
    created: now,
    model: openai.model || model,
    output: [
      {
        type: 'message',
        id: `msg_${crypto.randomUUID().slice(0, 8)}`,
        role: 'assistant',
        content: [
          { type: 'output_text', text: choice.message?.content || '', annotations: [] },
        ],
      },
    ],
    usage: {
      input_tokens: openai.usage?.prompt_tokens || 0,
      output_tokens: openai.usage?.completion_tokens || 0,
      total_tokens: openai.usage?.total_tokens || 0,
    },
  };
}

async function responsesStream(upstreamRes: globalThis.Response, res: ExpressResponse, model: string): Promise<void> {
  initSSE(res);

  const respId = `resp_${crypto.randomUUID().slice(0, 8)}`;
  const msgId = `msg_${crypto.randomUUID().slice(0, 8)}`;
  const now = Math.floor(Date.now() / 1000);

  writeSSEEvent(res, 'response.created', {
    type: 'response.created',
    response: {
      id: respId,
      object: 'response',
      created: now,
      model,
      output: [],
      usage: null,
    },
  });

  const reader = upstreamRes.body?.getReader();
  if (!reader) {
    writeSSEEvent(res, 'response.completed', { type: 'response.completed', response: null });
    res.end();
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  let itemsEmitted = false;
  let finalEmitted = false;

  function emitItemStart(): void {
    if (itemsEmitted) return;
    itemsEmitted = true;

    writeSSEEvent(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        content: [],
      },
    });

    writeSSEEvent(res, 'response.content_part.added', {
      type: 'response.content_part.added',
      item_id: msgId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
  }

  function emitFinal(usage?: any): void {
    if (finalEmitted) return;
    finalEmitted = true;

    emitItemStart();

    writeSSEEvent(res, 'response.output_text.done', {
      type: 'response.output_text.done',
      item_id: msgId,
      output_index: 0,
      content_index: 0,
      text: fullText,
    });

    writeSSEEvent(res, 'response.content_part.done', {
      type: 'response.content_part.done',
      item_id: msgId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: fullText, annotations: [] },
    });

    writeSSEEvent(res, 'response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: fullText, annotations: [] }],
      },
    });

    writeSSEEvent(res, 'response.completed', {
      type: 'response.completed',
      response: {
        id: respId,
        object: 'response',
        created: now,
        model,
        output: [
          {
            type: 'message',
            id: msgId,
            role: 'assistant',
            content: [{ type: 'output_text', text: fullText, annotations: [] }],
          },
        ],
        usage: usage || null,
      },
    });
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        emitFinal();
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const parsed = parseSSELine(line);
        if (!parsed || !parsed.data) continue;
        if (parsed.data === '[DONE]') {
          emitFinal();
          continue;
        }

        try {
          const chunk = JSON.parse(parsed.data);
          const delta = chunk.choices?.[0]?.delta;
          const finishReason = chunk.choices?.[0]?.finish_reason;

          if (delta?.content) {
            emitItemStart();
            fullText += delta.content;
            writeSSEEvent(res, 'response.output_text.delta', {
              type: 'response.output_text.delta',
              delta: delta.content,
              item_id: msgId,
              output_index: 0,
              content_index: 0,
            });
          }

          if (finishReason) {
            emitFinal(chunk.usage);
          }
        } catch {
          // skip invalid JSON
        }
      }
    }
  } catch (err: any) {
    if (err.name !== 'AbortError') {
      console.error('stream error:', err.message);
    }
    emitFinal();
  }

  if (!res.writableEnded) {
    res.end();
  }
}
