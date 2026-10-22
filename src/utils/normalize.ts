import crypto from 'crypto';
import { ensureStreamUsage, padResponsesUsage } from './usage.js';

export interface NormalizedMessage {
  role: string;
  content: any;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
}

export interface NormalizedRequest {
  model: string;
  stream: boolean;
  messages: NormalizedMessage[];
  max_tokens?: number;
  tools?: any[];
  tool_choice?: any;
  response_format?: any;
  parallel_tool_calls?: boolean;
  [key: string]: any;
}

const DEFAULT_MODEL = 'gpt-6.1-sol';

export function normalizeOpenAI(body: any): NormalizedRequest {
  const result: NormalizedRequest = {
    model: body.model || DEFAULT_MODEL,
    stream: !!body.stream,
    messages: (body.messages || []).map(normalizeMessage),
  };

  copyOptionalFields(body, result, [
    'max_tokens',
    'max_completion_tokens',
    'temperature',
    'top_p',
    'stop',
    'n',
    'stream_options',
    'tools',
    'tool_choice',
    'parallel_tool_calls',
    'response_format',
    'reasoning_effort',
    'frequency_penalty',
    'presence_penalty',
    'seed',
    'user',
    'metadata',
    'store',
    'service_tier',
  ]);

  ensureStreamUsage(result);
  return result;
}

export function normalizeAnthropic(body: any): NormalizedRequest {
  const result: NormalizedRequest = {
    model: body.model || DEFAULT_MODEL,
    stream: !!body.stream,
    max_tokens: body.max_tokens,
    messages: (body.messages || []).flatMap(normalizeAnthropicMessages),
  };

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    result.tools = anthropicToolsToOpenAI(body.tools);
  }
  if (body.tool_choice !== undefined) {
    result.tool_choice = anthropicToolChoiceToOpenAI(body.tool_choice);
  }
  if (body.system !== undefined) {
    result.messages.unshift({ role: 'system', content: body.system });
  }
  copyOptionalFields(body, result, [
    'temperature',
    'top_p',
    'stop_sequences',
    'metadata',
  ]);

  ensureStreamUsage(result);
  return result;
}

export function normalizeResponses(body: any): NormalizedRequest {
  const messages: NormalizedMessage[] = [];

  if (body.instructions) {
    messages.push({ role: 'system', content: body.instructions });
  }

  const input = body.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || !item.type) continue;

      switch (item.type) {
        case 'message':
          messages.push(responsesMessageToChat(item));
          break;
        case 'function_call':
          messages.push({
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: item.call_id || item.id,
              type: 'function',
              function: {
                name: item.name,
                arguments: stringifyJson(item.arguments),
              },
            }],
          });
          break;
        case 'function_call_output':
          messages.push({
            role: 'tool',
            content: stringifyContent(item.output),
            tool_call_id: item.call_id,
          });
          break;
        case 'reasoning': {
          const reasoning = extractReasoningText(item);
          if (reasoning) messages.push({ role: 'assistant', content: reasoning });
          break;
        }
        case 'item_reference':
          break;
      }
    }
  }

  const result: NormalizedRequest = {
    model: body.model || DEFAULT_MODEL,
    stream: !!body.stream,
    messages,
  };

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    result.tools = responsesToolsToOpenAI(body.tools);
  }
  if (body.tool_choice !== undefined) {
    result.tool_choice = responsesToolChoiceToOpenAI(body.tool_choice);
  }
  if (body.parallel_tool_calls !== undefined) {
    result.parallel_tool_calls = body.parallel_tool_calls;
  }

  const maxTokens = body.max_output_tokens ?? body.max_tokens;
  if (maxTokens !== undefined) {
    result.max_tokens = maxTokens;
  }
  copyOptionalFields(body, result, [
    'temperature',
    'top_p',
    'reasoning_effort',
    'response_format',
    'metadata',
    'service_tier',
  ]);

  ensureStreamUsage(result);
  return result;
}

function responsesMessageToChat(item: any): NormalizedMessage {
  const role = item.role || 'user';
  const content = item.content;

  if (!content) {
    return { role, content: '' };
  }

  if (typeof content === 'string') {
    return { role, content };
  }

  if (Array.isArray(content)) {
    const blocks = content.map(block => {
      if (block.type === 'input_text' || block.type === 'text' || block.type === 'output_text') {
        return { type: 'text', text: block.text };
      }
      if (block.type === 'input_image') {
        const url = block.image_url || block.source?.data || '';
        return { type: 'image_url', image_url: { url } };
      }
      return { type: 'text', text: JSON.stringify(block) };
    });
    return { role, content: blocks };
  }

  return { role, content: JSON.stringify(content) };
}

function extractReasoningText(item: any): string {
  const summaries = item.summary || [];
  return summaries
    .filter((s: any) => s.type === 'summary_text')
    .map((s: any) => s.text)
    .join('\n');
}

function extractText(blocks: any[]): string {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b: any) => b?.type === 'text')
    .map((b: any) => b.text)
    .join('\n');
}

export function buildAnthropicBody(req: any): any {
  const messages: any[] = [];
  let system: string | undefined;

  if (req.instructions) {
    system = req.instructions;
  } else if (req.system) {
    system = typeof req.system === 'string' ? req.system : extractText(req.system);
  }

  const input = req.input ?? req.messages;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item) continue;

      if (item.type === 'message') {
        messages.push(responsesItemToAnthropicMessage(item));
        continue;
      }
      if (item.type === 'function_call') {
        messages.push({
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: item.call_id || item.id,
            name: item.name,
            input: parseJsonObject(item.arguments),
          }],
        });
        continue;
      }
      if (item.type === 'function_call_output') {
        messages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: item.call_id,
            content: stringifyContent(item.output),
          }],
        });
        continue;
      }
      if (item.role && item.content !== undefined) {
        messages.push({
          role: item.role,
          content: typeof item.content === 'string' ? item.content : item.content,
        });
      }
    }
  }

  const body: any = {
    model: req.model || DEFAULT_MODEL,
    max_tokens: req.max_tokens ?? req.max_output_tokens ?? 8192,
    stream: !!req.stream,
    messages,
  };

  if (system) body.system = system;
  if (Array.isArray(req.tools) && req.tools.length > 0) {
    body.tools = responsesToolsToAnthropic(req.tools);
  }
  if (req.tool_choice !== undefined) {
    body.tool_choice = responsesToolChoiceToAnthropic(req.tool_choice);
  }
  copyOptionalFields(req, body, ['temperature', 'top_p', 'stop_sequences', 'metadata']);

  return body;
}

export function anthropicToResponses(anth: any, model: string): any {
  const now = Math.floor(Date.now() / 1000);
  const output: any[] = [];
  const text = extractAnthropicText(anth);

  if (text) {
    output.push({
      type: 'message',
      id: `msg_${crypto.randomUUID().slice(0, 8)}`,
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }

  for (const block of Array.isArray(anth.content) ? anth.content : []) {
    if (block?.type !== 'tool_use') continue;
    output.push({
      type: 'function_call',
      id: block.id || `fc_${crypto.randomUUID().slice(0, 8)}`,
      call_id: block.id || `call_${crypto.randomUUID().slice(0, 8)}`,
      name: block.name,
      arguments: stringifyJson(block.input ?? {}),
    });
  }

  return {
    id: `resp_${crypto.randomUUID().slice(0, 8)}`,
    object: 'response',
    created: now,
    model: anth.model || model,
    output,
    status: 'completed',
    usage: padResponsesUsage(anth.usage),
  };
}

function extractAnthropicText(anth: any): string {
  const content = anth.content || [];
  return content
    .filter((b: any) => b?.type === 'text')
    .map((b: any) => b.text)
    .join('');
}

function responsesItemToAnthropicMessage(item: any): any {
  const role = item.role || 'user';
  const content = item.content;

  if (!content) {
    return { role, content: '' };
  }

  if (typeof content === 'string') {
    return { role, content };
  }

  if (Array.isArray(content)) {
    const blocks = content.map(block => {
      if (block.type === 'input_text' || block.type === 'text' || block.type === 'output_text') {
        return { type: 'text', text: block.text };
      }
      if (block.type === 'input_image') {
        return imageBlockToAnthropic(block);
      }
      return { type: 'text', text: JSON.stringify(block) };
    });
    return { role, content: blocks };
  }

  return { role, content: JSON.stringify(content) };
}

function imageBlockToAnthropic(block: any): any {
  const imageUrl = block.image_url || block.source?.data || '';
  const dataUrlMatch = typeof imageUrl === 'string' ? imageUrl.match(/^data:(image\/\w+);base64,(.+)$/) : null;

  if (dataUrlMatch) {
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: dataUrlMatch[1],
        data: dataUrlMatch[2],
      },
    };
  }

  return {
    type: 'image',
    source: {
      type: 'url',
      url: imageUrl,
    },
  };
}

function normalizeMessage(m: any): NormalizedMessage {
  return {
    role: m.role,
    content: typeof m.content === 'string' ? m.content : m.content,
    tool_calls: m.tool_calls,
    tool_call_id: m.tool_call_id,
    name: m.name,
  };
}

function normalizeAnthropicMessages(m: any): NormalizedMessage[] {
  if (!Array.isArray(m?.content)) return [normalizeMessage(m)];

  const textBlocks = m.content.filter((block: any) => block?.type === 'text');
  const toolUseBlocks = m.content.filter((block: any) => block?.type === 'tool_use');
  const toolResultBlocks = m.content.filter((block: any) => block?.type === 'tool_result');
  const messages: NormalizedMessage[] = [];

  if (textBlocks.length > 0 || (toolUseBlocks.length > 0 && m.role === 'assistant')) {
    messages.push({
      role: m.role,
      content: textBlocks.length > 0 ? textBlocks.map((block: any) => block.text).join('') : null,
      ...(toolUseBlocks.length > 0 ? {
        tool_calls: toolUseBlocks.map((block: any) => ({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: stringifyJson(block.input ?? {}),
          },
        })),
      } : {}),
    });
  }

  for (const block of toolResultBlocks) {
    messages.push({
      role: 'tool',
      content: stringifyContent(block.content),
      tool_call_id: block.tool_use_id,
    });
  }

  return messages.length > 0 ? messages : [normalizeMessage(m)];
}

function copyOptionalFields(source: any, target: any, fields: string[]): void {
  for (const field of fields) {
    if (source?.[field] !== undefined) target[field] = source[field];
  }
}

function stringifyContent(value: any): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? '');
}

function stringifyJson(value: any): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? {});
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

export function responsesToolsToOpenAI(tools: any[]): any[] {
  return tools.map(tool => {
    if (tool?.type !== 'function' || tool.function) return tool;
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters || tool.input_schema || { type: 'object', properties: {} },
        ...(tool.strict === undefined ? {} : { strict: tool.strict }),
      },
    };
  });
}

function responsesToolsToAnthropic(tools: any[]): any[] {
  return tools.map(tool => {
    if (tool?.name && tool.input_schema) return tool;
    const fn = tool?.function || tool || {};
    return {
      name: fn.name,
      description: fn.description,
      input_schema: fn.parameters || fn.input_schema || { type: 'object', properties: {} },
    };
  });
}

function anthropicToolsToOpenAI(tools: any[]): any[] {
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema || { type: 'object', properties: {} },
    },
  }));
}

function responsesToolChoiceToOpenAI(choice: any): any {
  if (choice && typeof choice === 'object' && choice.type === 'function' && choice.name) {
    return { type: 'function', function: { name: choice.name } };
  }
  return choice;
}

function anthropicToolChoiceToOpenAI(choice: any): any {
  if (!choice || typeof choice !== 'object') return choice;
  if (choice.type === 'any') return 'required';
  if (choice.type === 'tool' && choice.name) {
    return { type: 'function', function: { name: choice.name } };
  }
  return choice.type || choice;
}

function responsesToolChoiceToAnthropic(choice: any): any {
  if (choice === 'required') return { type: 'any' };
  if (choice && typeof choice === 'object' && choice.type === 'function') {
    const name = choice.name || choice.function?.name;
    return name ? { type: 'tool', name } : { type: 'auto' };
  }
  return choice;
}
