// Records every request a client (Codex, ZCode, etc.) sends, then answers with a valid stub.
// Nothing is forwarded. Usage: PORT=8787 node capture-proxy.mjs
import { createServer } from 'node:http';
import { mkdirSync, appendFileSync } from 'node:fs';

const PORT = Number(process.env.PORT || 8787);
const DIR = process.env.CAPTURE_DIR || 'captures';
const LOG = `${DIR}/capture.jsonl`;
mkdirSync(DIR, { recursive: true });

const model = (body) => body?.model || process.env.CAPTURE_MODEL || 'gpt-6.1-sol';
const id = (prefix) => `${prefix}_${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;

function safeJson(buf) {
  try { return JSON.parse(buf.toString('utf8')); } catch { return null; }
}

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  for (const [name, data] of events) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

function respond(res, path, body) {
  if (path.includes('/responses')) return respondResponses(res, body);
  if (path.includes('/chat/completions')) return respondChat(res, body);
  if (path.includes('/messages')) return respondMessages(res, body);
  res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
}

function respondResponses(res, body) {
  const m = model(body);
  const rid = id('resp');
  const mid = id('msg');
  const message = { id: mid, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'ok', annotations: [] }] };
  const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
  if (!body?.stream) {
    return res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ id: rid, object: 'response', created_at: Date.now() / 1000 | 0, status: 'completed', model: m, output: [message], usage }));
  }
  const base = { id: rid, object: 'response', created_at: Date.now() / 1000 | 0, model: m, status: 'in_progress', output: [] };
  sse(res, [
    ['response.created', { type: 'response.created', sequence_number: 0, response: base }],
    ['response.output_item.added', { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { id: mid, type: 'message', status: 'in_progress', role: 'assistant', content: [] } }],
    ['response.content_part.added', { type: 'response.content_part.added', sequence_number: 2, item_id: mid, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }],
    ['response.output_text.delta', { type: 'response.output_text.delta', sequence_number: 3, item_id: mid, output_index: 0, content_index: 0, delta: 'ok' }],
    ['response.output_text.done', { type: 'response.output_text.done', sequence_number: 4, item_id: mid, output_index: 0, content_index: 0, text: 'ok' }],
    ['response.content_part.done', { type: 'response.content_part.done', sequence_number: 5, item_id: mid, output_index: 0, content_index: 0, part: { type: 'output_text', text: 'ok', annotations: [] } }],
    ['response.output_item.done', { type: 'response.output_item.done', sequence_number: 6, output_index: 0, item: message }],
    ['response.completed', { type: 'response.completed', sequence_number: 7, response: { ...base, status: 'completed', output: [message], usage } }],
  ]);
}

function respondChat(res, body) {
  const m = model(body);
  const cid = id('chatcmpl');
  const chunk = (delta, finish) => ({ id: cid, object: 'chat.completion.chunk', created: Date.now() / 1000 | 0, model: m, choices: [{ index: 0, delta, finish_reason: finish }] });
  if (!body?.stream) {
    return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      id: cid, object: 'chat.completion', created: Date.now() / 1000 | 0, model: m,
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  }
  sse(res, [
    ['message', chunk({ role: 'assistant', content: '' }, null)],
    ['message', chunk({ content: 'ok' }, null)],
    ['message', { ...chunk({}, 'stop'), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }],
  ]);
  res.write('data: [DONE]\n\n');
}

function respondMessages(res, body) {
  const m = model(body);
  const mid = id('msg');
  const usage = { input_tokens: 1, output_tokens: 1 };
  if (!body?.stream) {
    return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      id: mid, type: 'message', role: 'assistant', model: m,
      content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage,
    }));
  }
  sse(res, [
    ['message_start', { type: 'message_start', message: { id: mid, type: 'message', role: 'assistant', model: m, content: [], stop_reason: null, usage } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

let seq = 0;

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const n = ++seq;
    const body = safeJson(raw);
    appendFileSync(LOG, JSON.stringify({
      seq: n,
      at: new Date().toISOString(),
      from: req.socket.remoteAddress,
      method: req.method,
      url: req.url,
      httpVersion: req.httpVersion,
      headers: req.headers,
      rawHeaders: req.rawHeaders,
      body,
      bodyRaw: raw.toString('utf8'),
    }) + '\n');

    console.log(`\n── #${n} ${req.method} ${req.url} (${raw.length} bytes)`);
    for (let i = 0; i < req.rawHeaders.length; i += 2) console.log(`   ${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    if (raw.length) console.log(`   BODY: ${raw.toString('utf8').slice(0, 500)}`);

    respond(res, req.url, body);
  });
}).listen(PORT, () => console.log(`capture proxy on http://localhost:${PORT} → ${LOG}`));
