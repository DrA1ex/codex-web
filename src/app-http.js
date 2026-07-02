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

function authErrorPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Authorization error</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    background: #071018;
    color: #e8eef7;
    font: 16px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .auth-backdrop {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    background: #071018;
    padding: 24px;
  }
  .auth-modal {
    width: min(520px, 100%);
    border: 1px solid #263547;
    border-radius: 10px;
    background: #111a26;
    box-shadow: 0 24px 80px rgba(0, 0, 0, .45);
    padding: 28px;
  }
  h1 { margin: 0 0 10px; font-size: 22px; }
  p { margin: 0; color: #aab6c6; }
</style>
</head>
<body>
  <div class="auth-backdrop" role="alertdialog" aria-modal="true" aria-labelledby="authTitle">
    <section class="auth-modal">
      <h1 id="authTitle">Authorization error</h1>
      <p>Missing or invalid access token. Open Codex Web using the URL printed by the running server.</p>
    </section>
  </div>
</body>
</html>`;
}

module.exports = {
  async handleHttp(req, res) {
    try {
      const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'GET' && parsed.pathname === '/') return this.serveIndex(req, res, parsed);
      if (req.method === 'GET' && (parsed.pathname === '/styles.css' || parsed.pathname === '/app.js')) return this.serveStatic(req, res, parsed, parsed.pathname.slice(1));
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

  serveIndex(req, res, parsed) {
    if (!this.validateToken(req, parsed)) return sendText(res, 403, authErrorPage(), 'text/html; charset=utf-8');
    sendText(res, 200, readAsset('index.html').replaceAll('__TOKEN__', this.token), 'text/html; charset=utf-8');
  },

  serveStatic(req, res, parsed, name) {
    if (!this.validateToken(req, parsed)) return sendText(res, 403, 'Invalid token');
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
    const manualPromptActive = !!(this.currentManualSend && (this.currentItemId || this.currentTurnId));
    const canPauseProcessing = !this.currentManualSend && this.isQueueProcessingActive() && !['paused', 'done', 'error', 'initializing', 'selecting-session', 'approval-required'].includes(this.app.state);
    const canPauseManualContinuation = manualPromptActive && this.manualSendContinueQueue && this.app.state !== 'approval-required';
    const canResumePaused = this.app.state === 'paused';
    const canResumeManualContinuation = manualPromptActive && !!nextPending && !this.manualSendContinueQueue && this.app.state !== 'approval-required';
    return {
      app: {
        ...this.app,
        queueCounts: counts,
        nextPendingId: nextPending?.id || null,
        canInterrupt: !!(this.currentTurnId && this.app.sessionId),
        isManualSend: !!this.currentManualSend,
        manualSendContinueQueue: !!this.manualSendContinueQueue,
        canPause: !!this.app.sessionId && (canPauseProcessing || canPauseManualContinuation),
        canResume: !!this.app.sessionId && (canResumePaused || canResumeManualContinuation),
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
