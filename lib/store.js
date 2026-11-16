'use strict';
// API key store. Keys are random 256-bit secrets; only their SHA-256 hash is
// written to disk, so a leaked data/keys.json cannot be turned back into keys.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');

const FILE = path.join(cfg.DATA_DIR, 'keys.json');
const AUDIT = path.join(cfg.DATA_DIR, 'audit.log');
const AUDIT_MAX = 5 * 1024 * 1024;

fs.mkdirSync(cfg.DATA_DIR, { recursive: true, mode: 0o700 });

let keys = [];
try {
  keys = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (!Array.isArray(keys)) keys = [];
} catch { keys = []; }

let saveTimer = null;
function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(keys, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; try { save(); } catch {} }, 2000);
  saveTimer.unref();
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();

function publicView(k) {
  return {
    id: k.id, name: k.name, prefix: k.prefix, createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt, expiresAt: k.expiresAt, rpm: k.rpm, requests: k.requests || 0,
  };
}

function createKey({ name, expiresInDays, rpm }) {
  const secret = 'sk-local-' + crypto.randomBytes(32).toString('base64url');
  const rec = {
    id: crypto.randomBytes(8).toString('hex'),
    name: String(name || 'unnamed').slice(0, 60),
    prefix: secret.slice(0, 14),
    hash: sha256(secret).toString('hex'),
    createdAt: Date.now(),
    lastUsedAt: null,
    expiresAt: expiresInDays > 0 ? Date.now() + expiresInDays * 86400000 : null,
    rpm: Math.min(Math.max(Math.floor(rpm) || cfg.DEFAULT_RPM, 1), 600),
    requests: 0,
  };
  keys.push(rec);
  save();
  return { secret, key: publicView(rec) };
}

function listKeys() { return keys.map(publicView); }

function revokeKey(id) {
  const before = keys.length;
  keys = keys.filter((k) => k.id !== id);
  if (keys.length !== before) { save(); return true; }
  return false;
}

// Constant-time lookup: every stored hash is compared, no early exit.
function verifyKey(secret) {
  if (typeof secret !== 'string' || secret.length < 20 || secret.length > 200) return null;
  const h = sha256(secret);
  let found = null;
  for (const k of keys) {
    const stored = Buffer.from(k.hash, 'hex');
    if (stored.length === h.length && crypto.timingSafeEqual(stored, h)) found = k;
  }
  if (!found) return null;
  if (found.expiresAt && found.expiresAt < Date.now()) return null;
  return found;
}

function touchKey(k) {
  k.lastUsedAt = Date.now();
  k.requests = (k.requests || 0) + 1;
  saveSoon();
}

// Audit log holds request metadata only - never prompts, replies or secrets.
function audit(entry) {
  try {
    try {
      if (fs.statSync(AUDIT).size > AUDIT_MAX) fs.renameSync(AUDIT, AUDIT + '.1');
    } catch {}
    fs.appendFileSync(AUDIT, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
  } catch {}
}

module.exports = { createKey, listKeys, revokeKey, verifyKey, touchKey, audit };
