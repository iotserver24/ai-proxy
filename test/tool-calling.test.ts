import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  openAIToResponses,
  openaiStreamToResponses,
} from '../src/adapters/responses.js';
import { anthropicToResponses } from '../src/utils/normalize.js';
import {
  normalizeAnthropic,
  normalizeOpenAI,
  normalizeResponses,
} from '../src/utils/normalize.js';
import { pipeOpenAIStream } from '../src/adapters/openai.js';
import { padOpenAIUsage } from '../src/utils/usage.js';

const weatherTool = {
  type: 'function',
  name: 'get_weather',
  description: 'Get the weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false,
  },
};

function makeStreamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function makeResponseSink(): any {
  const chunks: string[] = [];
  return {
    chunks,
    headersSent: false,
    writableEnded: false,
    writeHead() {
      this.headersSent = true;
    },
    write(chunk: string) {
      chunks.push(String(chunk));
      return true;
    },
    end() {
      this.writableEnded = true;
    },
    body() {
      return chunks.join('');
    },
  };
}

function parseEvents(body: string): Array<{ event: string; data: any }> {
  return body
    .split('\n\n')
    .filter(frame => frame.includes('event: ') && frame.includes('data: '))
    .map(frame => {
      const event = frame.match(/^event: (.+)$/m)?.[1] || '';
      const data = frame.match(/^data: (.+)$/m)?.[1] || '{}';
      return { event, data: JSON.parse(data) };
    });
}

test('OpenAI normalization preserves tools and tool control fields', () => {
  const normalized = normalizeOpenAI({
    model: 'gpt-5.6-sol',
    messages: [{ role: 'user', content: 'Use the weather tool.' }],
    tools: [{ type: 'function', function: { name: 'get_weather' } }],
    tool_choice: 'required',
    parallel_tool_calls: false,
    max_tokens: 64,
  });

  assert.deepEqual(normalized.tools, [{ type: 'function', function: { name: 'get_weather' } }]);
  assert.equal(normalized.tool_choice, 'required');
  assert.equal(normalized.parallel_tool_calls, false);
  assert.equal(normalized.max_tokens, 64);
});

test('Responses normalization converts native function tools to Chat Completions tools', () => {
  const normalized = normalizeResponses({
    model: 'gpt-5.6-sol',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Use the tool.' }] }],
    tools: [weatherTool],
    tool_choice: { type: 'function', name: 'get_weather' },
    max_output_tokens: 64,
  });

  assert.equal(normalized.tools?.[0]?.type, 'function');
  assert.equal(normalized.tools?.[0]?.function?.name, 'get_weather');
  assert.deepEqual(normalized.tools?.[0]?.function?.parameters, weatherTool.parameters);
  assert.deepEqual(normalized.tool_choice, {
    type: 'function',
    function: { name: 'get_weather' },
  });
  assert.equal(normalized.max_tokens, 64);
});

test('Anthropic normalization converts tool schemas and tool results', () => {
  const normalized = normalizeAnthropic({
    model: 'claude-opus-4-8',
    max_tokens: 64,
    tools: [{
      name: 'get_weather',
      description: weatherTool.description,
      input_schema: weatherTool.parameters,
    }],
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'Sunny' }] },
    ],
  });

  assert.equal(normalized.tools?.[0]?.function?.name, 'get_weather');
  assert.deepEqual(normalized.messages[0].tool_calls?.[0], {
    id: 'call_1',
    type: 'function',
    function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
  });
  assert.deepEqual(normalized.messages[1], {
    role: 'tool',
    content: 'Sunny',
    tool_call_id: 'call_1',
  });
});

test('non-streaming Chat Completions tool calls become Responses function_call items', () => {
  const response = openAIToResponses({
    model: 'gpt-5.6-sol',
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
        }],
      },
      finish_reason: 'tool_calls',
    }],
  }, 'gpt-5.6-sol');

  assert.deepEqual(response.output, [{
    type: 'function_call',
    id: 'call_1',
    call_id: 'call_1',
    name: 'get_weather',
    arguments: '{"city":"Paris"}',
  }]);
  assert.equal(response.status, 'completed');
});

test('Anthropic tool_use blocks become Responses function_call items', () => {
  const response = anthropicToResponses({
    model: 'claude-opus-4-8',
    content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } }],
    usage: { input_tokens: 10, output_tokens: 4 },
  }, 'claude-opus-4-8');

  assert.deepEqual(response.output, [{
    type: 'function_call',
    id: 'call_1',
    call_id: 'call_1',
    name: 'get_weather',
    arguments: '{"city":"Paris"}',
  }]);
  assert.deepEqual(response.usage, { input_tokens: 110, output_tokens: 104, total_tokens: 114 });
});

test('streamed Chat Completions tool calls emit Responses argument events', async () => {
  const upstream = makeStreamResponse([
    'data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\":\\""}}]}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"type":"function","function":{"arguments":"Paris\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ]);
  const sink = makeResponseSink();

  await openaiStreamToResponses(upstream, sink, 'gpt-5.6-sol');

  const events = parseEvents(sink.body());
  const names = events.map(event => event.event);
  assert.ok(names.includes('response.function_call_arguments.delta'));
  assert.ok(names.includes('response.function_call_arguments.done'));
  assert.ok(names.includes('response.completed'));

  const completed = events.find(event => event.event === 'response.completed')?.data.response;
  assert.equal(completed.output[0].type, 'function_call');
  assert.equal(completed.output[0].name, 'get_weather');
  assert.equal(completed.output[0].arguments, '{"city":"Paris"}');
  assert.equal(completed.usage.prompt_tokens ?? completed.usage.input_tokens, 100);
  assert.equal(completed.usage.total_tokens, 100);
});

test('pads listed usage by 100', () => {
  const padded = padOpenAIUsage({
    prompt_tokens: 19,
    completion_tokens: 316,
    total_tokens: 335,
    prompt_tokens_details: { cached_tokens: 0 },
    neurons: 116.55,
  });
  assert.equal(padded.prompt_tokens, 119);
  assert.equal(padded.completion_tokens, 416);
  assert.equal(padded.total_tokens, 435);
  assert.equal(padded.prompt_tokens_details.cached_tokens, 100);
  assert.equal(padded.neurons, 116.55);
});

test('OpenAI stream holds finish until usage and pads counts', async () => {
  const upstream = makeStreamResponse([
    'data: {"id":"logfare-1","created":1,"model":"kimi-k2.7-code","object":"chat.completion.chunk","choices":[{"delta":{"content":"hi"},"index":0}]}\n\n',
    'data: {"id":"logfare-1","created":1,"model":"kimi-k2.7-code","object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n',
    'data: {"id":"logfare-1","object":"chat.completion.chunk","created":1,"model":"kimi-k2.7-code","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":0,"completion_tokens":1,"total_tokens":1}}\n\n',
    'data: {"id":"logfare-1","object":"chat.completion.chunk","created":1,"model":"kimi-k2.7-code","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":19,"completion_tokens":316,"total_tokens":335,"prompt_tokens_details":{"cached_tokens":0},"neurons":116.55}}\n\n',
    'data: [DONE]\n\n',
  ]);
  const sink = makeResponseSink();
  await pipeOpenAIStream(upstream, sink);

  const payloads = sink.body().split('\n\n').map((block: string) => {
    const line = block.split('\n').find((entry: string) => entry.startsWith('data: '));
    return line?.slice(6);
  }).filter(Boolean);

  assert.equal(payloads[0]?.startsWith('{'), true);
  const first = JSON.parse(payloads[0]);
  assert.equal(first.choices[0].delta.content, 'hi');
  assert.equal(first.usage, undefined);

  const finish = payloads.filter((p: string) => p !== '[DONE]').map((p: string) => JSON.parse(p)).find((p: any) => p.choices?.[0]?.finish_reason);
  assert.ok(finish?.usage);
  assert.equal(finish.usage.prompt_tokens, 119);
  assert.equal(finish.usage.completion_tokens, 416);
  assert.equal(finish.usage.total_tokens, 435);
  assert.equal(payloads.at(-1), '[DONE]');
});

test('streaming OpenAI requests include usage on the stream', () => {
  const normalized = normalizeOpenAI({ model: 'gpt-5.5', stream: true, messages: [] });
  assert.equal(normalized.stream_options.include_usage, true);
});
