'use strict';

const fs = require('node:fs');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { VERSION } = require('../shared/config');
const { sleep, nowIso, safeJson, maskSecrets } = require('../shared/utils');

class JsonRpcClient {
  constructor(app, dependencies = {}) {
    this.app = app;
    this.spawnProcess = dependencies.spawn || spawn;
    this.sleep = dependencies.sleep || sleep;
    this.killProcess = dependencies.kill || process.kill.bind(process);
    this.proc = null;
    this.rl = null;
    this.nextId = 1;
    this.pending = new Map();
    this.started = false;
    this.exited = false;
  }
  start() {
    const opts = this.app.opts;
    this.exited = false;
    return new Promise((resolve, reject) => {
      let settled = false;
      let startupTimer = null;
      const settle = (callback, value) => {
        if (settled) return false;
        settled = true;
        if (startupTimer) clearTimeout(startupTimer);
        callback(value);
        return true;
      };
      const child = this.spawnProcess(opts.codexBin, ['app-server'], {
        cwd: opts.projectDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
        detached: process.platform !== 'win32',
      });
      this.proc = child;
      const onSpawn = () => {
        this.started = true;
        settle(resolve);
      };
      const onError = (err) => {
        if (!settle(reject, err)) this.app.setError(`app-server error: ${err.message}`);
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
        const started = this.started;
        this.exited = true;
        this.started = false;
        this.app.debug.appServerStatus = `exited code=${code} signal=${signal || ''}`;
        for (const [id, p] of this.pending) {
          if (p.timeout) clearTimeout(p.timeout);
          p.reject(new Error(`app-server exited before response to request ${id}`));
        }
        this.pending.clear();
        const error = new Error(`codex app-server exited: code=${code}, signal=${signal || 'none'}`);
        error.code = 'APP_SERVER_EXITED';
        if (!started && settle(reject, error)) return;
        if (!this.app.shuttingDown) {
          Promise.resolve(this.app.handleRpcExit(error)).catch((err) => {
            this.app.setError(err.message || String(err));
          });
        }
      });
      startupTimer = setTimeout(() => {
        settle(reject, new Error('codex app-server did not emit spawn event in time'));
      }, 3000);
      startupTimer.unref();
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
    if (!this.proc || this.exited || !this.proc.stdin.writable) return Promise.reject(new Error('app-server is not running'));
    const id = this.nextId++;
    const msg = { method, id };
    if (params !== undefined) msg.params = params;
    return new Promise((resolve, reject) => {
      let timeout = null;
      const rejectPending = (error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        if (pending.timeout) clearTimeout(pending.timeout);
        pending.reject(error);
      };
      if (timeoutMs > 0) {
        timeout = setTimeout(() => {
          rejectPending(new Error(`JSON-RPC request timed out: ${method}`));
        }, timeoutMs);
        timeout.unref();
      }
      this.pending.set(id, { method, resolve, reject, timeout });
      try {
        this.write(msg, (error) => {
          if (error) rejectPending(error);
        });
      } catch (error) {
        rejectPending(error);
      }
    });
  }
  notify(method, params = {}) {
    this.write({ method, params });
  }
  respond(id, result, isError = false) {
    if (isError) this.write({ id, error: result });
    else this.write({ id, result });
  }
  write(msg, callback = undefined) {
    if (!this.proc || this.exited || !this.proc.stdin || !this.proc.stdin.writable) {
      throw new Error('app-server is not running');
    }
    this.logJsonRpc('client', msg);
    this.proc.stdin.write(JSON.stringify(msg) + '\n', callback);
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
      Promise.resolve().then(() => this.app.handleServerRequest(msg)).catch((err) => {
        this.respond(msg.id, { code: -32603, message: err.message || String(err) }, true);
      });
      return;
    }
    if (msg.method) {
      Promise.resolve().then(() => this.app.handleNotification(msg.method, msg.params || {})).catch((err) => {
        this.app.debugLog('notification handler failed', `${msg.method}: ${err.message || String(err)}`);
        if (typeof this.app.setError === 'function') {
          this.app.setError(`Notification handler failed (${msg.method}): ${err.message || String(err)}`);
        }
      });
    }
  }
  async stop() {
    if (!this.proc || this.exited) return;
    try { this.rl && this.rl.close(); } catch (_) {}
    try { this.proc.stdin.end(); } catch (_) {}
    await this.sleep(100);
    if (!this.exited) {
      try {
        if (process.platform !== 'win32' && this.proc.pid) this.killProcess(-this.proc.pid, 'SIGTERM');
        else this.proc.kill('SIGTERM');
      } catch (_) {}
    }
    await this.sleep(500);
    if (!this.exited) {
      try {
        if (process.platform !== 'win32' && this.proc.pid) this.killProcess(-this.proc.pid, 'SIGKILL');
        else this.proc.kill('SIGKILL');
      } catch (_) {}
    }
  }
}

module.exports = { JsonRpcClient };
