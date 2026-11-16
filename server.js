'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./lib/config');
const store = require('./lib/store');
const claude = require('./lib/claude');

if (!cfg.IS_LOOPBACK && !cfg.ALLOW_REMOTE) {
  console.error(`Refusing to listen on ${cfg.HOST}: that exposes your Claude subscription to the network.\n` +
    'Keep HOST=127.0.0.1, or set ALLOW_REMOTE=1 if you really understand the risk.');
  process.exit(1);
}

// ---------- admin session (dashboard) ----------
// A fresh admin token is generated on every start and only printed to the
// terminal, so only someone who can see this terminal can manage keys.
const ADMIN_TOKEN = crypto.randomBytes(32).toString('base64url');
const sessions = new Map(); // sid -> expiry

const safeEqual = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

function cookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
function hasSession(req) {
  const sid = cookie(req, 'sid');
  const exp = sid && sessions.get(sid);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(sid); return false; }
  return true;
}

// ---------- abuse limits ----------
const fails = new Map(); // ip -> [timestamps]
function blocked(ip) {
  const list = (fails.get(ip) || []).filter((t) => Date.now() - t < cfg.AUTH_FAIL_WINDOW_MS);
  fails.set(ip, list);
  return list.length >= cfg.AUTH_FAIL_LIMIT;
}
function recordFail(ip) { fails.set(ip, [...(fails.get(ip) || []), Date.now()]); }

const hits = new Map(); // keyId -> [timestamps]
function overRate(key) {
  const list = (hits.get(key.id) || []).filter((t) => Date.now() - t < 60000);
  if (list.length >= key.rpm) { hits.set(key.id, list); return true; }
  list.push(Date.now()); hits.set(key.id, list);
  return false;
}

// ---------- http helpers ----------
const ALLOWED_HOSTS = new Set([`127.0.0.1:${cfg.PORT}`, `localhost:${cfg.PORT}`, `[::1]:${cfg.PORT}`,
  `${cfg.HOST}:${cfg.PORT}`]);

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function send(res, status, body, extra = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
    'Cache-Control': 'no-store', ...SEC_HEADERS, ...extra,
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) {
      const e = new Error('Content-Type must be application/json'); e.status = 415; return reject(e);
    }
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > cfg.MAX_BODY_BYTES) {
        const e = new Error('Request body too large'); e.status = 413;
        reject(e); req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error();
        resolve(j);
      } catch { const e = new Error('Body is not valid JSON'); e.status = 400; reject(e); }
    });
    req.on('error', reject);
  });
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

// ---------- request normalisation ----------
function textOf(content, where) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => {
      if (b && b.type === 'text' && typeof b.text === 'string') return b.text;
      const e = new Error(`${where}: only text content is supported (got "${b && b.type}")`);
      e.status = 400; throw e;
    }).join('\n');
  }
  const e = new Error(`${where}: content must be a string or an array of text blocks`);
  e.status = 400; throw e;
}

function normalise(body, flavour) {
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 200) {
    const e = new Error('messages must be a non-empty array'); e.status = 400; throw e;
  }
  const systems = [];
  if (flavour === 'anthropic' && body.system != null) systems.push(textOf(body.system, 'system'));
  const messages = [];
  body.messages.forEach((m, i) => {
    const role = m && m.role;
    const text = textOf(m && m.content, `messages[${i}]`);
    if (flavour === 'openai' && (role === 'system' || role === 'developer')) systems.push(text);
    else if (role === 'user' || role === 'assistant') messages.push({ role, text });
    else { const e = new Error(`messages[${i}]: unsupported role "${role}"`); e.status = 400; throw e; }
  });
  if (!messages.length || messages[messages.length - 1].role !== 'user') {
    const e = new Error('The last message must have role "user"'); e.status = 400; throw e;
  }
  return { messages, system: systems.join('\n\n'), model: body.model, stream: body.stream === true };
}

const errBody = (flavour, status, message) => {
  const type = status === 401 ? 'authentication_error' : status === 429 ? 'rate_limit_error'
    : status >= 500 ? 'api_error' : 'invalid_request_error';
  return flavour === 'openai'
    ? { error: { message, type, code: null } }
    : { type: 'error', error: { type, message } };
};

// ---------- /v1 completion handler ----------
async function handleCompletion(req, res, flavour, key) {
  const started = Date.now();
  let status = 200, usage = null, model = null;
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  try {
    const input = normalise(await readJson(req), flavour);
    if (claude.busy()) {
      const e = new Error(`Gateway is busy (max ${cfg.MAX_CONCURRENT} concurrent requests). Retry shortly.`);
      e.status = 429; throw e;
    }
    const id = (flavour === 'openai' ? 'chatcmpl-' : 'msg_') + crypto.randomBytes(12).toString('hex');
    const created = Math.floor(Date.now() / 1000);
    let onEvent = null;

    if (input.stream) {
      const open = () => {
        if (res.headersSent) return;
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...SEC_HEADERS });
      };
      if (flavour === 'anthropic') {
        onEvent = (ev) => { open(); res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`); };
      } else {
        const chunk = (delta, finish, m) => res.write('data: ' + JSON.stringify({
          id, object: 'chat.completion.chunk', created, model: m,
          choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n');
        let m = claude.pickModel(input.model);
        onEvent = (ev) => {
          if (ev.type === 'message_start') { m = (ev.message && ev.message.model) || m; open(); chunk({ role: 'assistant', content: '' }, null, m); }
          else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') chunk({ content: ev.delta.text }, null, m);
        };
      }
    }

    const out = await claude.run({ ...input, signal: ac.signal, onEvent });
    usage = out.usage; model = out.model;

    if (input.stream) {
      if (flavour === 'openai') {
        res.write('data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: {}, finish_reason: out.stopReason === 'max_tokens' ? 'length' : 'stop' }] }) + '\n\n');
        res.write('data: [DONE]\n\n');
      }
      res.end();
    } else if (flavour === 'anthropic') {
      send(res, 200, { id, type: 'message', role: 'assistant', model,
        content: [{ type: 'text', text: out.text }],
        stop_reason: out.stopReason, stop_sequence: null, usage });
    } else {
      send(res, 200, { id, object: 'chat.completion', created, model,
        choices: [{ index: 0, message: { role: 'assistant', content: out.text },
          finish_reason: out.stopReason === 'max_tokens' ? 'length' : 'stop' }],
        usage: { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens,
          total_tokens: usage.input_tokens + usage.output_tokens } });
    }
  } catch (e) {
    status = e.status || 500;
    const message = e.status ? e.message : 'Internal gateway error';
    if (!e.status) console.error(e);
    if (status !== 499) {
      if (res.headersSent) {
        res.write(`event: error\ndata: ${JSON.stringify(errBody(flavour, status, message))}\n\n`);
        res.end();
      } else send(res, status, errBody(flavour, status, message));
    }
  } finally {
    store.audit({ key: key.id, name: key.name, route: req.url.split('?')[0], model, status,
      ms: Date.now() - started, in: usage && usage.input_tokens, out: usage && usage.output_tokens });
  }
}

// ---------- admin API ----------
async function handleAdmin(req, res, pathname, ip) {
  const origin = req.headers.origin;
  if (req.method !== 'GET') {
    // CSRF defence: state-changing calls must come from our own page.
    if (!origin || !ALLOWED_HOSTS.has(origin.replace(/^http:\/\//, ''))) return send(res, 403, { error: 'Bad origin' });
  }
  if (pathname === '/admin/login' && req.method === 'POST') {
    const body = await readJson(req);
    if (!safeEqual(body.token || '', ADMIN_TOKEN)) {
      recordFail(ip);
      return send(res, 401, { error: 'Wrong admin token. Copy it from the terminal running the server.' });
    }
    const sid = crypto.randomBytes(32).toString('base64url');
    sessions.set(sid, Date.now() + cfg.SESSION_TTL_MS);
    return send(res, 200, { ok: true }, {
      'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${cfg.SESSION_TTL_MS / 1000}`,
    });
  }
  if (pathname === '/admin/session' && req.method === 'GET') return send(res, 200, { authenticated: hasSession(req) });
  if (!hasSession(req)) return send(res, 401, { error: 'Not signed in' });

  if (pathname === '/admin/logout' && req.method === 'POST') {
    sessions.delete(cookie(req, 'sid'));
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0' });
  }
  if (pathname === '/admin/status' && req.method === 'GET') {
    return send(res, 200, { ...(await claude.status()), defaultModel: cfg.DEFAULT_MODEL,
      maxConcurrent: cfg.MAX_CONCURRENT, loopbackOnly: cfg.IS_LOOPBACK });
  }
  if (pathname === '/admin/keys' && req.method === 'GET') return send(res, 200, { keys: store.listKeys() });
  if (pathname === '/admin/keys' && req.method === 'POST') {
    const body = await readJson(req);
    if (store.listKeys().length >= 50) return send(res, 400, { error: 'Key limit reached (50). Revoke unused keys.' });
    const name = String(body.name || '').trim();
    if (!name) return send(res, 400, { error: 'Give the key a name' });
    return send(res, 201, store.createKey({ name, expiresInDays: Number(body.expiresInDays) || 0, rpm: Number(body.rpm) }));
  }
  const del = pathname.match(/^\/admin\/keys\/([a-f0-9]{16})$/);
  if (del && req.method === 'DELETE') {
    return store.revokeKey(del[1]) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'No such key' });
  }
  if (pathname === '/admin/test' && req.method === 'POST') {
    const body = await readJson(req);
    const prompt = String(body.prompt || '').slice(0, 2000).trim();
    if (!prompt) return send(res, 400, { error: 'Enter a prompt' });
    if (claude.busy()) return send(res, 429, { error: 'Gateway is busy, try again shortly' });
    try {
      const out = await claude.run({ messages: [{ role: 'user', text: prompt }], system: '', model: cfg.DEFAULT_MODEL });
      return send(res, 200, { text: out.text, model: out.model, usage: out.usage });
    } catch (e) { return send(res, e.status || 500, { error: e.message }); }
  }
  send(res, 404, { error: 'Not found' });
}

// ---------- router ----------
const server = http.createServer(async (req, res) => {
  const ip = req.socket.remoteAddress || '';
  try {
    // DNS-rebinding defence: only answer when addressed by a known host name.
    if (!ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase())) return send(res, 421, 'Unknown host');
    const pathname = new URL(req.url, 'http://x').pathname;

    if (req.method === 'GET' && STATIC[pathname]) {
      const [file, type] = STATIC[pathname];
      return send(res, 200, fs.readFileSync(path.join(cfg.PUBLIC_DIR, file), 'utf8'), { 'Content-Type': type });
    }
    if (pathname === '/health') return send(res, 200, { ok: true });
    if (blocked(ip)) return send(res, 429, { error: 'Too many failed attempts. Wait a few minutes.' }, { 'Retry-After': '300' });
    if (pathname.startsWith('/admin/')) return await handleAdmin(req, res, pathname, ip);

    if (pathname.startsWith('/v1/')) {
      const flavour = pathname === '/v1/chat/completions' ? 'openai' : 'anthropic';
      const origin = req.headers.origin;
      const cors = origin && cfg.ALLOWED_ORIGINS.includes(origin)
        ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : null;
      if (req.method === 'OPTIONS') {
        return cors ? send(res, 204, '', { ...cors,
          'Access-Control-Allow-Headers': 'authorization, x-api-key, content-type, anthropic-version',
          'Access-Control-Allow-Methods': 'POST, GET', 'Access-Control-Max-Age': '600' })
          : send(res, 403, errBody(flavour, 403, 'Origin not allowed'));
      }
      if (cors) for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);

      const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
      const key = store.verifyKey(req.headers['x-api-key'] || (bearer && bearer[1]) || '');
      if (!key) {
        recordFail(ip);
        return send(res, 401, errBody(flavour, 401, 'Invalid, expired or missing API key'));
      }
      if (overRate(key)) {
        return send(res, 429, errBody(flavour, 429, `Rate limit: ${key.rpm} requests/minute for this key`), { 'Retry-After': '30' });
      }
      store.touchKey(key);

      if (pathname === '/v1/models' && req.method === 'GET') {
        const data = ['fable', 'opus', 'sonnet', 'haiku'].map((id) => ({ id, object: 'model', type: 'model', display_name: id, owned_by: 'anthropic' }));
        return send(res, 200, { object: 'list', data });
      }
      if ((pathname === '/v1/messages' || pathname === '/v1/chat/completions') && req.method === 'POST') {
        return await handleCompletion(req, res, flavour, key);
      }
      return send(res, 404, errBody(flavour, 404, 'Unknown endpoint'));
    }
    send(res, 404, 'Not found');
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Internal error' });
    else res.end();
  }
});

server.headersTimeout = 15000;
server.requestTimeout = 60000; // time allowed to upload the request body
server.listen(cfg.PORT, cfg.HOST, () => {
  const base = `http://${cfg.IS_LOOPBACK ? '127.0.0.1' : cfg.HOST}:${cfg.PORT}`;
  console.log(`\n  LLM Subscription to API is running\n`);
  console.log(`  Dashboard (one-click sign in):\n    ${base}/#token=${ADMIN_TOKEN}\n`);
  console.log(`  API base URL:  ${base}`);
  console.log('  The admin token above changes on every restart. Do not share it.\n');
  if (!cfg.IS_LOOPBACK) console.warn('  WARNING: listening on a non-loopback address over plain HTTP.\n');
});
