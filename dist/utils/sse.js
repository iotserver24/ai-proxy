export function initSSE(res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
    });
}
export function writeSSE(res, data) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}
export function writeSSEEvent(res, event, data) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
export function endSSE(res, data) {
    if (data) {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
}
export function parseSSELine(line) {
    if (line.startsWith('event: ')) {
        return { event: line.slice(7) };
    }
    if (line.startsWith('data: ')) {
        return { data: line.slice(6) };
    }
    return null;
}
//# sourceMappingURL=sse.js.map