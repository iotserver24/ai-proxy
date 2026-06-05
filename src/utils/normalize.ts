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

function normalizeMessage(m: any): NormalizedMessage {
  return {
    role: m.role,
    content: typeof m.content === 'string' ? m.content : m.content,
    tool_calls: m.tool_calls,
    tool_call_id: m.tool_call_id,
    name: m.name,
  };
}
