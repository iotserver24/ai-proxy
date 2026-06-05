export const UPSTREAM_BASE_URL = 'https://agentrouter.org/v1';
export const UPSTREAM_CHAT_PATH = '/chat/completions';
export const UPSTREAM_MESSAGES_PATH = '/messages';
export const UPSTREAM_RESPONSES_PATH = '/responses';
const UPSTREAM_TIMEOUT_MS = 60_000;

function getAgentKey(): string {
  const key = process.env.AGENT_KEY;
  if (!key) {
    throw new Error('AGENT_KEY environment variable not set');
  }
  return key;
}

function buildHeaders(stream: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${getAgentKey()}`,
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream' : 'application/json',
    'User-Agent': 'QwenCode/0.17.1 (linux; x64)',
    'x-stainless-arch': 'x64',
    'x-stainless-lang': 'js',
    'x-stainless-os': 'Linux',
    'x-stainless-runtime': 'node',
    'x-stainless-runtime-version': 'v22.22.2',
  };
  return headers;
}

export async function callUpstream(
  path: string,
  body: unknown,
  stream: boolean,
): Promise<Response> {
  const url = `${UPSTREAM_BASE_URL}${path}`;
  const headers = buildHeaders(stream);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

export async function callUpstreamGet(path: string): Promise<Response> {
  const url = `${UPSTREAM_BASE_URL}${path}`;
  const headers = buildHeaders(false);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

export function isRetryableError(response: Response): boolean {
  const status = response.status;
  return (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 422 ||
    status === 429
  );
}
