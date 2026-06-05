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
export declare function normalizeOpenAI(body: any): NormalizedRequest;
export declare function normalizeAnthropic(body: any): NormalizedRequest;
//# sourceMappingURL=normalize.d.ts.map