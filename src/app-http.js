'use strict';

const path = require('node:path');
const { URL } = require('node:url');

const { STATIC_TYPES } = require('./config');
const { countQueue } = require('./queue');
const {
  sendText,
  sendJson,
  readAsset,
  readJsonBody,
} = require('./http-utils');

module.exports = {
  async handleHttp(req, res) {
    try {
      const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'GET' && parsed.pathname === '/') return this.serveIndex(res);
      if (req.method === 'GET' && (parsed.pathname === '/styles.css' || parsed.pathname === '/app.js')) return this.serveStatic(res, parsed.pathname.slice(1));
      if (req.method === 'GET' && parsed.pathname === '/events') return this.serveEvents(req, res, parsed);
      if (parsed.pathname.startsWith('/api/')) {
        if (!this.validateToken(req, parsed)) return sendJson(res, 403, { error: 'Invalid token' });
        const body = req.method === 'POST' ? await readJsonBody(req) : {};
        return await this.handleApi(req, res, parsed.pathname, body);
      }
      sendText(res, 404, 'not found');
    } catch (err) {
      sendJson(res, 500, { error: err.message || String(err) });
    }
  },

  validateToken(req, parsed) {
    const q = parsed.searchParams.get('token');
    const h = req.headers['x-codex-limit-watch-token'];
    return q === this.token || h === this.token;
  },

  serveIndex(res) {
    sendText(res, 200, readAsset('index.html').replaceAll('__TOKEN__', this.token), 'text/html; charset=utf-8');
  },

  serveStatic(res, name) {
    sendText(res, 200, readAsset(name), STATIC_TYPES[path.extname(name)] || 'application/octet-stream');
  },

  serveEvents(req, res, parsed) {
    if (!this.validateToken(req, parsed)) return sendText(res, 403, 'invalid token');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const client = { res };
    this.clients.add(client);
    this.debug.connectedBrowserClients = this.clients.size;
    this.app.connectedClients = this.clients.size;
    this.sendSse(client, 'state', this.snapshot());
    req.on('close', () => {
      this.clients.delete(client);
      this.debug.connectedBrowserClients = this.clients.size;
      this.app.connectedClients = this.clients.size;
      this.broadcast('state', this.snapshot());
    });
  },

  async handleApi(req, res, route, body) {
    if (req.method === 'GET' && route === '/api/state') return sendJson(res, 200, this.snapshot());
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    if (route === '/api/session/select') {
      await this.selectSession(String(body.sessionId || body.threadId || ''));
      return sendJson(res, 200, { ok: true });
    }
    if (route === '/api/session/create') {
      await this.createSession();
      return sendJson(res, 200, { ok: true });
    }
    if (route === '/api/session/reload') {
      await this.loadSessions();
      return sendJson(res, 200, { ok: true });
    }
    if (route === '/api/session/cancel-change') return sendJson(res, 200, this.cancelSessionChange());
    if (route === '/api/config/model') return sendJson(res, 200, await this.setModel(body.model));
    if (route === '/api/config/effort') return sendJson(res, 200, await this.setEffort(body.effort));
    if (route === '/api/config/theme') return sendJson(res, 200, await this.setTheme(body.theme));
    if (route === '/api/queue/add') return sendJson(res, 200, await this.addPrompt(body.text || ''));
    if (route === '/api/queue/send-composer') return sendJson(res, 200, await this.sendComposerNow(body.text || ''));
    if (route === '/api/queue/schedule') return sendJson(res, 200, await this.setQueueSchedule(body.scheduledRunAt));
    if (route === '/api/queue/schedule-reset') return sendJson(res, 200, await this.resetQueueSchedule());
    if (route === '/api/queue/cancel-run') return sendJson(res, 200, await this.cancelQueueRun());
    if (route === '/api/queue/update') return sendJson(res, 200, await this.updateQueueItem(body));
    if (route === '/api/queue/remove') { await this.removeQueueItem(String(body.id)); return sendJson(res, 200, { ok: true }); }
    if (route === '/api/queue/reorder') { await this.reorderQueueItem(String(body.id), body); return sendJson(res, 200, { ok: true }); }
    if (route === '/api/queue/clear') { await this.clearPending(); return sendJson(res, 200, { ok: true }); }
    if (route === '/api/queue/clear-completed') { await this.clearCompleted(); return sendJson(res, 200, { ok: true }); }
    if (route === '/api/queue/undo') return sendJson(res, 200, await this.undoLast());
    if (route === '/api/control/cancel-send') { this.cancelPendingSend(); return sendJson(res, 200, { ok: true }); }
    if (route === '/api/control/interrupt') return sendJson(res, 200, await this.interruptCurrentTurn());
    if (route === '/api/control/pause') { this.pause(); return sendJson(res, 200, { ok: true }); }
    if (route === '/api/control/resume') { this.resume(); return sendJson(res, 200, { ok: true }); }
    if (route === '/api/control/stop') { await this.shutdown('stop requested'); return sendJson(res, 200, { ok: true }); }
    if (route === '/api/approval/respond') { await this.respondApproval(String(body.decision)); return sendJson(res, 200, { ok: true }); }
    if (route === '/api/output/clear') { this.clearOutput(); return sendJson(res, 200, { ok: true }); }
    return sendJson(res, 404, { error: 'unknown api route' });
  },

  snapshot() {
    const counts = countQueue(this.queue);
    const nextPending = this.queue.find((i) => i.status === 'pending') || null;
    return {
      app: {
        ...this.app,
        queueCounts: counts,
        nextPendingId: nextPending?.id || null,
        canInterrupt: !!(this.currentTurnId && this.app.sessionId),
        isManualSend: !!this.currentManualSend,
        canPause: !!this.app.sessionId && !this.currentManualSend && this.isQueueProcessingActive() && !['paused', 'done', 'error', 'initializing', 'selecting-session', 'approval-required'].includes(this.app.state),
        canChangeSession: this.canChangeSession(),
        canScheduleQueue: this.canScheduleQueue(),
      },
      sessions: this.sessions,
      queue: this.queue,
      output: this.output,
      rateLimits: this.rateLimits,
      approval: this.approval,
      debug: this.opts.debug ? this.debug : { connectedBrowserClients: this.debug.connectedBrowserClients },
    };
  },

  broadcastAll() { this.broadcast('state', this.snapshot()); },

  broadcast(event, data) {
    for (const client of this.clients) this.sendSse(client, event, data);
  },

  sendSse(client, event, data) {
    try {
      client.res.write(`event: ${event}\n`);
      client.res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (_) {
      this.clients.delete(client);
    }
  },

  setError(message) {
    this.app.state = 'error';
    this.app.message = message;
    this.appendOutput(`[error] ${message}`, 'error');
    this.eventLog('error', message);
    this.broadcastAll();
  },

  async shutdown(reason = 'shutdown') {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.app.state = 'shutting-down';
    this.app.message = reason;
    this.broadcastAll();
    this.eventLog('info', `shutdown ${reason}`);
    try {
      if (this.currentTurnId && this.app.sessionId) {
        await this.rpc.request('turn/interrupt', { threadId: this.app.sessionId, turnId: this.currentTurnId }, 3000).catch(() => {});
      }
    } catch (_) {}
    try { await this.saveQueue(); } catch (_) {}
    try { await this.saveState(); } catch (_) {}
    try { await this.rpc.stop(); } catch (_) {}
    for (const c of this.clients) {
      try { c.res.write('event: done\ndata: {}\n\n'); c.res.end(); } catch (_) {}
    }
    this.clients.clear();
    try { this.server && this.server.close(); } catch (_) {}
    this.releaseLock();
    setTimeout(() => process.exit(0), 100).unref();
  }
};
