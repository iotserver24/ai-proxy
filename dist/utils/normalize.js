const DEFAULT_MODEL = 'gpt-5.5';
export function normalizeOpenAI(body) {
    return {
        model: body.model || DEFAULT_MODEL,
        stream: !!body.stream,
        messages: (body.messages || []).map((m) => ({
            role: m.role,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        })),
    };
}
export function normalizeAnthropic(body) {
    return {
        model: body.model || DEFAULT_MODEL,
        stream: !!body.stream,
        max_tokens: body.max_tokens,
        messages: (body.messages || []).map((m) => ({
            role: m.role,
            content: typeof m.content === 'string' ? m.content : extractText(m.content),
        })),
    };
}
function extractText(blocks) {
    return blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
}
//# sourceMappingURL=normalize.js.map