'use strict';

const fs = require('node:fs');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { VERSION } = require('../shared/config');
const { sleep, nowIso, safeJson, maskSecrets } = require('../shared/utils');

class JsonRpcClient {
  constructor(app) {
    this.app = app;
    this.proc = null;
    this.rl = null;
    this.nextId = 1;
    this.pending = new Map();
    this.started = false;
    this.exited = false;
  }
  start() {
    const opts = this.app.opts;
    return new Promise((resolve, reject) => {
      let settled = false;
      const child = spawn(opts.codexBin, ['app-server'], {
        cwd: opts.projectDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
        detached: process.platform !== 'win32',
      });
      this.proc = child;
      const onSpawn = () => {
        this.started = true;
        if (!settled) { settled = true; resolve(); }
      };
      const onError = (err) => {
        if (!settled) { settled = true; reject(err); }
        else this.app.setError(`app-server error: ${err.message}`);
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
      child.stderr.on('data', (buf) => {
        const text = buf.toString('utf8');
        this.app.debugLog('app-server stderr', text.trim());
        if (this.app.opts.debug) this.app.appendOutput('[stderr] ' + text.trimEnd(), 'stderr');
      });
      this.rl = readline.createInterface({ input: child.stdout });
      this.rl.on('line', (line) => this.handleLine(line));
      child.on('exit', (code, signal) => {
        this.exited = true;
        this.app.debug.appServerStatus = `exited code=${code} signal=${signal || ''}`;
        for (const [id, p] of this.pending) {
          p.reject(new Error(`app-server exited before response to request ${id}`));
        }
        this.pending.clear();
        if (!this.app.shuttingDown) {
          this.app.setError(`codex app-server exited: code=${code}, signal=${signal || 'none'}`);
        }
      });
      setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('codex app-server did not emit spawn event in time'));
        }
      }, 3000).unref();
    });
  }
  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'codex_limit_watch_web', title: 'Codex Limit Watch Web', version: VERSION },
      capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: false },
    });
    this.notify('initialized', {});
  }
  request(method, params = undefined, timeoutMs = 0) {
    if (!this.proc || !this.proc.stdin.writable) return Promise.reject(new Error('app-server is not running'));
    const id = this.nextId++;
    const msg = { method, id };
    if (params !== undefined) msg.params = params;
    this.write(msg);
    return new Promise((resolve, reject) => {
      let timeout = null;
      if (timeoutMs > 0) {
        timeout = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`JSON-RPC request timed out: ${method}`));
        }, timeoutMs);
        timeout.unref();
      }
      this.pending.set(id, { method, resolve, reject, timeout });
    });
  }
  notify(method, params = {}) {
    this.write({ method, params });
  }
  respond(id, result, isError = false) {
    if (isError) this.write({ id, error: result });
    else this.write({ id, result });
  }
  write(msg) {
    this.logJsonRpc('client', msg);
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }
  logJsonRpc(direction, msg) {
    if (!this.app.jsonRpcLogPath) return;
    const masked = maskSecrets(msg);
    fs.appendFile(this.app.jsonRpcLogPath, `${nowIso()} ${direction} ${safeJson(masked)}\n`, () => {});
  }
  handleLine(line) {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); }
    catch (e) {
      this.app.debugLog('jsonrpc parse error', line.slice(0, 500));
      return;
    }
    this.logJsonRpc('server', msg);
    if (Object.prototype.hasOwnProperty.call(msg, 'id') && (Object.prototype.hasOwnProperty.call(msg, 'result') || Object.prototype.hasOwnProperty.call(msg, 'error'))) {
      const pending = this.pending.get(msg.id);
      if (!pending) {
        this.app.debugLog('orphan rpc response', safeJson(msg));
        return;
      }
      this.pending.delete(msg.id);
      if (pending.timeout) clearTimeout(pending.timeout);
      if (msg.error) {
        const err = new Error(msg.error.message || `JSON-RPC error for ${pending.method}`);
        err.code = msg.error.code;
        err.data = msg.error.data;
        this.app.debug.lastJsonRpcError = msg.error;
        pending.reject(err);
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (Object.prototype.hasOwnProperty.call(msg, 'id') && msg.method) {
      this.app.handleServerRequest(msg).catch((err) => {
        this.respond(msg.id, { code: -32603, message: err.message || String(err) }, true);
      });
      return;
    }
    if (msg.method) this.app.handleNotification(msg.method, msg.params || {});
  }
  async stop() {
    if (!this.proc || this.exited) return;
    try { this.rl && this.rl.close(); } catch (_) {}
    try { this.proc.stdin.end(); } catch (_) {}
    await sleep(100);
    if (!this.exited) {
      try {
        if (process.platform !== 'win32' && this.proc.pid) process.kill(-this.proc.pid, 'SIGTERM');
        else this.proc.kill('SIGTERM');
      } catch (_) {}
    }
    await sleep(500);
    if (!this.exited) {
      try {
        if (process.platform !== 'win32' && this.proc.pid) process.kill(-this.proc.pid, 'SIGKILL');
        else this.proc.kill('SIGKILL');
      } catch (_) {}
    }
  }
}

module.exports = { JsonRpcClient };
