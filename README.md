# LLM Subscription to API

A small, local gateway that lets **your own apps on your own computer** talk to Claude through the official [Claude Code CLI](https://claude.com/claude-code) you are already logged in to with your Claude subscription.

It gives you:

- An **Anthropic-style** endpoint (`POST /v1/messages`) and an **OpenAI-style** endpoint (`POST /v1/chat/completions`), both with streaming.
- A **dashboard** with step-by-step setup instructions, a connection check, and API key management.
- **Local API keys** you create and revoke yourself, each with its own rate limit and expiry.

No dependencies. One `node server.js`.

> **Read this first.** This is for personal, local use. It does not extract or reuse your Claude login token; it simply runs the `claude` command on your machine. Your plan's usage limits and Anthropic's terms still apply. Do not share keys, host this for other people, or build a product on it. For anything shared, commercial or customer-facing, use a real API key from the [Claude Developer Platform](https://platform.claude.com/).

## Quick start

Requirements: Node.js 18+, and a recent Claude Code CLI (2.1 or newer).

```bash
# 1. Install the Claude Code CLI (skip if `claude --version` works)
#    Windows PowerShell:
irm https://claude.ai/install.ps1 | iex
#    macOS / Linux:
curl -fsSL https://claude.ai/install.sh | bash

# 2. Log in with your subscription: run `claude`, type /login, finish in the browser, then /exit

# 3. Start the gateway
git clone https://github.com/akshaysalunkhe705/llm-subscription-to-api.git
cd llm-subscription-to-api
npm start
```

The terminal prints a dashboard link:

```
Dashboard (one-click sign in):
  http://127.0.0.1:8787/#token=...
```

Open it, follow the five steps on the page, and create a key. The key is shown **once**.

## Using the API

```bash
curl http://127.0.0.1:8787/v1/messages \
  -H "x-api-key: sk-local-YOUR_KEY" \
  -H "content-type: application/json" \
  -d '{
    "model": "sonnet",
    "max_tokens": 1024,
    "system": "You are a concise assistant.",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

Python, with the official Anthropic SDK:

```python
import os
from anthropic import Anthropic

client = Anthropic(base_url="http://127.0.0.1:8787", api_key=os.environ["LOCAL_CLAUDE_KEY"])
msg = client.messages.create(
    model="sonnet", max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)
print(msg.content[0].text)
```

Any OpenAI-compatible client: set the base URL to `http://127.0.0.1:8787/v1` and use your local key.

| Endpoint | Notes |
| --- | --- |
| `POST /v1/messages` | Anthropic Messages format. `stream: true` supported. |
| `POST /v1/chat/completions` | OpenAI Chat Completions format. `stream: true` supported. |
| `GET /v1/models` | Lists the model aliases. |
| `GET /health` | No auth. |

Send the key as `x-api-key: <key>` or `Authorization: Bearer <key>`.

**Models:** `sonnet`, `opus`, `haiku`, `fable`, or a full `claude-...` id. Anything else (for example `gpt-4o` from an OpenAI client) falls back to `DEFAULT_MODEL`.

**Limits of this approach**

- Text only. Images and tool use are rejected or ignored.
- `max_tokens`, `temperature` and other sampling settings are accepted but ignored; the CLI does not expose them.
- Multi-turn conversations are flattened into one prompt, so behaviour is close to, but not identical to, the real API.
- Each request starts a CLI process, which adds a second or two of latency.
- Reported `input_tokens` include the CLI's own small overhead.

## Security

What the gateway does:

| Protection | How |
| --- | --- |
| Not reachable from the network | Binds to `127.0.0.1`. Refuses to start on any other address unless `ALLOW_REMOTE=1`. |
| DNS-rebinding defence | Requests whose `Host` header is not `127.0.0.1` / `localhost` on the right port are rejected. |
| Keys cannot be stolen from disk | Keys are 256-bit random values. Only a SHA-256 hash is stored, compared in constant time. |
| Limited blast radius per key | Per-key requests/minute limit, optional expiry, instant revoke. |
| Brute-force lockout | 10 failed key or login attempts in 5 minutes blocks that client for the window. |
| Dashboard protected | Admin token is generated fresh on every start and printed only to your terminal. Session cookie is `HttpOnly` and `SameSite=Strict`; state-changing calls also require a same-origin `Origin` header. |
| Other websites cannot call it | No CORS headers by default. Strict Content-Security-Policy, no inline scripts, framing denied. |
| Claude cannot touch your machine | The CLI runs with all tools disabled, in safe mode, with no MCP servers, in an empty temp directory, without saving session history. |
| No command injection | The CLI is started without a shell; prompts go through stdin; the model name is checked against a strict pattern. |
| Your login stays with the CLI | The gateway never reads the CLI's credential store. `ANTHROPIC_API_KEY` and similar variables are removed from the child environment. |
| Private logs | `data/audit.log` holds time, key name, model, status and token counts only. Never prompts or replies. |
| Resource limits | 1 MB body cap, 2 concurrent requests, 5 minute timeout, CLI killed if the client disconnects. |

What you should do:

- Keep keys in environment variables. Never commit them. `data/` is git-ignored.
- Do not expose the port through a tunnel, reverse proxy or port forward.
- Give every app its own key and revoke keys you no longer use.
- Anyone with an account on this computer who can read your user files is already inside your trust boundary; this tool does not protect against that.

## Configuration

All optional, set as environment variables.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Port to listen on. |
| `HOST` | `127.0.0.1` | Address to bind. Non-loopback needs `ALLOW_REMOTE=1` and is not recommended (plain HTTP). |
| `DEFAULT_MODEL` | `sonnet` | Used when the request has no recognised model. |
| `DEFAULT_SYSTEM` | `You are a helpful assistant.` | System prompt when the request has none. |
| `MAX_CONCURRENT` | `2` | Simultaneous CLI runs. Extra requests get `429`. |
| `DEFAULT_RPM` | `30` | Requests/minute for keys created without a limit. |
| `REQUEST_TIMEOUT_MS` | `300000` | Per-request time limit. |
| `MAX_BODY_BYTES` | `1048576` | Largest accepted request body. |
| `ALLOWED_ORIGINS` | *(none)* | Comma-separated browser origins allowed to call `/v1/*`. |
| `CLAUDE_BIN` | *(auto)* | Full path to the `claude` executable if it is not on `PATH`. |
| `DATA_DIR` | `./data` | Where key hashes and the audit log live. |

## Project layout

```
server.js        HTTP server, routing, auth, rate limits, admin API
lib/config.js    Environment configuration
lib/store.js     Hashed key store and audit log
lib/claude.js    Runs the Claude Code CLI and parses its stream
public/          Dashboard (plain HTML, CSS, JS)
```

## License

MIT. Not affiliated with or endorsed by Anthropic.
