'use strict';
const $ = (id) => document.getElementById(id);
const base = location.origin;

async function api(method, url, body) {
  const res = await fetch(url, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (res.status === 401 && url !== '/admin/login') showGate();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function showGate() { $('gate').hidden = false; $('locked').hidden = false; $('app').hidden = true; $('logout').hidden = true; setPill('Signed out', ''); }
function showApp() { $('gate').hidden = true; $('locked').hidden = true; $('app').hidden = false; $('logout').hidden = false; }
function setPill(text, cls) { const p = $('pill'); p.textContent = text; p.className = 'pill ' + cls; }

const fmt = (t) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'never');

// ---------- sign in ----------
async function login(token) {
  await api('POST', '/admin/login', { token });
  showApp();
  await Promise.all([loadStatus(), loadKeys()]);
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-err').textContent = '';
  try { await login($('login-token').value.trim()); $('login-token').value = ''; }
  catch (err) { $('login-err').textContent = err.message; }
});

$('logout').addEventListener('click', async () => {
  try { await api('POST', '/admin/logout', {}); } catch {}
  showGate();
});

// ---------- status ----------
async function loadStatus() {
  const dl = $('status');
  dl.replaceChildren();
  let s;
  try { s = await api('GET', '/admin/status'); } catch { return; }
  const row = (label, value, cls) => {
    const dt = document.createElement('dt'); dt.textContent = label;
    const dd = document.createElement('dd'); dd.textContent = value; if (cls) dd.className = cls;
    dl.append(dt, dd);
  };
  row('Claude CLI', s.cliFound ? `Found (${s.version || 'unknown version'})` : 'Not found. Do step 1, then restart this server.', s.cliFound ? 'ok' : 'bad');
  row('Login', s.loggedIn ? `Logged in${s.subscriptionType ? ` (${s.subscriptionType} plan)` : ''}` : 'Not logged in. Do step 2.', s.loggedIn ? 'ok' : 'bad');
  row('Default model', s.defaultModel);
  row('Network', s.loopbackOnly ? 'This computer only (127.0.0.1)' : 'Reachable from other devices. Not recommended.', s.loopbackOnly ? 'ok' : 'bad');
  row('Concurrency', `${s.maxConcurrent} request(s) at a time`);
  if (s.cliFound && s.loggedIn) setPill('Ready', 'ok');
  else setPill(s.cliFound ? 'Not logged in' : 'CLI missing', 'bad');
}
$('recheck').addEventListener('click', loadStatus);

$('test-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = $('test-out'), btn = $('test-btn');
  btn.disabled = true; out.hidden = false; out.textContent = 'Waiting for Claude…';
  try {
    const r = await api('POST', '/admin/test', { prompt: $('test-prompt').value });
    out.textContent = `${r.text}\n\n— ${r.model}, ${r.usage.input_tokens} in / ${r.usage.output_tokens} out tokens`;
  } catch (err) { out.textContent = 'Failed: ' + err.message; }
  btn.disabled = false;
});

// ---------- keys ----------
async function loadKeys() {
  let data;
  try { data = await api('GET', '/admin/keys'); } catch { return; }
  const body = $('keys');
  body.replaceChildren();
  $('no-keys').hidden = data.keys.length > 0;
  for (const k of data.keys) {
    const tr = document.createElement('tr');
    const expired = k.expiresAt && k.expiresAt < Date.now();
    const day = (t) => new Date(t).toLocaleDateString([], { dateStyle: 'medium' });
    const cells = [k.name, k.prefix + '…', day(k.createdAt), fmt(k.lastUsedAt),
      k.expiresAt ? (expired ? 'expired' : day(k.expiresAt)) : 'never', `${k.rpm}/min`, String(k.requests)];
    cells.forEach((c, i) => {
      const td = document.createElement('td');
      if (i === 1) { const code = document.createElement('code'); code.textContent = c; td.append(code); }
      else td.textContent = c;
      if (i >= 5) td.className = 'num';
      tr.append(td);
    });
    const td = document.createElement('td');
    const btn = document.createElement('button');
    btn.className = 'danger'; btn.textContent = 'Revoke';
    btn.addEventListener('click', async () => {
      if (btn.dataset.armed !== '1') { // two-click confirm, no browser dialog
        btn.dataset.armed = '1'; btn.textContent = 'Click again to revoke';
        setTimeout(() => { btn.dataset.armed = ''; btn.textContent = 'Revoke'; }, 4000);
        return;
      }
      try { await api('DELETE', '/admin/keys/' + k.id); } catch {}
      loadKeys();
    });
    td.append(btn); tr.append(td); body.append(tr);
  }
}

$('key-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('key-err').textContent = '';
  try {
    const r = await api('POST', '/admin/keys', {
      name: $('key-name').value, expiresInDays: Number($('key-exp').value), rpm: Number($('key-rpm').value),
    });
    $('new-key-value').textContent = r.secret;
    $('new-key').hidden = false;
    $('key-name').value = '';
    loadKeys();
  } catch (err) { $('key-err').textContent = err.message; }
});

async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text); } catch { return; }
  const old = btn.textContent; btn.textContent = 'Copied';
  setTimeout(() => { btn.textContent = old; }, 1500);
}
$('new-key-copy').addEventListener('click', (e) => copy($('new-key-value').textContent, e.target));

// ---------- snippets & tabs ----------
const KEY = 'sk-local-YOUR_KEY';
const snippets = {
  'snip-curl': `curl ${base}/v1/messages \\
  -H "x-api-key: ${KEY}" \\
  -H "content-type: application/json" \\
  -d '{
    "model": "sonnet",
    "max_tokens": 1024,
    "system": "You are a concise assistant.",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`,
  'snip-py': `# pip install anthropic
import os
from anthropic import Anthropic

client = Anthropic(
    base_url="${base}",
    api_key=os.environ["LOCAL_CLAUDE_KEY"],  # ${KEY}
)

msg = client.messages.create(
    model="sonnet",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)
print(msg.content[0].text)`,
  'snip-js': `// Node 18+, no packages needed
const res = await fetch("${base}/v1/messages", {
  method: "POST",
  headers: {
    "x-api-key": process.env.LOCAL_CLAUDE_KEY, // ${KEY}
    "content-type": "application/json",
  },
  body: JSON.stringify({
    model: "sonnet",
    max_tokens: 1024,
    messages: [{ role: "user", content: "Hello!" }],
  }),
});
const data = await res.json();
console.log(data.content[0].text);`,
  'snip-oai': `# pip install openai  (works with any OpenAI-compatible client)
import os
from openai import OpenAI

client = OpenAI(
    base_url="${base}/v1",
    api_key=os.environ["LOCAL_CLAUDE_KEY"],  # ${KEY}
)

resp = client.chat.completions.create(
    model="sonnet",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(resp.choices[0].message.content)`,
};
for (const [id, text] of Object.entries(snippets)) $(id).textContent = text;
document.querySelectorAll('.base').forEach((el) => { el.textContent = base; });

document.querySelectorAll('pre.code').forEach((pre) => {
  const btn = document.createElement('button');
  btn.className = 'ghost copy'; btn.textContent = 'Copy';
  btn.addEventListener('click', () => copy(pre.querySelector('code').textContent, btn));
  pre.append(btn);
});

document.querySelectorAll('.tabs').forEach((tabs) => {
  const group = tabs.dataset.tabs;
  tabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    tabs.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t === tab));
    document.querySelectorAll(`[data-pane^="${group}:"]`).forEach((p) => {
      p.hidden = p.dataset.pane !== `${group}:${tab.dataset.tab}`;
    });
  });
});

// ---------- boot ----------
(async () => {
  // One-click sign in: the terminal link carries the token in the URL fragment,
  // which browsers never send to any server. Remove it from the address bar at once.
  const m = /^#token=([\w-]+)$/.exec(location.hash);
  if (m) {
    history.replaceState(null, '', location.pathname);
    try { await login(m[1]); return; } catch (err) { showGate(); $('login-err').textContent = err.message; return; }
  }
  try {
    const s = await api('GET', '/admin/session');
    if (!s.authenticated) return showGate();
    showApp();
    await Promise.all([loadStatus(), loadKeys()]);
  } catch { showGate(); }
})();
