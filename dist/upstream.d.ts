export declare const UPSTREAM_BASE_URL = "https://agentrouter.org/v1";
export declare const UPSTREAM_CHAT_PATH = "/chat/completions";
export declare const UPSTREAM_MESSAGES_PATH = "/messages";
export declare function callUpstream(path: string, body: unknown, stream: boolean): Promise<Response>;
export declare function isRetryableError(response: Response): boolean;
//# sourceMappingURL=upstream.d.ts.map