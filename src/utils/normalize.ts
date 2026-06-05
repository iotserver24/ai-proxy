export interface NormalizedMessage {
  role: string;
  content: string;
}

export interface NormalizedRequest {
  model: string;
  stream: boolean;
  messages: NormalizedMessage[];
  max_tokens?: number;
}

const DEFAULT_MODEL = 'gpt-5.5';

export function normalizeOpenAI(body: any): NormalizedRequest {
  return {
    model: body.model || DEFAULT_MODEL,
    stream: !!body.stream,
    messages: (body.messages || []).map((m: any) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    })),
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
      if (item.role && item.content) {
        messages.push({
          role: item.role,
          content: typeof item.content === 'string' ? item.content : JSON.stringify(item.content),
        });
      }
    }
  }

  return {
    model: body.model || DEFAULT_MODEL,
    stream: !!body.stream,
    messages,
  };
}

function extractText(blocks: any[]): string {
  return blocks
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n');
}
