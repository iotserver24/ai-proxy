import crypto from 'crypto';

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
}

const DEFAULT_MODEL = 'gpt-5.5';

export function normalizeOpenAI(body: any): NormalizedRequest {
  return {
    model: body.model || DEFAULT_MODEL,
    stream: !!body.stream,
    messages: (body.messages || []).map(normalizeMessage),
  };
}

export function normalizeAnthropic(body: any): NormalizedRequest {
  return {
    model: body.model || DEFAULT_MODEL,
    stream: !!body.stream,
    max_tokens: body.max_tokens,
    messages: (body.messages || []).map((m: any) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : extractText(m.content),
    })),
  };
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
                arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments),
              },
            }],
          });
          break;
        case 'function_call_output':
          messages.push({
            role: 'tool',
            content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output),
            tool_call_id: item.call_id,
          });
          break;
        case 'reasoning':
          messages.push({
            role: 'assistant',
            content: extractReasoningText(item),
          });
          break;
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

  if (body.tools && body.tools.length > 0) {
    result.tools = body.tools;
  }
  if (body.max_tokens) {
    result.max_tokens = body.max_tokens;
  }

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
      if (block.type === 'input_text' || block.type === 'text') {
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
  return blocks
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n');
}

export function buildAnthropicBody(req: any): any {
  const messages: any[] = [];
  let system: string | undefined;

  if (req.instructions) {
    system = req.instructions;
  }

  const input = req.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || !item.type) continue;

      switch (item.type) {
        case 'message': {
          messages.push(responsesItemToAnthropicMessage(item));
          break;
        }
        case 'function_call': {
          const args = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments);
          messages.push({
            role: 'assistant',
            content: [{
              type: 'tool_use',
              id: item.call_id || item.id,
              name: item.name,
              input: JSON.parse(args),
            }],
          });
          break;
        }
        case 'function_call_output': {
          messages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: item.call_id,
              content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output),
            }],
          });
          break;
        }
        case 'reasoning':
          break;
        case 'item_reference':
          break;
      }
    }
  }

  const body: any = {
    model: req.model || DEFAULT_MODEL,
    max_tokens: req.max_tokens || 8192,
    stream: !!req.stream,
    messages,
  };

  if (system) {
    body.system = system;
  }
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools;
  }

  return body;
}

export function anthropicToResponses(anth: any, model: string): any {
  const now = Math.floor(Date.now() / 1000);
  const msgId = `msg_${crypto.randomUUID().slice(0, 8)}`;
  const text = extractAnthropicText(anth);

  return {
    id: `resp_${crypto.randomUUID().slice(0, 8)}`,
    object: 'response',
    created: now,
    model: anth.model || model,
    output: [
      {
        type: 'message',
        id: msgId,
        role: 'assistant',
        content: [
          { type: 'output_text', text, annotations: [] },
        ],
      },
    ],
    usage: {
      input_tokens: anth.usage?.input_tokens || 0,
      output_tokens: anth.usage?.output_tokens || 0,
      total_tokens: (anth.usage?.input_tokens || 0) + (anth.usage?.output_tokens || 0),
    },
  };
}

function extractAnthropicText(anth: any): string {
  const content = anth.content || [];
  return content
    .filter((b: any) => b.type === 'text')
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
      if (block.type === 'input_text' || block.type === 'text') {
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
