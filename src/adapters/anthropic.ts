import type { Request, Response as ExpressResponse } from 'express';
import { callUpstream, isRetryableError, UPSTREAM_CHAT_PATH, UPSTREAM_MESSAGES_PATH } from '../upstream.js';
import { normalizeAnthropic } from '../utils/normalize.js';
import { initSSE, writeSSEEvent, parseSSELine } from '../utils/sse.js';
import crypto from 'crypto';

export async function handleAnthropic(req: Request, res: ExpressResponse): Promise<void> {
  const reqId = crypto.randomUUID().slice(0, 8);
  const normalized = normalizeAnthropic(req.body);
  const stream = normalized.stream;
  const start = Date.now();

  async function attempt(path: string, attemptNum: number): Promise<void> {
    const upstreamRes = await callUpstream(path, normalized, stream);

    if (!upstreamRes.ok && attemptNum < 2 && isRetryableError(upstreamRes)) {
      const altPath = path === UPSTREAM_CHAT_PATH ? UPSTREAM_MESSAGES_PATH : UPSTREAM_CHAT_PATH;
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
      await anthropicStream(upstreamRes, res, normalized.model);
    } else {
      const json = await upstreamRes.json();
      res.json(openAIToAnthropic(json, normalized.model));
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

export function openAIToAnthropic(openai: any, model: string): any {
  const choice = openai.choices?.[0] || {};
  const message = choice.message || {};
  const content: any[] = [];

  if (message.content) {
    content.push({ type: 'text', text: message.content });
  }
  for (const toolCall of message.tool_calls || []) {
    content.push({
      type: 'tool_use',
      id: toolCall.id || `call_${crypto.randomUUID().slice(0, 8)}`,
      name: toolCall.function?.name || toolCall.name,
      input: parseJsonObject(toolCall.function?.arguments ?? toolCall.arguments),
    });
  }

  return {
    id: `msg_${crypto.randomUUID().slice(0, 8)}`,
    type: 'message',
    role: 'assistant',
    content,
    model: openai.model || model,
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: openai.usage?.prompt_tokens || 0,
      output_tokens: openai.usage?.completion_tokens || 0,
    },
  };
}

function mapFinishReason(reason: string | null): string {
  switch (reason) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'tool_calls':
    case 'function_call': return 'tool_use';
    case 'content_filter': return 'content_filter';
    default: return 'end_turn';
  }
}

interface ToolStreamState {
  outputIndex: number;
  id: string;
  name: string;
  input: string;
}

async function anthropicStream(upstreamRes: globalThis.Response, res: ExpressResponse, model: string): Promise<void> {
  initSSE(res);

  const msgId = `msg_${crypto.randomUUID().slice(0, 8)}`;
  const content: any[] = [];
  const toolStates = new Map<number, ToolStreamState>();
  let textStarted = false;
  let finishReason: string | null = null;
  let finalUsage: any;
  let nextOutputIndex = 0;

  writeSSEEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  const reader = upstreamRes.body?.getReader();
  if (!reader) {
    writeSSEEvent(res, 'message_stop', { type: 'message_stop' });
    res.end();
    return;
  }

  function startTextBlock(): void {
    if (textStarted) return;
    textStarted = true;
    content.push({ type: 'text', text: '' });
    writeSSEEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });
    nextOutputIndex = Math.max(nextOutputIndex, 1);
  }

  function emitToolDelta(toolCall: any): void {
    const index = toolCall.index ?? 0;
    let state = toolStates.get(index);
    if (!state) {
      const id = toolCall.id || `call_${crypto.randomUUID().slice(0, 8)}`;
      const outputIndex = nextOutputIndex++;
      state = {
        outputIndex,
        id,
        name: toolCall.function?.name || toolCall.name || '',
        input: '',
      };
      toolStates.set(index, state);
      content.push({ type: 'tool_use', id, name: state.name, input: {} });
      writeSSEEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index: outputIndex,
        content_block: { type: 'tool_use', id, name: state.name, input: {} },
      });
    }

    if (toolCall.function?.name && !state.name) state.name = toolCall.function.name;
    const fragment = toolCall.function?.arguments ?? toolCall.arguments ?? '';
    if (fragment) {
      state.input += fragment;
      writeSSEEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: state.outputIndex,
        delta: { type: 'input_json_delta', partial_json: fragment },
      });
    }
  }

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const rawLine of lines) {
        const parsed = parseSSELine(rawLine.replace(/\r$/, ''));
        if (!parsed || parsed.data === undefined || parsed.data === '[DONE]') continue;

        try {
          const chunk = JSON.parse(parsed.data);
          const delta = chunk.choices?.[0]?.delta;
          const reason = chunk.choices?.[0]?.finish_reason;

          if (delta?.content) {
            startTextBlock();
            content[0].text += delta.content;
            writeSSEEvent(res, 'content_block_delta', {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: delta.content },
            });
          }
          for (const toolCall of delta?.tool_calls || []) emitToolDelta(toolCall);
          if (delta?.function_call) emitToolDelta({ index: 0, function: delta.function_call });
          if (reason) finishReason = reason;
          if (chunk.usage) finalUsage = chunk.usage;
        } catch {
          // Skip invalid JSON records while keeping the SSE connection alive.
        }
      }
    }
  } catch (err: any) {
    if (err.name !== 'AbortError') console.error('stream error:', err.message);
  }

  for (let index = 0; index < content.length; index += 1) {
    writeSSEEvent(res, 'content_block_stop', { type: 'content_block_stop', index });
  }
  writeSSEEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: mapFinishReason(finishReason), stop_sequence: null },
    usage: { output_tokens: finalUsage?.completion_tokens || 0 },
  });
  writeSSEEvent(res, 'message_stop', { type: 'message_stop' });

  if (!res.writableEnded) res.end();
}

function parseJsonObject(value: any): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(typeof value === 'string' ? value : '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
