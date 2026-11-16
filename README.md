# LLM Subscription to API

### Already paying for Claude? Turn that plan into a local API for your own projects, with no per-token bill.

No extra account. No billing setup. No runaway charges. Five minutes from `git clone` to your first request.

A small, local gateway that lets **your own apps on your own computer** talk to Claude through the official [Claude Code CLI](https://claude.com/claude-code) you are already logged in to with your Claude subscription.

It gives you:

- An **Anthropic-style** endpoint (`POST /v1/messages`) and an **OpenAI-style** endpoint (`POST /v1/chat/completions`), both with streaming.
- A **dashboard** with step-by-step setup instructions, a connection check, and API key management.
- **Local API keys** you create and revoke yourself, each with its own rate limit and expiry.

No dependencies. One `node server.js`.

> **Read this first.** This is for personal, local use. It does not extract or reuse your Claude login token; it simply runs the `claude` command on your machine. Your plan's usage limits and Anthropic's terms still apply. Do not share keys, host this for other people, or build a product on it. For anything shared, commercial or customer-facing, use a real API key from the [Claude Developer Platform](https://platform.claude.com/).

## Is this right for you? Gateway vs. the Claude API

The main benefit is cost: requests draw on the Claude plan you already pay for instead of being billed per token. In most other ways the real Claude API is better.

**Where this gateway wins**

- **No per-token bill.** Usage counts against your subscription's limits, so a hobby project or experiment costs nothing beyond the plan.
- **No surprise charges.** When you hit the plan limit, requests fail until it resets; there is no bill that can run away.
- **Nothing to sign up for.** No Developer Platform account or billing setup; if the CLI is logged in, you can start.
- **Two API styles at once.** The same local key works with both Anthropic-style and OpenAI-style clients.
- **Local key controls.** You create, limit, expire and revoke keys yourself in the dashboard.

**Where the real Claude API wins**

| | This gateway | Claude API |
| --- | --- | --- |
| Allowed use | Personal, on your own computer | Products, teams, customers |
| Features | Text only | Images, tool use, files, structured output and the rest |
| Controls | `max_tokens` and `temperature` ignored | Full control |
| Speed | A few seconds of CLI startup on every call | No CLI startup |
| Volume | 2 requests at a time, shared with your own Claude usage | Many requests in parallel, with higher limits |
| Where it runs | Only the machine you are logged in on | Any server |
| Reliability | Depends on the CLI staying compatible | A stable, supported interface |

Heavy use through the gateway eats into the same limits you rely on for Claude Code and the Claude apps, so a busy script can leave you rate-limited in your normal work.

**Rule of thumb:** use this for personal tools, prototypes and learning on your own machine. For anything other people will use, anything deployed to a server, or anything needing images or tools, use a [Claude API key](https://platform.claude.com/).

## Quick start

Everyone sets this up on their own computer with their own paid Claude plan. It takes about five minutes.

**1. Install Node.js 18 or newer** from [nodejs.org](https://nodejs.org). Skip this if `node --version` works.

**2. Install the Claude Code CLI** (version 2.1 or newer). Skip this if `claude --version` works.

```bash
# Windows PowerShell
irm https://claude.ai/install.ps1 | iex

# macOS / Linux
curl -fsSL https://claude.ai/install.sh | bash
```

**3. Log in with your Claude subscription.**

1. Run `claude` in a terminal.
2. Type `/login` and choose the Claude subscription option.
3. Finish the sign-in in your browser.
4. Type `/exit`.

That is all the gateway needs. You do **not** need a setup token, an API key, or to copy anything from the CLI: the CLI keeps your login on this computer and the gateway simply runs `claude`. (See [Headless machines](#headless-machines) if you cannot open a browser.)

**4. Download and start the gateway.** There is no `npm install` step.

```bash
git clone https://github.com/akshaysalunkhe705/llm-subscription-to-api.git
cd llm-subscription-to-api
npm start
```

**5. Open the dashboard link** printed in the terminal:

```
Dashboard (one-click sign in):
  http://127.0.0.1:8787/#token=...
```

**6. Follow the steps on the dashboard.** Check that step 3 shows the CLI as found and logged in, send the test prompt, then create a key. The key is shown **once**, so copy it straight away.

**7. Use the key in your app** with base URL `http://127.0.0.1:8787`. Examples are below and on the dashboard.

### Headless machines

On a machine with no browser (a server over SSH, a container), the `/login` step cannot complete. Instead, run `claude setup-token` on a computer that does have a browser, then start the gateway on the headless machine with the token it prints:

```bash
CLAUDE_CODE_OAUTH_TOKEN=<token from setup-token> npm start
```

The gateway passes this variable through to the CLI unchanged. Treat the token like a password. This route is optional and has had less testing than the normal `/login`.

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
