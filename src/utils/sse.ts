import type { ServerResponse } from 'http';

export function initSSE(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
}

export function writeSSE(res: ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function writeSSEEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function endSSE(res: ServerResponse, data?: unknown): void {
  if (data) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

export function parseSSELine(line: string): { event?: string; data?: string } | null {
  if (line.startsWith('event: ')) {
    return { event: line.slice(7) };
  }
  if (line.startsWith('data: ')) {
    return { data: line.slice(6) };
  }
  return null;
}
