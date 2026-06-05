# ai-proxy Usage Guide

## Base URL

```
https://new-api.xibe.app
```

No API key needed on the client side — the proxy injects `AGENT_KEY` automatically.

---

## Endpoints

| Endpoint | Format | Description |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI | Chat completions |
| `POST /v1/messages` | Anthropic | Claude-style messages |
| `POST /v1/responses` | OpenAI Responses | Agentic API |
| `GET /v1/models` | OpenAI | List available models |

---

## Claude Code

```bash
export ANTHROPIC_BASE_URL=https://new-api.xibe.app
claude "your prompt"
```

Or add to `~/.claude/claude.json`:

```json
{
  "apiBaseUrl": "https://new-api.xibe.app"
}
```

---

## Zed IDE

Add to `~/.config/zed/settings.json`:

```json
{
  "assistant": {
    "version": "2",
    "provider": {
      "name": "openai",
      "model": "gpt-5.5",
      "uri": "https://new-api.xibe.app/v1/chat/completions"
    }
  }
}
```

---

## OpenCode

Set env var:

```bash
export OPENAI_BASE_URL=https://new-api.xibe.app/v1
opencode
```

Or in `opencode.json`:

```json
{
  "customApiBaseUrl": "https://new-api.xibe.app/v1",
  "model": "gpt-5.5"
}
```

---

## Continue.dev

Edit `~/.continue/config.json`:

```json
{
  "models": [
    {
      "title": "ai-proxy",
      "provider": "openai",
      "model": "gpt-5.5",
      "apiBase": "https://new-api.xibe.app/v1"
    }
  ],
  "tabAutocompleteModel": {
    "title": "ai-proxy-tab",
    "provider": "openai",
    "model": "gpt-5.5",
    "apiBase": "https://new-api.xibe.app/v1"
  }
}
```

---

## Cursor

Settings → Models → Add custom model:

- **Name:** `gpt-5.5`
- **Provider:** OpenAI
- **API Endpoint:** `https://new-api.xibe.app/v1/chat/completions`

---

## Codex CLI

Add to `~/.codex/config.toml`:

```toml
[model_providers.proxy]
name = "Proxy"
base_url = "https://new-api.xibe.app/v1"
wire_api = "responses"

[profiles.proxy]
model_provider = "proxy"
model = "gpt-5.5"
```

Run:

```bash
codex --profile proxy "your prompt"
```

---

## Raw curl

```bash
# OpenAI format
curl -N https://new-api.xibe.app/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-5.5","stream":true,"messages":[{"role":"user","content":"hi"}]}'

# Anthropic format
curl -N https://new-api.xibe.app/v1/messages \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-5.5","max_tokens":256,"stream":true,"messages":[{"role":"user","content":"hi"}]}'

# Responses API format
curl https://new-api.xibe.app/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-5.5","input":"hi","stream":false}'
```

---

## Available Models

```
GET https://new-api.xibe.app/v1/models
```

Returns: `gpt-5.5`, `gpt-5.4`, `deepseek-v4-flash`, `deepseek-v4-pro`, `glm-5.1`, `claude-opus-4-6/7/8`, `claude-sonnet-4-5/6`.

Each model includes `supported_endpoint_types` — use the correct endpoint format for your model.
