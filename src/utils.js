'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

function nowIso() { return new Date().toISOString(); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function randomId(bytes = 4) { return crypto.randomBytes(bytes).toString('hex'); }
function sha256(input) { return crypto.createHash('sha256').update(input).digest('hex'); }
function homeExpand(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}
function isLocalHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}
function toBool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'off'].includes(s)) return false;
  return fallback;
}
function safeJson(value) {
  try { return JSON.stringify(value); } catch (_) { return JSON.stringify(String(value)); }
}
function truncate(s, n = 120) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function lineCount(text) {
  if (!text) return 0;
  return String(text).split(/\r?\n/).length;
}
function previewOf(text) {
  const line = String(text || '').split(/\r?\n/).find((l) => l.trim());
  return truncate(line || '', 160);
}
function normalizeProjectDir(raw) {
  const resolved = path.resolve(homeExpand(raw || process.cwd()));
  if (!fs.existsSync(resolved)) {
    throw new Error(`Project dir does not exist: ${resolved}`);
  }
  return fs.realpathSync(resolved);
}
function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
function stripTrailingSep(p) {
  return path.resolve(p).replace(/[\\/]+$/, '');
}
function pathRelation(projectDir, cwd) {
  if (!cwd) return 99;
  let a, b;
  try {
    a = stripTrailingSep(fs.existsSync(projectDir) ? fs.realpathSync(projectDir) : projectDir);
    b = stripTrailingSep(fs.existsSync(cwd) ? fs.realpathSync(cwd) : cwd);
  } catch (_) {
    a = stripTrailingSep(projectDir);
    b = stripTrailingSep(cwd);
  }
  if (a === b) return 0;
  const relAB = path.relative(a, b);
  const relBA = path.relative(b, a);
  if (relAB && !relAB.startsWith('..') && !path.isAbsolute(relAB)) return 1;
  if (relBA && !relBA.startsWith('..') && !path.isAbsolute(relBA)) return 2;
  return 10;
}
function asArray(x) {
  if (!x) return [];
  return Array.isArray(x) ? x : [x];
}

function maskSecrets(value) {
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (/token|secret|password|authorization|api[-_]?key/i.test(k)) out[k] = '[masked]';
    else out[k] = maskSecrets(v);
  }
  return out;
}

function friendlyStartError(err, codexBin) {
  if (err && err.code === 'ENOENT') {
    return new Error(`Cannot start codex app-server.\nCommand: ${codexBin} app-server\nReason: codex binary was not found in PATH.\n\nFix:\nInstall Codex CLI or pass --codex-bin /path/to/codex.`);
  }
  return new Error(`Cannot start codex app-server.\nCommand: ${codexBin} app-server\nReason: ${err.message || String(err)}`);
}
function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}
function shortId(id) {
  if (!id) return '';
  const s = String(id);
  return s.length <= 12 ? s : s.slice(0, 6) + '…' + s.slice(-4);
}

module.exports = {
  nowIso,
  sleep,
  randomId,
  sha256,
  homeExpand,
  isLocalHost,
  toBool,
  safeJson,
  truncate,
  lineCount,
  previewOf,
  normalizeProjectDir,
  ensureDirSync,
  stripTrailingSep,
  pathRelation,
  asArray,
  maskSecrets,
  friendlyStartError,
  isPidAlive,
  shortId,
};
