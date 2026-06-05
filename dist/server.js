import express from 'express';
import { handleOpenAI } from './adapters/openai.js';
import { handleAnthropic } from './adapters/anthropic.js';
const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
app.use(express.json());
app.post('/v1/chat/completions', handleOpenAI);
app.post('/v1/messages', handleAnthropic);
app.listen(PORT, () => {
    console.log(`ai-proxy listening on port ${PORT}`);
});
//# sourceMappingURL=server.js.map