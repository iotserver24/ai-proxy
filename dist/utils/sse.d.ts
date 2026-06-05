import type { ServerResponse } from 'http';
export declare function initSSE(res: ServerResponse): void;
export declare function writeSSE(res: ServerResponse, data: unknown): void;
export declare function writeSSEEvent(res: ServerResponse, event: string, data: unknown): void;
export declare function endSSE(res: ServerResponse, data?: unknown): void;
export declare function parseSSELine(line: string): {
    event?: string;
    data?: string;
} | null;
//# sourceMappingURL=sse.d.ts.map