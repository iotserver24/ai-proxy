#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-3000}"
BASE="http://localhost:$PORT"

echo "=== ai-proxy smoke tests ==="
echo "Make sure the server is running: AGENT_KEY=sk-test npx tsx src/server.ts"
echo

# Test 1: Server responds to health
echo "--- Test 1: Server running? ---"
curl -s -o /dev/null -w "%{http_code}" "$BASE/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-5.5","stream":false,"messages":[{"role":"user","content":"hi"}]}' 2>/dev/null && echo " (expect 502 or 200 - upstream unreachable but proxy responds)"

echo

# Test 2: Success with a mock upstream
# (requires a real AGENT_KEY pointing at agentrouter.org)

echo "--- Test 2: OpenAI non-stream ---"
echo "  curl -X POST $BASE/v1/chat/completions"
echo "    -H 'Content-Type: application/json'"
echo "    -d '{\"model\":\"gpt-5.5\",\"stream\":false,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}'"
echo

echo "--- Test 3: OpenAI stream ---"
echo "  curl -N $BASE/v1/chat/completions"
echo "    -H 'Content-Type: application/json'"
echo "    -d '{\"model\":\"gpt-5.5\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}'"
echo

echo "--- Test 4: Anthropic non-stream ---"
echo "  curl -X POST $BASE/v1/messages"
echo "    -H 'Content-Type: application/json'"
echo "    -d '{\"model\":\"gpt-5.5\",\"max_tokens\":256,\"stream\":false,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}'"
echo

echo "--- Test 5: Anthropic stream ---"
echo "  curl -N $BASE/v1/messages"
echo "    -H 'Content-Type: application/json'"
echo "    -d '{\"model\":\"gpt-5.5\",\"max_tokens\":256,\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}'"
echo

echo "--- To run tests against a real upstream: ---"
echo "  AGENT_KEY=your_key_here npx tsx src/server.ts"
echo "  Then run: bash test.sh"
