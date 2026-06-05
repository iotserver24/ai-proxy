import { callUpstream, isRetryableError, UPSTREAM_CHAT_PATH, UPSTREAM_MESSAGES_PATH } from '../upstream.js';
import { normalizeAnthropic } from '../utils/normalize.js';
import { initSSE, writeSSEEvent, parseSSELine } from '../utils/sse.js';
import crypto from 'crypto';
export async function handleAnthropic(req, res) {
    const reqId = crypto.randomUUID().slice(0, 8);
    const normalized = normalizeAnthropic(req.body);
    const stream = normalized.stream;
    const start = Date.now();
    async function attempt(path, attemptNum) {
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
        }
        else {
            const json = await upstreamRes.json();
            const mapped = openAIToAnthropic(json, normalized.model);
            res.json(mapped);
        }
    }
    try {
        await attempt(UPSTREAM_CHAT_PATH, 1);
    }
    catch (err) {
        const latency = Date.now() - start;
        console.log(`[${reqId}] fail error=${err.message} ${latency}ms`);
        if (!res.headersSent) {
            res.status(502).json({ error: { message: 'upstream request failed', detail: err.message } });
        }
    }
}
function openAIToAnthropic(openai, model) {
    const choice = openai.choices?.[0] || {};
    return {
        id: `msg_${crypto.randomUUID().slice(0, 8)}`,
        type: 'message',
        role: 'assistant',
        content: [
            {
                type: 'text',
                text: choice.message?.content || '',
            },
        ],
        model: openai.model || model,
        stop_reason: mapFinishReason(choice.finish_reason),
        stop_sequence: null,
        usage: {
            input_tokens: openai.usage?.prompt_tokens || 0,
            output_tokens: openai.usage?.completion_tokens || 0,
        },
    };
}
function mapFinishReason(reason) {
    switch (reason) {
        case 'stop': return 'end_turn';
        case 'length': return 'max_tokens';
        case 'content_filter': return 'content_filter';
        default: return 'end_turn';
    }
}
async function anthropicStream(upstreamRes, res, model) {
    initSSE(res);
    const msgId = `msg_${crypto.randomUUID().slice(0, 8)}`;
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
    const decoder = new TextDecoder();
    let buffer = '';
    let hasContent = false;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                const parsed = parseSSELine(line);
                if (!parsed || !parsed.data || parsed.data === '[DONE]')
                    continue;
                try {
                    const chunk = JSON.parse(parsed.data);
                    const delta = chunk.choices?.[0]?.delta;
                    const finishReason = chunk.choices?.[0]?.finish_reason;
                    if (delta?.content) {
                        hasContent = true;
                        writeSSEEvent(res, 'content_block_delta', {
                            type: 'content_block_delta',
                            index: 0,
                            delta: { type: 'text_delta', text: delta.content },
                        });
                    }
                    if (finishReason) {
                        writeSSEEvent(res, 'message_delta', {
                            type: 'message_delta',
                            delta: { stop_reason: mapFinishReason(finishReason), stop_sequence: null },
                            usage: { output_tokens: chunk.usage?.completion_tokens || 0 },
                        });
                    }
                }
                catch {
                    // skip invalid JSON
                }
            }
        }
    }
    catch (err) {
        if (err.name !== 'AbortError') {
            console.error('stream error:', err.message);
        }
    }
    writeSSEEvent(res, 'message_stop', { type: 'message_stop' });
    if (!res.writableEnded) {
        res.end();
    }
}
//# sourceMappingURL=anthropic.js.map