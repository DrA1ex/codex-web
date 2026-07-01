'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { URL } = require('node:url');

const {
  VERSION,
  MAX_OUTPUT_LINES,
  MAX_OUTPUT_TOTAL_CHARS,
  DEFAULT_MODEL,
  MODEL_OPTIONS,
  EFFORT_OPTIONS,
  STATIC_TYPES,
} = require('./config');
const { JsonRpcClient } = require('./json-rpc-client');
const {
  nowIso,
  sleep,
  randomId,
  sha256,
  isLocalHost,
  safeJson,
  truncate,
  asArray,
  maskSecrets,
  ensureDirSync,
  stripTrailingSep,
  friendlyStartError,
  isPidAlive,
  shortId,
} = require('./utils');
const {
  mapApprovalPolicy,
  mapSandbox,
  mapApprovalResponse,
  humanApprovalResponse,
  makeSandboxPolicy,
} = require('./policies');
const {
  extractThreadList,
  normalizeSession,
  fallbackThreadTitle,
} = require('./codex-sessions');
const {
  makeQueueItem,
  normalizeQueueItem,
  countQueue,
  parseExactCommand,
} = require('./queue');
const { normalizeRateLimits } = require('./rate-limits');
const {
  isApprovalMethod,
  isCompactionMethod,
  canAppendOutput,
  limitOutputText,
  appendLimitedOutputText,
  extractDeltaText,
  formatItemStarted,
  outputTypeForItem,
  formatItemCompleted,
} = require('./output-format');
const {
  openBrowser,
  sendText,
  sendJson,
  readAsset,
  readJsonBody,
} = require('./http-utils');

class CodexLimitWatchApp {
  constructor(opts) {
    this.opts = opts;
    this.token = randomId(18);
    this.server = null;
    this.rpc = new JsonRpcClient(this);
    this.clients = new Set();
    this.shuttingDown = false;
    this.stateDirForPair = null;
    this.settingsPath = path.join(opts.stateDir, 'settings.json');
    this.queuePath = null;
    this.statePath = null;
    this.eventsLogPath = null;
    this.jsonRpcLogPath = null;
    this.lockPath = null;
    this.lockAcquired = false;
    this.pumpTimer = null;
    this.limitTimer = null;
    this.approvalTimer = null;
    this.countdownCancel = false;
    this.currentTurnResolve = null;
    this.currentTurnReject = null;
    this.currentItemId = null;
    this.currentTurnId = null;
    this.turnStarted = false;
    this.turnCompletionSeen = false;
    this.turnCompletionStatus = null;
    this.lastComposerText = '';
    this.sessionsLoaded = false;
    this.app = {
      state: 'initializing',
      message: '',
      url: '',
      projectDir: opts.projectDir,
      stateDir: opts.stateDir,
      sessionId: opts.sessionId,
      sessionTitle: opts.sessionId ? shortId(opts.sessionId) : 'not selected',
      model: opts.model || '',
      defaultModel: DEFAULT_MODEL,
      modelOptions: MODEL_OPTIONS,
      effort: opts.effort || '',
      effortOptions: EFFORT_OPTIONS,
      sandbox: opts.sandbox,
      approvalPolicy: opts.approvalPolicy,
      approvalResponse: opts.approvalResponse,
      network: opts.network,
      writableRoots: [opts.projectDir, ...opts.addDirs],
      allSessions: opts.allSessions,
      theme: 'dark',
      sessionError: null,
      connectedClients: 0,
      startedAt: nowIso(),
    };
    this.queue = [];
    this.output = [];
    this.lastDiffOutputText = null;
    this.sessions = [];
    this.sessionPickerReturnState = null;
    this.rateLimits = { status: 'unknown', message: 'not checked yet', buckets: [], resetAt: null, raw: null, updatedAt: null };
    this.approval = null;
    this.debug = {
      appServerStatus: 'not started',
      lastJsonRpcError: null,
      lastRateLimitPayload: null,
      lastTurnId: null,
      connectedBrowserClients: 0,
      stateDirForPair: null,
      queuePath: null,
    };
  }

  async start() {
    ensureDirSync(this.opts.stateDir);
    await this.loadSettings();
    if (!isLocalHost(this.opts.host)) {
      console.warn(`Warning: host ${this.opts.host} is not localhost. The UI is token-protected, but localhost is safer.`);
    }
    this.server = http.createServer((req, res) => this.handleHttp(req, res));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.opts.port, this.opts.host, () => resolve());
    });
    const address = this.server.address();
    this.app.url = `http://${this.opts.host}:${address.port}/?token=${this.token}`;

    await this.rpc.start().catch((err) => {
      throw friendlyStartError(err, this.opts.codexBin);
    });
    this.debug.appServerStatus = 'started';
    await this.rpc.initialize();

    if (this.opts.sessionId) {
      await this.selectSession(this.opts.sessionId, true);
    } else {
      this.app.state = 'selecting-session';
      await this.loadSessions();
    }

    await this.pollRateLimits();
    this.scheduleLimitPolling();
    this.printStartup();
    if (!this.opts.noOpen) openBrowser(this.app.url);
    this.broadcastAll();
    this.schedulePump(500);
  }

  printStartup() {
    console.log('Codex Limit Watch Web');
    console.log(`Project: ${this.opts.projectDir}`);
    console.log(`Session: ${this.app.sessionId || 'not selected'}`);
    console.log(`Model: ${this.opts.model || DEFAULT_MODEL + ' (default)'}`);
    console.log(`Sandbox: ${this.opts.sandbox}`);
    console.log(`Approval policy: ${this.opts.approvalPolicy}`);
    console.log(`Approval response: ${this.opts.approvalResponse}`);
    console.log(`URL: ${this.app.url}`);
    if (this.opts.sandbox === 'danger-full-access') {
      console.log('Warning: danger-full-access disables normal sandbox isolation. Use only in a trusted local environment.');
    }
  }

  async setupPairState(sessionId) {
    const key = sha256(`${stripTrailingSep(this.opts.projectDir)}\n${sessionId}`).slice(0, 32);
    const nextStateDirForPair = path.join(this.opts.stateDir, key);
    if (this.lockAcquired && this.stateDirForPair && this.stateDirForPair !== nextStateDirForPair) {
      this.releaseLock();
    }
    this.stateDirForPair = nextStateDirForPair;
    ensureDirSync(this.stateDirForPair);
    this.queuePath = path.join(this.stateDirForPair, 'queue.json');
    this.statePath = path.join(this.stateDirForPair, 'state.json');
    this.eventsLogPath = path.join(this.stateDirForPair, 'events.log');
    this.jsonRpcLogPath = this.opts.logJsonrpc ? path.join(this.stateDirForPair, 'jsonrpc.log') : null;
    this.lockPath = path.join(this.stateDirForPair, 'app.lock');
    this.debug.stateDirForPair = this.stateDirForPair;
    this.debug.queuePath = this.queuePath;
    await this.acquireLock();
    await this.loadState();
    await this.loadQueue();
    await this.saveState();
  }

  async acquireLock() {
    if (!this.lockPath || this.lockAcquired) return;
    if (fs.existsSync(this.lockPath) && !this.opts.force) {
      let existing = null;
      try { existing = JSON.parse(fs.readFileSync(this.lockPath, 'utf8')); } catch (_) {}
      if (existing && existing.pid && isPidAlive(existing.pid)) {
        const url = existing.url ? `\nURL: ${existing.url}` : '';
        throw new Error(`Another codex-web instance is already running for this project/session (pid ${existing.pid}).${url}\nUse --force only if this is stale.`);
      }
    }
    fs.writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, url: this.app.url, startedAt: nowIso() }, null, 2));
    this.lockAcquired = true;
  }

  releaseLock() {
    if (!this.lockAcquired || !this.lockPath) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
      if (raw.pid === process.pid) fs.unlinkSync(this.lockPath);
    } catch (_) {
      try { fs.unlinkSync(this.lockPath); } catch (_) {}
    }
    this.lockAcquired = false;
  }

  async loadQueue() {
    if (!this.queuePath) return;
    if (!fs.existsSync(this.queuePath)) {
      this.queue = [];
      await this.saveQueue();
      return;
    }
    try {
      const data = JSON.parse(await fsp.readFile(this.queuePath, 'utf8'));
      this.queue = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : []);
      for (const item of this.queue) {
        if (item.status === 'sending' || item.status === 'sent') {
          item.status = 'unknown';
          item.error = 'Previous run exited while this prompt may already have been accepted by Codex.';
        }
        normalizeQueueItem(item);
      }
      await this.saveQueue();
    } catch (err) {
      const backup = `${this.queuePath}.corrupt.${Date.now()}.bak`;
      try { fs.renameSync(this.queuePath, backup); } catch (_) {}
      this.queue = [];
      await this.saveQueue();
      this.appendOutput(`[error] queue file was corrupted. Backup: ${backup}`, 'error');
      this.eventLog('error', `queue file corrupted; backup=${backup}; ${err.message}`);
    }
  }

  async saveQueue() {
    if (!this.queuePath) return;
    const tmp = this.queuePath + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(this.queue, null, 2));
    await fsp.rename(tmp, this.queuePath);
    this.broadcast('queue', this.queue);
  }
  async loadState() {
    if (!this.statePath || !fs.existsSync(this.statePath)) return;
    try {
      const data = JSON.parse(await fsp.readFile(this.statePath, 'utf8'));
      if (!this.opts.modelProvided && Object.prototype.hasOwnProperty.call(data, 'model')) {
        this.opts.model = String(data.model || '').trim();
        this.app.model = this.opts.model;
      }
      if (!this.opts.effortProvided && Object.prototype.hasOwnProperty.call(data, 'effort')) {
        const effort = String(data.effort || '').trim();
        if (EFFORT_OPTIONS.some((m) => m.value === effort)) {
          this.opts.effort = effort;
          this.app.effort = effort;
        }
      }
    } catch (_) {}
  }
  async loadSettings() {
    if (!this.settingsPath || !fs.existsSync(this.settingsPath)) return;
    try {
      const data = JSON.parse(await fsp.readFile(this.settingsPath, 'utf8'));
      if (data.theme === 'light' || data.theme === 'dark') this.app.theme = data.theme;
    } catch (_) {}
  }
  async saveSettings() {
    if (!this.settingsPath) return;
    const data = { theme: this.app.theme || 'dark', updatedAt: nowIso() };
    const tmp = this.settingsPath + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
    await fsp.rename(tmp, this.settingsPath);
  }
  async saveState() {
    if (!this.statePath) return;
    const data = {
      version: VERSION,
      projectDir: this.opts.projectDir,
      sessionId: this.app.sessionId,
      sessionTitle: this.app.sessionTitle,
      model: this.opts.model || '',
      effort: this.opts.effort || '',
      state: this.app.state,
      updatedAt: nowIso(),
    };
    await fsp.writeFile(this.statePath, JSON.stringify(data, null, 2)).catch(() => {});
  }

  eventLog(level, message) {
    if (!this.eventsLogPath) return;
    fs.appendFile(this.eventsLogPath, `${nowIso()} ${level} ${message}\n`, () => {});
  }
  debugLog(message, data = '') {
    this.eventLog('debug', `${message}${data ? ' ' + data : ''}`);
  }

  async loadSessions() {
    if (this.app.sessionId && this.app.state !== 'selecting-session' && !this.canChangeSession()) {
      throw new Error('Pause the queue and wait for the current task to finish before changing sessions.');
    }
    if (this.app.sessionId && this.app.state !== 'selecting-session') {
      this.sessionPickerReturnState = this.app.state;
    }
    this.app.state = 'selecting-session';
    this.app.message = 'Loading sessions…';
    this.app.sessionError = null;
    this.broadcastAll();
    let threads = [];
    let errors = [];
    try {
      const exact = await this.rpc.request('thread/list', {
        cursor: null,
        limit: this.opts.sessionPickerLimit,
        sortKey: 'recency_at',
        sortDirection: 'desc',
        cwd: this.opts.projectDir,
      });
      threads.push(...extractThreadList(exact));
    } catch (err) { errors.push(err.message); }

    try {
      const general = await this.rpc.request('thread/list', {
        cursor: null,
        limit: this.opts.sessionPickerLimit,
        sortKey: 'recency_at',
        sortDirection: 'desc',
        sourceKinds: ['cli', 'vscode', 'appServer', 'unknown'],
      });
      threads.push(...extractThreadList(general));
    } catch (err) { errors.push(err.message); }

    const byId = new Map();
    for (const t of threads) byId.set(t.id || t.threadId || t.sessionId, t);
    const ranked = [...byId.values()].map((t) => normalizeSession(t, this.opts.projectDir));
    ranked.sort((a, b) => a.rank - b.rank || (b.updatedAtMs || 0) - (a.updatedAtMs || 0));
    this.sessions = this.opts.allSessions ? ranked : ranked.filter((s) => s.rank <= 2 || s.cwdMatch === 'exact').slice(0, this.opts.sessionPickerLimit);
    if (this.sessions.length === 0 && !this.opts.allSessions) {
      this.sessions = ranked.slice(0, Math.min(10, this.opts.sessionPickerLimit));
    }
    this.app.message = errors.length ? `Session list loaded with warnings: ${errors.join('; ')}` : 'Select a session';
    this.sessionsLoaded = true;
    this.broadcastAll();
  }

  async selectSession(sessionId, startup = false) {
    if (!startup && this.app.sessionId && this.app.state !== 'selecting-session' && this.app.sessionId !== sessionId && !this.canChangeSession()) {
      throw new Error('Pause the queue and wait for the current task to finish before changing sessions.');
    }
    this.app.state = 'initializing';
    this.app.message = `Resuming session ${shortId(sessionId)}…`;
    this.broadcastAll();
    let result;
    try {
      result = await this.rpc.request('thread/resume', {
        threadId: sessionId,
        cwd: this.opts.projectDir,
        approvalPolicy: mapApprovalPolicy(this.opts.approvalPolicy),
        sandbox: mapSandbox(this.opts.sandbox),
      });
    } catch (err) {
      try {
        result = await this.rpc.request('thread/resume', { threadId: sessionId });
      } catch (err2) {
        throw new Error(`Cannot resume session ${sessionId}: ${err2.message || err.message}`);
      }
    }
    const thread = result?.thread || result || {};
    const selectedSessionId = thread.id || thread.threadId || thread.sessionId || sessionId;
    const selectedSessionTitle = fallbackThreadTitle(thread, this.opts.projectDir);
    try {
      await this.setupPairState(selectedSessionId);
    } catch (err) {
      await this.failSessionSelection(selectedSessionId, err);
      return;
    }
    this.app.sessionId = selectedSessionId;
    this.app.sessionTitle = selectedSessionTitle;
    this.app.sessionError = null;
    await this.tryReadSession();
    const returnState = this.sessionPickerReturnState;
    this.sessionPickerReturnState = null;
    this.app.state = returnState || 'watching';
    this.app.message = startup ? 'Session resumed' : 'Session selected';
    this.appendOutput(`[session] ${this.app.sessionTitle} · ${this.app.sessionId}`, 'system');
    this.eventLog('info', `session selected ${this.app.sessionId}`);
    this.broadcastAll();
    if (this.app.state !== 'paused') this.schedulePump(200);
  }

  async createSession() {
    if (this.app.sessionId && this.app.state !== 'selecting-session' && !this.canChangeSession()) {
      throw new Error('Pause the queue and wait for the current task to finish before changing sessions.');
    }
    this.app.state = 'initializing';
    this.app.message = 'Creating new session...';
    this.broadcastAll();
    let result;
    try {
      const params = {
        cwd: this.opts.projectDir,
        approvalPolicy: mapApprovalPolicy(this.opts.approvalPolicy),
        sandbox: mapSandbox(this.opts.sandbox),
        serviceName: 'codex-web',
      };
      if (this.opts.model) params.model = this.opts.model;
      if (this.opts.effort) params.effort = this.opts.effort;
      result = await this.rpc.request('thread/start', params);
    } catch (err) {
      try {
        result = await this.rpc.request('thread/start', { cwd: this.opts.projectDir });
      } catch (err2) {
        this.app.state = 'selecting-session';
        this.app.message = 'Could not create a new session';
        this.appendOutput(`[error] Cannot create new session: ${err2.message || err.message}`, 'error');
        this.broadcastAll();
        throw new Error(`Cannot create new session: ${err2.message || err.message}`);
      }
    }
    const thread = result?.thread || result || {};
    const sessionId = thread.id || thread.threadId || thread.sessionId;
    if (!sessionId) {
      this.app.state = 'selecting-session';
      this.app.message = 'Could not create a new session';
      this.broadcastAll();
      throw new Error('Cannot create new session: app-server did not return a session id');
    }
    this.app.sessionId = sessionId;
    this.app.sessionTitle = fallbackThreadTitle(thread, this.opts.projectDir);
    this.app.sessionError = null;
    try {
      await this.setupPairState(this.app.sessionId);
    } catch (err) {
      await this.failSessionSelection(sessionId, err);
      return;
    }
    await this.tryReadSession();
    const returnState = this.sessionPickerReturnState;
    this.sessionPickerReturnState = null;
    this.app.state = returnState || 'watching';
    this.app.message = 'Session created';
    this.appendOutput(`[session] created ${this.app.sessionTitle} · ${this.app.sessionId}`, 'system');
    this.eventLog('info', `session created ${this.app.sessionId}`);
    this.broadcastAll();
    if (this.app.state !== 'paused') this.schedulePump(200);
  }

  async tryReadSession() {
    if (!this.app.sessionId) return;
    try {
      const read = await this.rpc.request('thread/read', { threadId: this.app.sessionId, includeTurns: true }, 6000);
      const thread = read?.thread || read || {};
      this.app.sessionTitle = fallbackThreadTitle(thread, this.opts.projectDir) || this.app.sessionTitle;
      this.app.session = normalizeSession(thread, this.opts.projectDir);
    } catch (err) {
      this.debugLog('thread/read failed', err.message);
    }
  }

  async failSessionSelection(sessionId, err) {
    this.releaseLock();
    this.sessionPickerReturnState = null;
    this.app.sessionId = null;
    this.app.sessionTitle = 'not selected';
    this.app.session = null;
    this.app.state = 'selecting-session';
    this.app.message = 'Session unavailable';
    this.app.sessionError = {
      sessionId,
      message: err.message || String(err),
    };
    this.queue = [];
    this.currentItemId = null;
    this.currentTurnId = null;
    this.stateDirForPair = null;
    this.queuePath = null;
    this.statePath = null;
    this.eventsLogPath = null;
    this.jsonRpcLogPath = null;
    this.lockPath = null;
    this.debug.stateDirForPair = null;
    this.debug.queuePath = null;
    this.broadcastAll();
  }

  scheduleLimitPolling() {
    if (this.limitTimer) clearInterval(this.limitTimer);
    this.limitTimer = setInterval(() => this.pollRateLimits().catch((err) => this.debugLog('pollRateLimits failed', err.message)), this.opts.watchInterval * 1000);
    this.limitTimer.unref();
  }
  async pollRateLimits() {
    if (!this.rpc || this.rpc.exited) return;
    try {
      const result = await this.rpc.request('account/rateLimits/read', undefined, 12000);
      this.rateLimits = normalizeRateLimits(result);
      this.debug.lastRateLimitPayload = result;
      this.broadcast('rateLimits', this.rateLimits);
      this.broadcastAll();
    } catch (err) {
      this.rateLimits = { status: 'unknown', message: err.message, buckets: [], resetAt: null, raw: null, updatedAt: nowIso() };
      this.debug.lastJsonRpcError = { message: err.message, code: err.code, data: err.data };
      this.broadcast('rateLimits', this.rateLimits);
      this.broadcastAll();
    }
  }

  schedulePump(delay = 0) {
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this.pumpQueue().catch((err) => this.setError(err.message));
    }, delay);
    this.pumpTimer.unref();
  }

  isQueueProcessingActive() {
    if (this.currentItemId || this.currentTurnId || this.pumpTimer) return true;
    return ['countdown', 'sending', 'streaming', 'waiting-limits'].includes(this.app.state);
  }

  hasActivePrompt() {
    return !!(this.currentItemId || this.currentTurnId || this.queue.some((i) => i.status === 'sending' || i.status === 'sent'));
  }

  canChangeSession() {
    const unsafeQueue = this.queue.some((i) => i.status === 'pending' || i.status === 'sending' || i.status === 'sent');
    return !!this.app.sessionId && !unsafeQueue && !this.isQueueProcessingActive() && !this.currentItemId && !this.currentTurnId && !this.approval && !['initializing', 'selecting-session', 'approval-required', 'shutting-down'].includes(this.app.state);
  }

  cancelSessionChange() {
    if (!this.app.sessionId || this.app.state !== 'selecting-session') return { ok: true };
    this.app.state = this.sessionPickerReturnState || 'paused';
    this.sessionPickerReturnState = null;
    this.app.message = 'Session unchanged';
    this.broadcastAll();
    return { ok: true };
  }

  async movePendingToNext(item) {
    if (!item || item.status !== 'pending') throw new Error('Only pending prompts can be sent');
    const from = this.queue.indexOf(item);
    if (from < 0) throw new Error('Queue item not found');
    let target = 0;
    const runningIndex = this.queue.findIndex((i) => i.id === this.currentItemId || i.status === 'sending' || i.status === 'sent');
    if (runningIndex >= 0) target = runningIndex + 1;
    this.queue.splice(from, 1);
    if (from < target) target -= 1;
    this.queue.splice(Math.max(0, target), 0, item);
    await this.saveQueue();
    this.appendOutput(`[queue] next #${item.id}`, 'system');
    this.broadcastAll();
    this.schedulePump(200);
  }

  async pumpQueue() {
    if (this.shuttingDown) return;
    if (!this.app.sessionId) return;
    if (this.app.state === 'paused' || this.app.state === 'approval-required') return;
    if (this.currentItemId || this.currentTurnId) return;
    const pending = this.queue.find((i) => i.status === 'pending');
    if (!pending) {
      if (this.queue.length && this.queue.every((i) => ['completed', 'cancelled', 'failed', 'unknown'].includes(i.status))) {
        if (this.app.state !== 'done' && !this.queue.some((i) => i.status === 'failed' || i.status === 'unknown')) {
          this.app.state = 'done';
          this.appendOutput('[queue] completed', 'system');
          this.broadcastAll();
        } else if (!['paused', 'error', 'done'].includes(this.app.state)) {
          this.app.state = 'watching';
          this.broadcastAll();
        }
      } else if (!['paused', 'error', 'done'].includes(this.app.state)) {
        this.app.state = 'watching';
        this.broadcastAll();
      }
      return;
    }

    if (this.rateLimits.status === 'unknown') {
      await this.pollRateLimits();
    }
    if (this.rateLimits.status === 'limited') {
      this.app.state = 'waiting-limits';
      const resetAt = this.rateLimits.resetAt ? new Date(this.rateLimits.resetAt * 1000) : null;
      const waitMs = resetAt ? Math.max(1000, resetAt.getTime() - Date.now() + 1000) : this.opts.watchInterval * 1000;
      this.app.message = resetAt ? `Waiting for limit reset at ${resetAt.toLocaleTimeString()}` : 'Waiting for rate limits';
      this.broadcastAll();
      this.schedulePump(Math.min(waitMs, this.opts.watchInterval * 1000));
      return;
    }
    if (this.rateLimits.status === 'unknown') {
      this.app.state = 'waiting-limits';
      this.app.message = 'Limits unknown; retrying before auto-send';
      this.broadcastAll();
      this.schedulePump(this.opts.watchInterval * 1000);
      return;
    }
    await this.runCountdownAndSend(pending);
  }

  async sendItemNow(item) {
    if (this.shuttingDown) return;
    if (!this.app.sessionId) throw new Error('No Codex session selected');
    if (this.isQueueProcessingActive()) {
      await this.movePendingToNext(item);
      return;
    }
    if (this.currentItemId || this.currentTurnId) throw new Error('A prompt is already running');
    if (!item || item.status !== 'pending') throw new Error('Only pending prompts can be sent');
    this.app.state = 'watching';
    this.app.message = 'Manual send requested';
    this.broadcastAll();
    if (this.rateLimits.status === 'unknown') {
      await this.pollRateLimits();
    }
    if (this.rateLimits.status === 'limited') {
      this.app.state = 'waiting-limits';
      const resetAt = this.rateLimits.resetAt ? new Date(this.rateLimits.resetAt * 1000) : null;
      this.app.message = resetAt ? `Waiting for limit reset at ${resetAt.toLocaleTimeString()}` : 'Waiting for rate limits';
      this.broadcastAll();
      return;
    }
    if (this.rateLimits.status === 'unknown') {
      this.app.state = 'waiting-limits';
      this.app.message = 'Limits unknown; retrying before manual send';
      this.broadcastAll();
      return;
    }
    await this.runCountdownAndSend(item, { continueQueue: false });
  }

  async runCountdownAndSend(item, options = {}) {
    const continueQueue = options.continueQueue !== false;
    this.countdownCancel = false;
    this.app.state = 'countdown';
    this.broadcastAll();
    const idx = this.visibleIndex(item.id);
    for (let n = this.opts.countdown; n > 0; n--) {
      if (this.app.state === 'paused' || this.countdownCancel) return;
      this.appendOutput(`Sending prompt #${idx} in ${n}…`, 'system');
      this.broadcastAll();
      await sleep(1000);
    }
    if (this.app.state === 'paused' || this.countdownCancel) return;
    await this.sendPrompt(item, { continueQueue });
  }

  visibleIndex(id) {
    const i = this.queue.findIndex((x) => x.id === id);
    return i >= 0 ? i + 1 : '?';
  }

  async sendPrompt(item, options = {}) {
    const continueQueue = options.continueQueue !== false;
    normalizeQueueItem(item);
    item.status = 'sending';
    item.startedAt = nowIso();
    item.error = null;
    this.currentItemId = item.id;
    this.turnStarted = false;
    this.turnCompletionSeen = false;
    this.turnCompletionStatus = null;
    await this.saveQueue();
    this.app.state = 'sending';
    this.appendOutput(`[send] #${item.id} · ${item.lineCount} lines`, 'send');
    this.appendOutput(`[prompt]\n${item.text}`, 'prompt');
    this.broadcastAll();

    const params = {
      threadId: this.app.sessionId,
      cwd: this.opts.projectDir,
      input: [{ type: 'text', text: item.text }],
      approvalPolicy: mapApprovalPolicy(this.opts.approvalPolicy),
      sandboxPolicy: makeSandboxPolicy(this.opts),
    };
    if (this.opts.model) params.model = this.opts.model;
    if (this.opts.effort) params.effort = this.opts.effort;
    try {
      const result = await this.rpc.request('turn/start', params);
      const turn = result?.turn || result || {};
      this.currentTurnId = turn.id || this.currentTurnId;
      this.debug.lastTurnId = this.currentTurnId;
      if (!this.turnCompletionSeen) {
        item.status = 'sent';
        await this.saveQueue();
        this.app.state = 'streaming';
        this.broadcastAll();
        await this.waitForTurnCompletion();
      }
    } catch (err) {
      item.finishedAt = nowIso();
      item.error = err.message;
      if (this.turnStarted) {
        item.status = 'failed';
        this.pause(`Error after turn/started: ${err.message}`);
      } else {
        item.status = 'failed';
        this.pause(`turn/start failed before confirmation: ${err.message}`);
      }
      await this.saveQueue();
      this.appendOutput(`[error] ${err.message}`, 'error');
    } finally {
      this.currentItemId = null;
      this.currentTurnId = null;
      this.currentTurnResolve = null;
      this.currentTurnReject = null;
      this.turnStarted = false;
      await this.saveState();
      this.broadcastAll();
      if (continueQueue && this.app.state !== 'paused' && this.app.state !== 'approval-required' && this.app.state !== 'error') {
        this.app.state = 'watching';
        this.broadcastAll();
        this.schedulePump(1500);
      } else if (!continueQueue && this.app.state !== 'paused' && this.app.state !== 'approval-required' && this.app.state !== 'error') {
        this.app.state = 'paused';
        this.app.message = 'Manual send completed. Auto-send paused.';
        this.broadcastAll();
      }
    }
  }

  waitForTurnCompletion() {
    return new Promise((resolve, reject) => {
      this.currentTurnResolve = resolve;
      this.currentTurnReject = reject;
    });
  }

  pause(message = 'Auto-send paused. Type /resume or click Resume to continue.') {
    this.countdownCancel = true;
    this.app.state = 'paused';
    this.app.message = message;
    this.appendOutput(message, 'system');
    this.broadcastAll();
  }
  cancelPendingSend() {
    this.pause('Next prompt send cancelled. Click Resume to continue.');
  }
  async interruptCurrentTurn() {
    if (!this.currentTurnId || !this.app.sessionId) {
      return { ok: false, message: 'No running prompt to interrupt.' };
    }
    const turnId = this.currentTurnId;
    this.appendOutput('[turn] interrupt requested', 'system');
    await this.rpc.request('turn/interrupt', { threadId: this.app.sessionId, turnId }, 3000);
    this.pause('Running prompt interrupted. Click Resume to continue.');
    return { ok: true };
  }
  async setModel(model) {
    const value = String(model || '').trim();
    if (value && !MODEL_OPTIONS.some((m) => m.value === value)) {
      throw new Error(`Unsupported model selection: ${value}`);
    }
    this.opts.model = value;
    this.app.model = value;
    await this.saveState();
    this.appendOutput(`[config] model ${value || DEFAULT_MODEL + ' (default)'}`, 'system');
    this.broadcastAll();
    return { ok: true, model: value };
  }
  async setEffort(effort) {
    const value = String(effort || '').trim();
    if (!EFFORT_OPTIONS.some((m) => m.value === value)) {
      throw new Error(`Unsupported effort selection: ${value}`);
    }
    this.opts.effort = value;
    this.app.effort = value;
    await this.saveState();
    this.appendOutput(`[config] effort ${value || 'default'}`, 'system');
    this.broadcastAll();
    return { ok: true, effort: value };
  }
  async setTheme(theme) {
    const value = theme === 'light' ? 'light' : 'dark';
    this.app.theme = value;
    await this.saveSettings();
    this.broadcastAll();
    return { ok: true, theme: value };
  }
  resume() {
    if (this.approval) {
      this.app.state = 'approval-required';
      this.app.message = 'Resolve approval request first';
      this.broadcastAll();
      return;
    }
    this.app.state = 'watching';
    this.app.message = 'Auto-send resumed';
    this.appendOutput('[queue] resumed', 'system');
    this.broadcastAll();
    this.schedulePump(200);
  }

  handleNotification(method, params) {
    this.eventLog('debug', `notify ${method} ${safeJson(maskSecrets(params)).slice(0, 1000)}`);
    if (method === 'account/rateLimits/updated') {
      this.rateLimits = normalizeRateLimits(params);
      this.debug.lastRateLimitPayload = params;
      this.broadcast('rateLimits', this.rateLimits);
      this.broadcastAll();
      return;
    }
    if (method === 'serverRequest/resolved') {
      if (this.approval && (!params.requestId || params.requestId === this.approval.requestId)) {
        this.approval = null;
        this.clearApprovalTimeout();
        this.broadcast('approval', null);
        if (this.app.state === 'approval-required') this.resume();
      }
      return;
    }
    if (method === 'error') {
      const message = params?.error?.message || params?.message || safeJson(params);
      this.appendOutput(`[error] ${message}`, 'error');
      return;
    }
    if (method === 'turn/started') {
      const turn = params.turn || params;
      this.currentTurnId = turn.id || turn.turnId || this.currentTurnId;
      this.debug.lastTurnId = this.currentTurnId;
      this.turnStarted = true;
      const item = this.currentItem();
      if (item) {
        item.status = 'sent';
        this.saveQueue().catch(() => {});
      }
      this.app.state = 'streaming';
      this.appendOutput('[turn] started', 'turn');
      this.broadcastAll();
      return;
    }
    if (method === 'turn/completed' || method === 'turn/failed') {
      const turn = params.turn || params;
      const status = turn.status || (method === 'turn/failed' ? 'failed' : 'completed');
      const errMessage = turn?.error?.message || params?.error?.message || null;
      this.turnCompletionSeen = true;
      this.turnCompletionStatus = status;
      const item = this.currentItem();
      if (item) {
        item.finishedAt = nowIso();
        item.status = status === 'completed' ? 'completed' : 'failed';
        item.error = errMessage;
        this.saveQueue().catch(() => {});
      }
      this.appendOutput(status === 'completed' ? '[turn] completed' : `[turn] ${status}${errMessage ? ': ' + errMessage : ''}`, status === 'completed' ? 'turn' : 'error');
      this.tryReadSession().then(() => this.broadcastAll()).catch((err) => this.debugLog('refresh session title failed', err.message));
      if (this.currentTurnResolve) this.currentTurnResolve();
      if (status !== 'completed') this.pause('Auto-send paused after turn failure. Type /resume after reviewing the error.');
      return;
    }
    if (method === 'item/started') {
      const item = params.item || params;
      const label = formatItemStarted(item);
      if (label) this.appendOutput(label, outputTypeForItem(item));
      return;
    }
    if (method === 'item/completed') {
      const item = params.item || params;
      const label = formatItemCompleted(item);
      if (label) this.appendOutput(label, item?.status === 'failed' ? 'error' : 'item');
      return;
    }
    if (method.includes('/delta') || method.includes('Delta')) {
      const text = extractDeltaText(method, params);
      const type = isCompactionMethod(method) ? 'context-delta' : (method.includes('commandExecution') || method.includes('tool') ? 'tool-delta' : (/reasoning/i.test(method) ? 'reasoning-delta' : 'delta'));
      if (text) this.appendOutput(text, type, true);
      return;
    }
    if (method === 'turn/plan/updated') {
      const plan = asArray(params.plan).map((p) => `${p.status || '-'} ${p.step || ''}`).join('\n');
      if (plan) this.appendOutput('[plan]\n' + plan, 'plan');
      return;
    }
    if (method === 'turn/diff/updated' && params.diff) {
      const diff = typeof params.diff === 'string' ? params.diff : (params.diff.unified || params.diff.text || safeJson(params.diff));
      this.updateDiffOutput(diff || '[diff updated]');
      return;
    }
    if (this.opts.debug) this.appendOutput(`[event] ${method} ${truncate(safeJson(params), 500)}`, 'event');
  }

  currentItem() {
    if (!this.currentItemId) return null;
    return this.queue.find((i) => i.id === this.currentItemId) || null;
  }

  async handleServerRequest(msg) {
    const method = msg.method;
    const params = msg.params || {};
    this.eventLog('info', `server request ${method}`);
    if (isApprovalMethod(method)) {
      const configured = mapApprovalResponse(this.opts.approvalResponse);
      if (configured !== 'manual') {
        const result = configured;
        this.appendOutput(`[approval] ${method}: ${humanApprovalResponse(configured)}`, 'system');
        this.rpc.respond(msg.id, result);
        return;
      }
      this.approval = {
        rpcId: msg.id,
        requestId: params.requestId || params.itemId || String(msg.id),
        method,
        params,
        createdAt: nowIso(),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      };
      this.app.state = 'approval-required';
      this.app.message = 'Approval required';
      this.appendOutput('[approval] required. Use UI buttons or /approve, /approve-session, /decline, /cancel.', 'system');
      this.scheduleApprovalTimeout(this.approval.requestId);
      this.broadcast('approval', this.approval);
      this.broadcastAll();
      return;
    }
    if (method === 'currentTime/read') {
      this.rpc.respond(msg.id, { currentTimeAt: Math.floor(Date.now() / 1000) });
      return;
    }
    if (method === 'item/tool/requestUserInput' || method === 'mcpServer/elicitation/request') {
      this.rpc.respond(msg.id, { action: 'decline', content: null });
      return;
    }
    this.rpc.respond(msg.id, { code: -32601, message: `Unsupported server request: ${method}` }, true);
  }

  async respondApproval(decision) {
    if (!this.approval) throw new Error('No pending approval request');
    this.clearApprovalTimeout();
    const mapped = mapApprovalResponse(decision);
    const id = this.approval.rpcId;
    this.rpc.respond(id, mapped);
    this.appendOutput(`[approval] ${humanApprovalResponse(mapped)}`, 'system');
    this.approval = null;
    this.broadcast('approval', null);
    if (this.app.state === 'approval-required') this.resume();
  }
  scheduleApprovalTimeout(requestId) {
    this.clearApprovalTimeout();
    this.approvalTimer = setTimeout(() => {
      this.autoRejectApproval(requestId).catch((err) => this.setError(err.message));
    }, 15 * 60 * 1000);
    this.approvalTimer.unref();
  }
  clearApprovalTimeout() {
    if (this.approvalTimer) clearTimeout(this.approvalTimer);
    this.approvalTimer = null;
  }
  async autoRejectApproval(requestId) {
    if (!this.approval || this.approval.requestId !== requestId) return;
    const id = this.approval.rpcId;
    this.rpc.respond(id, mapApprovalResponse('decline'));
    this.appendOutput('[approval] auto-declined after 15 minutes', 'system');
    this.approval = null;
    this.clearApprovalTimeout();
    this.broadcast('approval', null);
    this.pause('Approval timed out and was auto-declined. Queue paused.');
  }

  appendOutput(text, type = 'text', appendToPrevious = false) {
    if (text === undefined || text === null || text === '') return;
    if (appendToPrevious && this.output.length) {
      const last = this.output[this.output.length - 1];
      if (canAppendOutput(last.type, type)) {
        last.text = appendLimitedOutputText(last.text, text);
        last.ts = nowIso();
      } else {
        this.output.push({ id: randomId(5), ts: nowIso(), type, text: limitOutputText(text) });
      }
    } else {
      this.output.push({ id: randomId(5), ts: nowIso(), type, text: limitOutputText(text) });
    }
    this.trimOutput();
    this.broadcast('output', this.output);
  }
  updateDiffOutput(text) {
    if (text === undefined || text === null || text === '') return;
    const limited = limitOutputText(text);
    if (this.lastDiffOutputText === limited) return;
    this.lastDiffOutputText = limited;
    const last = this.output[this.output.length - 1];
    if (last && last.type === 'diff') {
      if (last.text === limited) return;
      last.text = limited;
      last.ts = nowIso();
    } else {
      this.output.push({ id: randomId(5), ts: nowIso(), type: 'diff', text: limited });
    }
    this.trimOutput();
    this.broadcast('output', this.output);
  }
  trimOutput() {
    if (this.output.length > MAX_OUTPUT_LINES) this.output.splice(0, this.output.length - MAX_OUTPUT_LINES);
    let total = 0;
    for (let i = this.output.length - 1; i >= 0; i--) {
      total += String(this.output[i].text || '').length;
      if (total > MAX_OUTPUT_TOTAL_CHARS) {
        this.output.splice(0, i + 1);
        break;
      }
    }
  }
  clearOutput() {
    this.output = [];
    this.lastDiffOutputText = null;
    this.broadcast('output', this.output);
    this.broadcastAll();
  }

  async addPrompt(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return { ok: false, message: 'Prompt is empty' };
    const command = parseExactCommand(trimmed);
    if (command) return await this.executeCommand(command);
    const item = makeQueueItem(String(text).replace(/\r\n/g, '\n'));
    this.queue.push(item);
    await this.saveQueue();
    this.app.state = this.app.state === 'done' ? 'watching' : this.app.state;
    this.appendOutput(`[queue] added #${item.id} · ${item.lineCount} lines`, 'system');
    this.broadcastAll();
    this.schedulePump(200);
    return { ok: true, clearComposer: true, item };
  }

  async executeCommand(command) {
    switch (command) {
      case '/send':
        return { ok: false, message: 'Type a prompt and press Cmd+Enter or click Add to queue. /send is accepted only as a standalone command, so there is no prompt body to enqueue.' };
      case '/undo': return await this.undoLast();
      case '/clear': await this.clearPending(); return { ok: true, clearComposer: true };
      case '/pause': this.pause(); return { ok: true, clearComposer: true };
      case '/resume': this.resume(); return { ok: true, clearComposer: true };
      case '/quit': await this.shutdown('quit command'); return { ok: true, clearComposer: true };
      case '/help': return { ok: true, message: '/send, /undo, /clear, /pause, /resume, /quit, /approve, /approve-session, /decline, /cancel' };
      case '/approve': await this.respondApproval('accept'); return { ok: true, clearComposer: true };
      case '/approve-session': await this.respondApproval('accept-for-session'); return { ok: true, clearComposer: true };
      case '/decline': await this.respondApproval('decline'); return { ok: true, clearComposer: true };
      case '/cancel': await this.respondApproval('cancel'); return { ok: true, clearComposer: true };
      default: return { ok: false, message: `Unknown command: ${command}` };
    }
  }

  async undoLast() {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].status === 'pending') {
        const [item] = this.queue.splice(i, 1);
        await this.saveQueue();
        this.appendOutput(`[queue] undo #${item.id}`, 'system');
        this.broadcastAll();
        return { ok: true, composerText: item.text };
      }
    }
    return { ok: false, message: 'No pending prompt to undo' };
  }
  async clearPending() {
    const before = this.queue.length;
    this.queue = this.queue.filter((i) => i.status !== 'pending');
    await this.saveQueue();
    this.appendOutput(`[queue] cleared ${before - this.queue.length} pending prompt(s)`, 'system');
    this.broadcastAll();
  }
  async clearCompleted() {
    const before = this.queue.length;
    this.queue = this.queue.filter((i) => i.status !== 'completed');
    await this.saveQueue();
    this.appendOutput(`[queue] cleared ${before - this.queue.length} completed prompt(s)`, 'system');
    this.broadcastAll();
  }
  async updateQueueItem(body) {
    const item = this.queue.find((i) => i.id === body.id);
    if (!item) throw new Error('Queue item not found');
    if (body.action === 'edit') {
      if (!['pending', 'failed', 'unknown', 'cancelled'].includes(item.status)) throw new Error('Only pending/failed/unknown/cancelled items can be edited');
      item.text = String(body.text || '');
      item.status = 'pending';
      item.error = null;
      normalizeQueueItem(item);
    } else if (body.action === 'duplicate') {
      const dup = makeQueueItem(item.text);
      const idx = this.queue.indexOf(item);
      this.queue.splice(idx + 1, 0, dup);
    } else if (body.action === 'sendNow') {
      await this.sendItemNow(item);
      return;
    } else if (body.action === 'markCompleted') {
      item.status = 'completed';
      item.finishedAt = nowIso();
      item.error = null;
    } else if (body.action === 'retry') {
      item.status = 'pending';
      item.startedAt = null;
      item.finishedAt = null;
      item.error = null;
    } else if (body.status) {
      item.status = String(body.status);
    }
    normalizeQueueItem(item);
    await this.saveQueue();
    this.broadcastAll();
    this.schedulePump(200);
  }
  async removeQueueItem(id) {
    const idx = this.queue.findIndex((i) => i.id === id);
    if (idx < 0) throw new Error('Queue item not found');
    const item = this.queue[idx];
    if (item.id === this.currentItemId) throw new Error('Cannot remove active prompt');
    this.queue.splice(idx, 1);
    await this.saveQueue();
    this.broadcastAll();
  }
  async reorderQueueItem(id, direction) {
    const idx = this.queue.findIndex((i) => i.id === id);
    if (idx < 0) throw new Error('Queue item not found');
    const j = direction === 'up' ? idx - 1 : idx + 1;
    if (j < 0 || j >= this.queue.length) return;
    const tmp = this.queue[idx];
    this.queue[idx] = this.queue[j];
    this.queue[j] = tmp;
    await this.saveQueue();
    this.broadcastAll();
  }

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
  }
  validateToken(req, parsed) {
    const q = parsed.searchParams.get('token');
    const h = req.headers['x-codex-limit-watch-token'];
    return q === this.token || h === this.token;
  }
  serveIndex(res) {
    sendText(res, 200, readAsset('index.html').replaceAll('__TOKEN__', this.token), 'text/html; charset=utf-8');
  }
  serveStatic(res, name) {
    sendText(res, 200, readAsset(name), STATIC_TYPES[path.extname(name)] || 'application/octet-stream');
  }
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
  }
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
    if (route === '/api/queue/update') { await this.updateQueueItem(body); return sendJson(res, 200, { ok: true }); }
    if (route === '/api/queue/remove') { await this.removeQueueItem(String(body.id)); return sendJson(res, 200, { ok: true }); }
    if (route === '/api/queue/reorder') { await this.reorderQueueItem(String(body.id), body.direction); return sendJson(res, 200, { ok: true }); }
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
  }

  snapshot() {
    const counts = countQueue(this.queue);
    const nextPending = this.queue.find((i) => i.status === 'pending') || null;
    return {
      app: {
        ...this.app,
        queueCounts: counts,
        nextPendingId: nextPending?.id || null,
        canInterrupt: !!(this.currentTurnId && this.app.sessionId),
        canPause: !!this.app.sessionId && this.isQueueProcessingActive() && !['paused', 'done', 'error', 'initializing', 'selecting-session', 'approval-required'].includes(this.app.state),
        canChangeSession: this.canChangeSession(),
      },
      sessions: this.sessions,
      queue: this.queue,
      output: this.output,
      rateLimits: this.rateLimits,
      approval: this.approval,
      debug: this.opts.debug ? this.debug : { connectedBrowserClients: this.debug.connectedBrowserClients },
    };
  }
  broadcastAll() { this.broadcast('state', this.snapshot()); }
  broadcast(event, data) {
    for (const client of this.clients) this.sendSse(client, event, data);
  }
  sendSse(client, event, data) {
    try {
      client.res.write(`event: ${event}\n`);
      client.res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (_) {
      this.clients.delete(client);
    }
  }

  setError(message) {
    this.app.state = 'error';
    this.app.message = message;
    this.appendOutput(`[error] ${message}`, 'error');
    this.eventLog('error', message);
    this.broadcastAll();
  }

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
}

module.exports = { CodexLimitWatchApp };
