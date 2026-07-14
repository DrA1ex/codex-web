'use strict';

const {URL} = require('node:url');

const {countQueue, isPendingLikeStatus} = require('../../queue');
const {
  NON_PAUSABLE_STATES,
} = require('../states');
const {
  sendText,
  sendJson,
  readAsset,
  readJsonBody,
  sendBinary,
  readBinaryAsset,
} = require('../../http/utils');
const {renderAuthErrorPage} = require('../../http/auth-page');
const {
  rawPathname,
  staticAssetName
} = require('../../http/static-assets');
const {resolveApiRoute} = require('../../http/api-routes');
const path = require('node:path');
const {TEXT_TYPES, BINARY_TYPES} = require('../../shared/config');

const MAX_SSE_BUFFER_BYTES = 1024 * 1024;

function closeSseClient(ctx, client) {
  if (!client || client.closed) return;
  client.closed = true;
  ctx.clients.delete(client);
  try { client.res.end(); } catch (_) {}
  ctx.syncClientCount();
}

function flushSseClient(ctx, client) {
  if (!client || client.closed) return;
  client.blocked = false;
  while (client.queue.length) {
    const chunk = client.queue.shift();
    client.queuedBytes -= Buffer.byteLength(chunk);
    try {
      if (client.res.write(chunk) === false) {
        client.blocked = true;
        client.res.once('drain', () => flushSseClient(ctx, client));
        return;
      }
    } catch (_) {
      closeSseClient(ctx, client);
      return;
    }
  }
}

module.exports = {
  async handleHttp(req, res) {
    try {
      const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

      if (req.method === 'GET' && parsed.pathname === '/') {
        return await this.serveIndex(req, res, parsed);
      }

      if (req.method === 'GET') {
        const assetName = staticAssetName(rawPathname(req.url));
        if (assetName) return await this.serveStatic(req, res, parsed, assetName);
      }

      if (req.method === 'GET' && parsed.pathname === '/events') {
        return this.serveEvents(req, res, parsed);
      }

      if (parsed.pathname.startsWith('/api/')) {
        if (!this.validateToken(req, parsed)) {
          return sendJson(res, 403, {error: 'Invalid token'});
        }

        const body = req.method === 'POST' ? await readJsonBody(req) : {};
        return await this.handleApi(req, res, parsed.pathname, body);
      }

      sendText(res, 404, 'not found');
    } catch (err) {
      sendJson(res, 500, {error: err.message || String(err)});
    }
  },

  validateToken(req, parsed) {
    const queryToken = parsed.searchParams.get('token');
    const headerToken = req.headers['x-codex-limit-watch-token'];

    return queryToken === this.token || headerToken === this.token;
  },

  async serveIndex(req, res, parsed) {
    if (!this.validateToken(req, parsed)) {
      return sendText(res, 403, renderAuthErrorPage(), 'text/html; charset=utf-8');
    }

    const html = (await readAsset('index.html')).replaceAll('__TOKEN__', this.token);
    sendText(res, 200, html, 'text/html; charset=utf-8');
  },

  async serveStatic(req, res, parsed, name) {
    try {
      const ext = path.extname(name);
      if (ext in TEXT_TYPES) {
        sendText(res, 200, await readAsset(name), TEXT_TYPES[ext]);
      } else if (ext in BINARY_TYPES) {
        sendBinary(res, 200, await readBinaryAsset(name), BINARY_TYPES[ext]);
      } else {
        throw new Error(`Unsupported format ${ext}`);
      }
    } catch (_) {
      sendText(res, 404, 'not found');
    }
  },

  serveEvents(req, res, parsed) {
    if (!this.validateToken(req, parsed)) return sendText(res, 403, 'invalid token');

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const client = { res, blocked: false, queue: [], queuedBytes: 0, closed: false };
    if (res.write(': connected\n\n') === false) {
      client.blocked = true;
      res.once('drain', () => flushSseClient(this, client));
    }
    this.clients.add(client);
    this.syncClientCount();
    this.sendSse(client, 'state', this.snapshot());

    req.on('close', () => {
      if (client.closed) return;
      client.closed = true;
      this.clients.delete(client);
      this.syncClientCount();
      this.broadcast('state', this.snapshot());
    });
  },

  syncClientCount() {
    this.debug.connectedBrowserClients = this.clients.size;
    this.app.connectedClients = this.clients.size;
  },

  async handleApi(req, res, route, body) {
    const response = await resolveApiRoute(this, req, route, body);
    return sendJson(res, response.status, response.body);
  },

  snapshot() {
    const counts = countQueue(this.queue);
    const archivedCompleted = Math.max(0, Number(this.completedArchiveTotal) || 0);
    counts.completed = (counts.completed || 0) + archivedCompleted;
    counts.total = (counts.total || 0) + archivedCompleted;
    const nextPending = this.queue.find((item) => isPendingLikeStatus(item.status)) || null;
    const completedArchive = this.completedArchiveSnapshot ? this.completedArchiveSnapshot() : { items: [], hasMore: false, cursor: null, totalCompleted: 0 };
    const queue = this.completedArchivePath
      ? this.queue
      : [
          ...this.queue.filter((item) => item.status !== 'completed'),
          ...(completedArchive.items || []),
        ];
    const manualPromptActive = !!(this.currentManualSend && (this.currentItemId || this.currentTurnId));
    const hasPendingQueue = this.queue.some((item) => isPendingLikeStatus(item.status));
    const hasScheduledQueue = !!this.app.scheduledRunAt;
    const hasAutoQueueWork = hasPendingQueue || hasScheduledQueue;
    const canPauseProcessing = !this.currentManualSend
      && (this.app.state === 'watching' || this.isQueueProcessingActive() || hasAutoQueueWork)
      && !NON_PAUSABLE_STATES.has(this.app.state);
    const canPauseManualContinuation = manualPromptActive
      && this.manualSendContinueQueue
      && this.app.state !== 'approval-required';
    const canResumePaused = this.app.state === 'paused';
    const canResumeManualContinuation = manualPromptActive
      && !!nextPending
      && !this.manualSendContinueQueue
      && this.app.state !== 'approval-required';

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
        canUndo: this.canUndoAction ? this.canUndoAction() : hasPendingQueue,
      },
      sessions: this.sessions,
      queue,
      completedArchive,
      output: this.output,
      outputGroups: this.outputGroups,
      outputHistory: this.outputHistoryPayload ? this.outputHistoryPayload() : { hasMore: false },
      rateLimits: this.rateLimits,
      limitResetRequest: this.currentLimitResetRequest ? this.currentLimitResetRequest() : null,
      approval: this.approval,
      outputSequence: this.outputSequence || 0,
      debug: this.opts.debug
             ? this.debug
             : {connectedBrowserClients: this.debug.connectedBrowserClients},
    };
  },

  broadcastAll() {
    this.broadcast('state', this.snapshot());
  },

  broadcast(event, data) {
    for (const client of this.clients) this.sendSse(client, event, data);
  },

  sendSse(client, event, data) {
    if (!client || client.closed) return false;
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    if (client.blocked) {
      const bytes = Buffer.byteLength(chunk);
      if (client.queuedBytes + bytes > MAX_SSE_BUFFER_BYTES) {
        closeSseClient(this, client);
        return false;
      }
      client.queue.push(chunk);
      client.queuedBytes += bytes;
      return true;
    }
    try {
      if (client.res.write(chunk) === false) {
        client.blocked = true;
        client.res.once('drain', () => flushSseClient(this, client));
      }
      return true;
    } catch (_) {
      closeSseClient(this, client);
      return false;
    }
  },
};
