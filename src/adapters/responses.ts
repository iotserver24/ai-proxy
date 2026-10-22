import type { Request, Response as ExpressResponse } from 'express';
import { callUpstream, isRetryableError, UPSTREAM_CHAT_PATH, UPSTREAM_MESSAGES_PATH } from '../upstream.js';
import {
  normalizeResponses,
  buildAnthropicBody,
  anthropicToResponses,
} from '../utils/normalize.js';
import { initSSE, writeSSEEvent, parseSSELine } from '../utils/sse.js';
import { padResponsesUsage } from '../utils/usage.js';
import crypto from 'crypto';

const CLAUDE_MODELS = new Set([
  'claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-4-8',
  'claude-sonnet-4-5', 'claude-sonnet-4-6',
]);

export async function handleResponses(req: Request, res: ExpressResponse): Promise<void> {
  const reqId = crypto.randomUUID().slice(0, 8);
  const model = req.body.model || 'gpt-6.1-sol';
  const isClaude = CLAUDE_MODELS.has(model) || model.startsWith('claude-');
  const stream = !!req.body.stream;
  const start = Date.now();

  const chatBody = normalizeResponses(req.body);
  const anthBody = buildAnthropicBody(req.body);

  const primaryPath = isClaude ? UPSTREAM_MESSAGES_PATH : UPSTREAM_CHAT_PATH;
  const fallbackPath = isClaude ? UPSTREAM_CHAT_PATH : UPSTREAM_MESSAGES_PATH;
  const primaryBody = isClaude ? anthBody : chatBody;
  const fallbackBody = isClaude ? chatBody : anthBody;

  async function attempt(path: string, body: unknown, attemptNum: number): Promise<void> {
    const upstreamRes = await callUpstream(path, body, stream);

    if (!upstreamRes.ok && attemptNum < 2 && isRetryableError(upstreamRes)) {
      console.log(`[${reqId}] retry ${path} -> ${fallbackPath} (status ${upstreamRes.status})`);
      return attempt(fallbackPath, fallbackBody, attemptNum + 1);
    }

    if (!upstreamRes.ok) {
      const errBody = await upstreamRes.text();
      console.log(`[${reqId}] fail ${upstreamRes.status}`);
      res.status(upstreamRes.status).json({ error: { message: errBody, status: upstreamRes.status } });
      return;
    }

    const latency = Date.now() - start;
    console.log(`[${reqId}] route=${path} model=${model} stream=${stream} ${latency}ms ok`);

    if (stream) {
      if (path === UPSTREAM_MESSAGES_PATH) {
        await anthropicStreamToResponses(upstreamRes, res, model);
      } else {
        await openaiStreamToResponses(upstreamRes, res, model);
      }
    } else {
      const json = await upstreamRes.json();
      res.json(path === UPSTREAM_MESSAGES_PATH
        ? anthropicToResponses(json, model)
        : openAIToResponses(json, model));
    }
  }

  try {
    await attempt(primaryPath, primaryBody, 1);
  } catch (err: any) {
    const latency = Date.now() - start;
    console.log(`[${reqId}] fail error=${err.message} ${latency}ms`);
    if (!res.headersSent) {
      res.status(502).json({ error: { message: 'upstream request failed', detail: err.message } });
    }
  }
}

export function openAIToResponses(openai: any, model: string): any {
  const choice = openai.choices?.[0] || {};
  const message = choice.message || {};
  const output: any[] = [];

  if (message.content) {
    output.push({
      type: 'message',
      id: `msg_${crypto.randomUUID().slice(0, 8)}`,
      role: 'assistant',
      content: [{ type: 'output_text', text: message.content, annotations: [] }],
    });
  }

  for (const toolCall of message.tool_calls || []) {
    const id = toolCall.id || `call_${crypto.randomUUID().slice(0, 8)}`;
    output.push({
      type: 'function_call',
      id,
      call_id: id,
      name: toolCall.function?.name || toolCall.name,
      arguments: typeof toolCall.function?.arguments === 'string'
        ? toolCall.function.arguments
        : JSON.stringify(toolCall.function?.arguments ?? {}),
    });
  }

  return {
    id: `resp_${crypto.randomUUID().slice(0, 8)}`,
    object: 'response',
    created: Math.floor(Date.now() / 1000),
    model: openai.model || model,
    output,
    status: 'completed',
    usage: padResponsesUsage(openai.usage),
  };
}

interface ResponseTextItem {
  outputIndex: number;
  id: string;
  text: string;
}

interface ResponseToolItem {
  outputIndex: number;
  id: string;
  callId: string;
  name: string;
  arguments: string;
}

export async function openaiStreamToResponses(
  upstreamRes: globalThis.Response,
  res: ExpressResponse,
  model: string,
): Promise<void> {
  initSSE(res);
  const respId = `resp_${crypto.randomUUID().slice(0, 8)}`;
  const now = Math.floor(Date.now() / 1000);
  const output: any[] = [];
  let textItem: ResponseTextItem | undefined;
  const toolItems = new Map<number, ResponseToolItem>();
  let finalEmitted = false;
  let lastUsage: any;

  writeSSEEvent(res, 'response.created', {
    type: 'response.created',
    response: { id: respId, object: 'response', created: now, model, output: [], usage: null },
  });

  const reader = upstreamRes.body?.getReader();
  if (!reader) {
    emitFinal();
    if (!res.writableEnded) res.end();
    return;
  }

  function emitTextStart(): ResponseTextItem {
    if (textItem) return textItem;
    textItem = { outputIndex: output.length, id: `msg_${crypto.randomUUID().slice(0, 8)}`, text: '' };
    output.push({
      type: 'message',
      id: textItem.id,
      role: 'assistant',
      content: [{ type: 'output_text', text: '', annotations: [] }],
    });
    writeSSEEvent(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      output_index: textItem.outputIndex,
      item: { id: textItem.id, type: 'message', role: 'assistant', content: [] },
    });
    writeSSEEvent(res, 'response.content_part.added', {
      type: 'response.content_part.added',
      item_id: textItem.id,
      output_index: textItem.outputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
    return textItem;
  }

  function emitToolDelta(toolCall: any): void {
    const toolIndex = toolCall.index ?? 0;
    let item = toolItems.get(toolIndex);
    if (!item) {
      const id = toolCall.id || `call_${crypto.randomUUID().slice(0, 8)}`;
      item = {
        outputIndex: output.length,
        id,
        callId: id,
        name: toolCall.function?.name || toolCall.name || '',
        arguments: '',
      };
      toolItems.set(toolIndex, item);
      output.push({
        type: 'function_call',
        id: item.id,
        call_id: item.callId,
        name: item.name,
        arguments: '',
      });
      writeSSEEvent(res, 'response.output_item.added', {
        type: 'response.output_item.added',
        output_index: item.outputIndex,
        item: {
          id: item.id,
          type: 'function_call',
          call_id: item.callId,
          name: item.name,
          arguments: '',
        },
      });
    } else if (toolCall.id) {
      item.id = toolCall.id;
      item.callId = toolCall.id;
    }

    if (toolCall.function?.name && !item.name) item.name = toolCall.function.name;
    const fragment = toolCall.function?.arguments ?? toolCall.arguments ?? '';
    if (fragment) {
      item.arguments += fragment;
      const outputItem = output[item.outputIndex];
      if (outputItem) outputItem.arguments = item.arguments;
      writeSSEEvent(res, 'response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        item_id: item.id,
        output_index: item.outputIndex,
        delta: fragment,
      });
    }
  }

  function emitFinal(usage?: any): void {
    if (finalEmitted) return;
    finalEmitted = true;

    if (textItem) {
      writeSSEEvent(res, 'response.output_text.done', {
        type: 'response.output_text.done',
        item_id: textItem.id,
        output_index: textItem.outputIndex,
        content_index: 0,
        text: textItem.text,
      });
      writeSSEEvent(res, 'response.content_part.done', {
        type: 'response.content_part.done',
        item_id: textItem.id,
        output_index: textItem.outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: textItem.text, annotations: [] },
      });
      const finalText = output[textItem.outputIndex];
      if (finalText) finalText.content = [{ type: 'output_text', text: textItem.text, annotations: [] }];
      writeSSEEvent(res, 'response.output_item.done', {
        type: 'response.output_item.done',
        output_index: textItem.outputIndex,
        item: finalText,
      });
    }

    for (const item of toolItems.values()) {
      const finalTool = output[item.outputIndex];
      if (finalTool) {
        finalTool.id = item.id;
        finalTool.call_id = item.callId;
        finalTool.name = item.name;
        finalTool.arguments = item.arguments;
      }
      writeSSEEvent(res, 'response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        item_id: item.id,
        output_index: item.outputIndex,
        arguments: item.arguments,
      });
      writeSSEEvent(res, 'response.output_item.done', {
        type: 'response.output_item.done',
        output_index: item.outputIndex,
        item: finalTool,
      });
    }

    writeSSEEvent(res, 'response.completed', {
      type: 'response.completed',
      response: {
        id: respId,
        object: 'response',
        created: now,
        model,
        output,
        status: 'completed',
        usage: padResponsesUsage(openAIUsageToResponses(usage)),
      },
    });
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent: string | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '');
        const parsed = parseSSELine(line);
        if (!parsed) continue;
        if (parsed.event !== undefined) {
          currentEvent = parsed.event;
          continue;
        }
        if (parsed.data === undefined) continue;
        if (parsed.data === '[DONE]') {
          emitFinal(lastUsage);
          continue;
        }

        try {
          const chunk = JSON.parse(parsed.data);
          const delta = chunk.choices?.[0]?.delta;
          const finishReason = chunk.choices?.[0]?.finish_reason;
          if (delta?.content) {
            const item = emitTextStart();
            item.text += delta.content;
            const outputItem = output[item.outputIndex];
            if (outputItem) outputItem.content[0].text = item.text;
            writeSSEEvent(res, 'response.output_text.delta', {
              type: 'response.output_text.delta',
              delta: delta.content,
              item_id: item.id,
              output_index: item.outputIndex,
              content_index: 0,
            });
          }
          for (const toolCall of delta?.tool_calls || []) emitToolDelta(toolCall);
          if (delta?.function_call) emitToolDelta({ index: 0, function: delta.function_call });
          if (chunk.usage) {
            const nextTotal = chunk.usage.total_tokens ?? chunk.usage.prompt_tokens ?? 0;
            const prevTotal = lastUsage?.total_tokens ?? lastUsage?.prompt_tokens ?? 0;
            if (!lastUsage || nextTotal >= prevTotal) lastUsage = chunk.usage;
          }
          if (finishReason && chunk.usage) emitFinal(lastUsage);
          if (currentEvent === 'response.completed') emitFinal(chunk.usage || lastUsage);
        } catch {
          // Ignore malformed/non-JSON SSE records and continue the stream.
        }
      }
    }
  } catch (err: any) {
    if (err.name !== 'AbortError') console.error('stream error:', err.message);
  }

  emitFinal(lastUsage);
  if (!res.writableEnded) res.end();
}

export async function anthropicStreamToResponses(
  upstreamRes: globalThis.Response,
  res: ExpressResponse,
  model: string,
): Promise<void> {
  initSSE(res);
  const respId = `resp_${crypto.randomUUID().slice(0, 8)}`;
  const now = Math.floor(Date.now() / 1000);
  const output: any[] = [];
  const blocks = new Map<number, { kind: 'text' | 'tool'; outputIndex: number; id: string; text?: string; callId?: string; name?: string; arguments?: string }>();
  let finalEmitted = false;
  let lastUsage: any;

  writeSSEEvent(res, 'response.created', {
    type: 'response.created',
    response: { id: respId, object: 'response', created: now, model, output: [], usage: null },
  });

  const reader = upstreamRes.body?.getReader();
  if (!reader) {
    emitFinal();
    if (!res.writableEnded) res.end();
    return;
  }

  function emitBlockStart(index: number, block: any): void {
    if (blocks.has(index)) return;
    const isTool = block?.type === 'tool_use';
    const id = block?.id || (isTool ? `call_${crypto.randomUUID().slice(0, 8)}` : `msg_${crypto.randomUUID().slice(0, 8)}`);
    const state = isTool
      ? { kind: 'tool' as const, outputIndex: output.length, id, callId: id, name: block.name || '', arguments: '' }
      : { kind: 'text' as const, outputIndex: output.length, id, text: '' };
    blocks.set(index, state);

    if (isTool) {
      output.push({ type: 'function_call', id, call_id: id, name: state.name, arguments: '' });
      writeSSEEvent(res, 'response.output_item.added', {
        type: 'response.output_item.added',
        output_index: state.outputIndex,
        item: { type: 'function_call', id, call_id: id, name: state.name, arguments: '' },
      });
    } else {
      output.push({ type: 'message', id, role: 'assistant', content: [{ type: 'output_text', text: '', annotations: [] }] });
      writeSSEEvent(res, 'response.output_item.added', {
        type: 'response.output_item.added',
        output_index: state.outputIndex,
        item: { id, type: 'message', role: 'assistant', content: [] },
      });
      writeSSEEvent(res, 'response.content_part.added', {
        type: 'response.content_part.added',
        item_id: id,
        output_index: state.outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
    }
  }

  function emitFinal(): void {
    if (finalEmitted) return;
    finalEmitted = true;

    for (const state of blocks.values()) {
      const item = output[state.outputIndex];
      if (state.kind === 'text') {
        writeSSEEvent(res, 'response.output_text.done', {
          type: 'response.output_text.done',
          item_id: state.id,
          output_index: state.outputIndex,
          content_index: 0,
          text: state.text || '',
        });
        writeSSEEvent(res, 'response.content_part.done', {
          type: 'response.content_part.done',
          item_id: state.id,
          output_index: state.outputIndex,
          content_index: 0,
          part: { type: 'output_text', text: state.text || '', annotations: [] },
        });
        if (item) item.content = [{ type: 'output_text', text: state.text || '', annotations: [] }];
      } else {
        if (item) {
          item.id = state.id;
          item.call_id = state.callId;
          item.name = state.name;
          item.arguments = state.arguments || '';
        }
        writeSSEEvent(res, 'response.function_call_arguments.done', {
          type: 'response.function_call_arguments.done',
          item_id: state.id,
          output_index: state.outputIndex,
          arguments: state.arguments || '',
        });
      }
      writeSSEEvent(res, 'response.output_item.done', {
        type: 'response.output_item.done',
        output_index: state.outputIndex,
        item,
      });
    }

    writeSSEEvent(res, 'response.completed', {
      type: 'response.completed',
      response: {
        id: respId,
        object: 'response',
        created: now,
        model,
        output,
        status: 'completed',
        usage: padResponsesUsage(anthropicUsageToResponses(lastUsage)),
      },
    });
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent: string | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '');
        const parsed = parseSSELine(line);
        if (!parsed) continue;
        if (parsed.event !== undefined) {
          currentEvent = parsed.event;
          continue;
        }
        if (parsed.data === undefined) continue;
        if (parsed.data === '[DONE]') {
          emitFinal();
          continue;
        }

        try {
          const data = JSON.parse(parsed.data);
          const event = data.type || currentEvent;
          if (event === 'message_start') {
            lastUsage = data.message?.usage;
          } else if (event === 'content_block_start') {
            emitBlockStart(data.index ?? 0, data.content_block);
          } else if (event === 'content_block_delta') {
            const index = data.index ?? 0;
            const delta = data.delta || {};
            if (!blocks.has(index)) {
              emitBlockStart(index, delta.type === 'input_json_delta' ? { type: 'tool_use' } : { type: 'text' });
            }
            const state = blocks.get(index)!;
            if (delta.type === 'text_delta') {
              state.text = (state.text || '') + (delta.text || '');
              const item = output[state.outputIndex];
              if (item) item.content[0].text = state.text;
              writeSSEEvent(res, 'response.output_text.delta', {
                type: 'response.output_text.delta',
                delta: delta.text || '',
                item_id: state.id,
                output_index: state.outputIndex,
                content_index: 0,
              });
            } else if (delta.type === 'input_json_delta') {
              state.arguments = (state.arguments || '') + (delta.partial_json || '');
              const item = output[state.outputIndex];
              if (item) item.arguments = state.arguments;
              writeSSEEvent(res, 'response.function_call_arguments.delta', {
                type: 'response.function_call_arguments.delta',
                item_id: state.id,
                output_index: state.outputIndex,
                delta: delta.partial_json || '',
              });
            }
          } else if (event === 'message_delta') {
            lastUsage = data.usage || lastUsage;
          } else if (event === 'message_stop') {
            emitFinal();
          }
        } catch {
          // Ignore malformed/non-JSON SSE records and continue the stream.
        }
      }
    }
  } catch (err: any) {
    if (err.name !== 'AbortError') console.error('stream error:', err.message);
  }

  emitFinal();
  if (!res.writableEnded) res.end();
}

function openAIUsageToResponses(usage: any): any {
  return {
    input_tokens: usage?.prompt_tokens || usage?.input_tokens || 0,
    output_tokens: usage?.completion_tokens || usage?.output_tokens || 0,
    total_tokens: usage?.total_tokens || 0,
  };
}

function anthropicUsageToResponses(usage: any): any {
  return {
    input_tokens: usage?.input_tokens || 0,
    output_tokens: usage?.output_tokens || 0,
    total_tokens: (usage?.input_tokens || 0) + (usage?.output_tokens || 0),
  };
}
