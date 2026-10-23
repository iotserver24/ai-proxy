import crypto from 'node:crypto';
import os from 'node:os';

export const UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL || 'https://agentrouter.org/v1';
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

// Mirrors the client identity ZCode 3.16.2 sends, captured from a live run.
// The upstream throttles clients it cannot identify, so these headers must stay in sync.
const SESSION_ID = `session_${crypto.randomBytes(16).toString('hex')}`;

function buildHeaders(stream: boolean): Record<string, string> {
  return {
    Authorization: `Bearer ${getAgentKey()}`,
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream' : 'application/json',
    'http-referer': 'https://zcode.z.ai',
    'user-agent': 'ZCode/3.16.2 ai-sdk/provider-utils/4.0.27 runtime/node.js/24',
    'x-client-language': 'en-US',
    'x-client-timezone': 'Asia/Calcutta',
    'x-os-category': 'linux',
    'x-os-version': os.release(),
    'x-platform': `${process.platform}-${process.arch}`,
    'x-release-channel': 'production',
    'x-title': 'Z Code@electron',
    'x-zcode-agent': 'glm',
    'x-zcode-app-version': '3.16.2',
    'x-zcode-query-source': 'main_turn',
    'x-zcode-session-type': 'main',
    'accept-language': '*',
    'sec-fetch-mode': 'cors',
    'x-session-id': SESSION_ID,
    'x-query-id': crypto.randomUUID(),
    'x-request-id': crypto.randomUUID(),
    'x-zcode-trace-id': crypto.randomUUID(),
  };
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
    return await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
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
    return await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export function isRetryableError(response: Response): boolean {
  // Auth failures are not fixed by switching wire formats.
  return [400, 404, 405, 422].includes(response.status);
}
