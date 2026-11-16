'use strict';
const path = require('path');

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

const HOST = process.env.HOST || '127.0.0.1';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

module.exports = {
  HOST,
  PORT: num(process.env.PORT, 8787),
  IS_LOOPBACK: LOOPBACK.has(HOST),
  // Binding to anything other than loopback must be an explicit decision.
  ALLOW_REMOTE: process.env.ALLOW_REMOTE === '1',
  DATA_DIR: path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data')),
  PUBLIC_DIR: path.join(__dirname, '..', 'public'),
  CLAUDE_BIN: process.env.CLAUDE_BIN || '',
  DEFAULT_MODEL: process.env.DEFAULT_MODEL || 'sonnet',
  DEFAULT_SYSTEM: process.env.DEFAULT_SYSTEM || 'You are a helpful assistant.',
  MAX_BODY_BYTES: num(process.env.MAX_BODY_BYTES, 1024 * 1024),
  MAX_CONCURRENT: num(process.env.MAX_CONCURRENT, 2),
  REQUEST_TIMEOUT_MS: num(process.env.REQUEST_TIMEOUT_MS, 5 * 60 * 1000),
  DEFAULT_RPM: num(process.env.DEFAULT_RPM, 30),
  SESSION_TTL_MS: 12 * 60 * 60 * 1000,
  AUTH_FAIL_LIMIT: 10,
  AUTH_FAIL_WINDOW_MS: 5 * 60 * 1000,
  // Comma separated list of browser origins allowed to call /v1/* (default: none).
  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean),
};
