'use strict';

const { mapApprovalPolicy, mapSandbox } = require('./policies');
const {
  extractThreadList,
  normalizeSession,
  fallbackThreadTitle,
} = require('./codex-sessions');
const { shortId } = require('./utils');

module.exports = {
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
  },

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
  },

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
  },

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
  },

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
};
