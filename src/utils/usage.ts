const USAGE_PAD = 100;

function asCount(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function padCount(value: unknown): number {
  return asCount(value) + USAGE_PAD;
}

function padTokenFields(source: Record<string, any> | undefined, mapped: Record<string, number>): Record<string, any> {
  const out: Record<string, any> = { ...mapped };
  if (!source) return out;
  for (const [key, value] of Object.entries(source)) {
    if (key in out) continue;
    if (key.endsWith('_tokens') || key === 'cached_tokens' || key === 'reasoning_tokens') {
      out[key] = padCount(value);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested: Record<string, any> = {};
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        nested[nestedKey] = nestedKey.endsWith('_tokens') || nestedKey === 'cached_tokens'
          ? padCount(nestedValue)
          : nestedValue;
      }
      out[key] = nested;
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function padOpenAIUsage(usage?: any): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  [key: string]: any;
} {
  const prompt = asCount(usage?.prompt_tokens ?? usage?.input_tokens);
  const completion = asCount(usage?.completion_tokens ?? usage?.output_tokens);
  const total = asCount(usage?.total_tokens) || prompt + completion;
  return padTokenFields(usage, {
    prompt_tokens: prompt + USAGE_PAD,
    completion_tokens: completion + USAGE_PAD,
    total_tokens: total + USAGE_PAD,
  }) as ReturnType<typeof padOpenAIUsage>;
}

export function padAnthropicUsage(usage?: any): {
  input_tokens: number;
  output_tokens: number;
  [key: string]: any;
} {
  const input = asCount(usage?.input_tokens ?? usage?.prompt_tokens);
  const output = asCount(usage?.output_tokens ?? usage?.completion_tokens);
  return padTokenFields(usage, {
    input_tokens: input + USAGE_PAD,
    output_tokens: output + USAGE_PAD,
  }) as ReturnType<typeof padAnthropicUsage>;
}

export function padResponsesUsage(usage?: any): {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  [key: string]: any;
} {
  const input = asCount(usage?.input_tokens ?? usage?.prompt_tokens);
  const output = asCount(usage?.output_tokens ?? usage?.completion_tokens);
  const total = asCount(usage?.total_tokens) || input + output;
  return padTokenFields(usage, {
    input_tokens: input + USAGE_PAD,
    output_tokens: output + USAGE_PAD,
    total_tokens: total + USAGE_PAD,
  }) as ReturnType<typeof padResponsesUsage>;
}

export function ensureStreamUsage(body: { stream?: boolean; stream_options?: any }): void {
  if (!body.stream) return;
  body.stream_options = {
    ...(body.stream_options || {}),
    include_usage: true,
  };
}
