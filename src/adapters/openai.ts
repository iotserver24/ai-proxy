import type { Request, Response as ExpressResponse } from 'express';
import { callUpstream, isRetryableError, UPSTREAM_CHAT_PATH, UPSTREAM_MESSAGES_PATH } from '../upstream.js';
import { normalizeOpenAI } from '../utils/normalize.js';
import { initSSE, writeSSE, endSSE } from '../utils/sse.js';
import { padOpenAIUsage } from '../utils/usage.js';
import crypto from 'crypto';

export async function handleOpenAI(req: Request, res: ExpressResponse): Promise<void> {
  const reqId = crypto.randomUUID().slice(0, 8);
  const body = normalizeOpenAI(req.body);
  const stream = body.stream;
  const start = Date.now();

  async function attempt(path: string, attemptNum: number): Promise<void> {
    const upstreamRes = await callUpstream(path, body, stream);

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
    console.log(`[${reqId}] route=${path} model=${body.model} stream=${stream} ${latency}ms ok`);

    if (stream) {
      await pipeOpenAIStream(upstreamRes, res);
    } else {
      const json = await upstreamRes.json();
      json.usage = padOpenAIUsage(json.usage);
      res.json(json);
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

export async function pipeOpenAIStream(upstreamRes: globalThis.Response, res: ExpressResponse): Promise<void> {
  initSSE(res);

  const reader = upstreamRes.body?.getReader();
  if (!reader) {
    endSSE(res, { error: 'no body' });
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let lastUsage: ReturnType<typeof padOpenAIUsage> | undefined;
  let heldFinish: any;
  let meta: { id?: string; created?: number; model?: string } = {};

  function rememberUsage(usage: any): void {
    const padded = padOpenAIUsage(usage);
    if (!lastUsage || padded.total_tokens >= lastUsage.total_tokens) {
      lastUsage = padded;
    }
  }

  function flushFinish(): void {
    const chunk = heldFinish || {
      id: meta.id,
      object: 'chat.completion.chunk',
      created: meta.created,
      model: meta.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    };
    chunk.usage = lastUsage || padOpenAIUsage(undefined);
    writeSSE(res, chunk);
    heldFinish = undefined;
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') {
          flushFinish();
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        try {
          const chunk = JSON.parse(data);
          if (chunk.id) meta.id = chunk.id;
          if (chunk.created) meta.created = chunk.created;
          if (chunk.model) meta.model = chunk.model;
          if (chunk.usage) rememberUsage(chunk.usage);

          const choice = chunk.choices?.[0];
          const delta = choice?.delta || {};
          const hasContent = !!(
            delta.content ||
            delta.tool_calls ||
            delta.function_call ||
            delta.role ||
            delta.reasoning_content
          );
          const finished = !!choice?.finish_reason;

          if (hasContent && !finished) {
            writeSSE(res, chunk);
            continue;
          }

          if (finished || chunk.usage) {
            heldFinish = chunk;
            if (chunk.usage) delete chunk.usage;
            continue;
          }

          writeSSE(res, chunk);
        } catch {
          res.write(`data: ${data}\n\n`);
        }
      }
    }
  } catch (err: any) {
    if (err.name !== 'AbortError') {
      console.error('stream error:', err.message);
    }
  }

  if (!res.writableEnded) {
    flushFinish();
    res.write('data: [DONE]\n\n');
    res.end();
  }
}
