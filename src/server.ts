import express from 'express';
import type { Request, Response as ExpressResponse } from 'express';
import { handleOpenAI } from './adapters/openai.js';
import { handleAnthropic } from './adapters/anthropic.js';
import { handleResponses } from './adapters/responses.js';
import { callUpstreamGet } from './upstream.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(express.json({ limit: '10mb' }));

app.post('/v1/chat/completions', handleOpenAI);
app.post('/v1/messages', handleAnthropic);
app.post('/v1/responses', handleResponses);

app.get('/v1/models', async (_req: Request, res: ExpressResponse) => {
  try {
    const upstreamRes = await callUpstreamGet('/models');
    if (upstreamRes.ok) {
      const data = await upstreamRes.json();
      res.json(data);
      return;
    }
  } catch {
    // fall through to static list
  }

  res.json({
    object: 'list',
    data: [
      {
        id: 'gpt-5.5',
        object: 'model',
        created: 1700000000,
        owned_by: 'agentrouter',
      },
      {
        id: 'gpt-5.4',
        object: 'model',
        created: 1690000000,
        owned_by: 'agentrouter',
      },
    ],
  });
});

app.listen(PORT, () => {
  console.log(`ai-proxy listening on port ${PORT}`);
});
