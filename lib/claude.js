'use strict';
// Runs the official Claude Code CLI in headless mode. This module never reads,
// copies or forwards the CLI's login credentials - it only starts the CLI the
// same way you would from a terminal, and reads what it prints.
const { spawn, execFile, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const cfg = require('./config');

// Empty working directory so the CLI cannot pick up project files or settings.
const SANDBOX = path.join(os.tmpdir(), 'llm-subscription-to-api-sandbox');
fs.mkdirSync(SANDBOX, { recursive: true });

const MODEL_RE = /^(fable|opus|sonnet|haiku|claude-[a-z0-9][a-z0-9.\-]{0,60})$/i;
const MAX_SYSTEM_ARG = 8000; // keep the command line well under OS limits

let resolved = null;
function resolveBin() {
  if (resolved) return resolved;
  let candidates = [];
  if (cfg.CLAUDE_BIN) {
    candidates = [cfg.CLAUDE_BIN];
  } else {
    try {
      const finder = process.platform === 'win32' ? 'where' : 'which';
      candidates = execFileSync(finder, ['claude'], { encoding: 'utf8', timeout: 5000 })
        .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    } catch { candidates = []; }
  }
  if (process.platform !== 'win32') {
    if (candidates[0]) resolved = { cmd: candidates[0], pre: [] };
    return resolved;
  }
  const exe = candidates.find((c) => /\.exe$/i.test(c));
  if (exe) return (resolved = { cmd: exe, pre: [] });
  // npm install on Windows gives a .cmd shim. We never spawn through a shell,
  // so run the underlying script with node directly.
  for (const c of candidates) {
    const js = path.join(path.dirname(c), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (fs.existsSync(js)) return (resolved = { cmd: process.execPath, pre: [js] });
  }
  return null;
}

function childEnv() {
  const env = { ...process.env };
  // Force the CLI onto its own stored subscription login, and avoid inheriting
  // state from a parent Claude Code session.
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
    'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) delete env[k];
  return env;
}

function pickModel(requested) {
  return typeof requested === 'string' && MODEL_RE.test(requested) ? requested : cfg.DEFAULT_MODEL;
}

// messages: [{role:'user'|'assistant', text}]
function buildPrompt(messages) {
  if (messages.length === 1) return messages[0].text;
  const lines = messages.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'Human'}: ${m.text}`);
  return 'Below is the conversation so far. Write the next Assistant reply to the final Human ' +
    'message. Output only that reply, with no "Assistant:" prefix.\n\n' + lines.join('\n\n');
}

let active = 0;
const busy = () => active >= cfg.MAX_CONCURRENT;

/**
 * Run one completion. onEvent receives raw Anthropic streaming events.
 * Resolves { text, usage, stopReason, model } or rejects with Error (err.status set).
 */
function run({ messages, system, model, signal, onEvent }) {
  return new Promise((resolve, reject) => {
    const bin = resolveBin();
    if (!bin) {
      const e = new Error('Claude Code CLI not found. Install it and run `claude` once to log in.');
      e.status = 503; return reject(e);
    }
    let prompt = buildPrompt(messages);
    let sys = (system || '').trim() || cfg.DEFAULT_SYSTEM;
    if (sys.length > MAX_SYSTEM_ARG) {
      prompt = `<system_instructions>\n${sys}\n</system_instructions>\n\n${prompt}`;
      sys = cfg.DEFAULT_SYSTEM;
    }
    const useModel = pickModel(model);
    const args = [...bin.pre, '-p',
      '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--no-session-persistence', // nothing is written to the CLI's history
      '--safe-mode',              // no hooks, plugins, skills, CLAUDE.md, MCP
      '--strict-mcp-config',
      '--tools', '',              // model cannot run commands or touch files
      '--permission-prompts', 'none',
      '--model', useModel,
      '--system-prompt', sys];

    active++;
    // shell:false + argv array: request data can never be interpreted as a command.
    const child = spawn(bin.cmd, args, {
      cwd: SANDBOX, env: childEnv(), shell: false, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let text = '', usage = null, stopReason = 'end_turn', realModel = useModel;
    let result = null, stderr = '', done = false;

    const finish = (err, val) => {
      if (done) return;
      done = true;
      active--;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (err) { try { child.kill(); } catch {} reject(err); } else resolve(val);
    };
    const onAbort = () => { const e = new Error('Client disconnected'); e.status = 499; finish(e); };
    const timer = setTimeout(() => {
      const e = new Error('Timed out waiting for Claude'); e.status = 504; finish(e);
    }, cfg.REQUEST_TIMEOUT_MS);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort);
    }

    child.on('error', (err) => { const e = new Error('Could not start Claude CLI: ' + err.code); e.status = 503; finish(e); });
    child.stderr.on('data', (d) => { if (stderr.length < 2000) stderr += d; });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);

    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.type === 'stream_event' && msg.event) {
        const ev = msg.event;
        if (ev.type === 'message_start' && ev.message && ev.message.model) realModel = ev.message.model;
        if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') text += ev.delta.text;
        if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
        if (onEvent) { try { onEvent(ev); } catch {} }
      } else if (msg.type === 'result') {
        result = msg;
      }
    });

    child.on('close', (code) => {
      if (result && !result.is_error) {
        const u = result.usage || {};
        usage = {
          input_tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
          output_tokens: u.output_tokens || 0,
        };
        return finish(null, { text: text || String(result.result || ''), usage, stopReason, model: realModel });
      }
      const detail = (result && String(result.result || '')) || stderr.trim() || `CLI exited with code ${code}`;
      const e = new Error(detail.slice(0, 400));
      e.status = /limit|quota|overloaded/i.test(detail) ? 429
        : /log ?in|auth|credential|unauthori/i.test(detail) ? 503 : 502;
      finish(e);
    });
  });
}

function exec(args) {
  return new Promise((resolve) => {
    const bin = resolveBin();
    if (!bin) return resolve(null);
    execFile(bin.cmd, [...bin.pre, ...args],
      { cwd: SANDBOX, env: childEnv(), timeout: 15000, windowsHide: true },
      (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

let statusCache = null, statusAt = 0;
async function status() {
  if (statusCache && Date.now() - statusAt < 10000) return statusCache;
  const out = { cliFound: !!resolveBin(), version: null, loggedIn: false, authMethod: null, subscriptionType: null };
  if (out.cliFound) {
    const [v, a] = await Promise.all([exec(['--version']), exec(['auth', 'status'])]);
    if (v) out.version = v.trim().slice(0, 60);
    try {
      const j = JSON.parse(a);
      // Deliberately drop email / organisation fields - the UI does not need them.
      out.loggedIn = !!j.loggedIn;
      out.authMethod = j.authMethod || null;
      out.subscriptionType = j.subscriptionType || null;
    } catch {}
  }
  statusCache = out; statusAt = Date.now();
  return out;
}

module.exports = { run, status, busy, pickModel };
