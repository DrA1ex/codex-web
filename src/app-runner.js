'use strict';

const { DEFAULT_MODEL, MODEL_OPTIONS, EFFORT_OPTIONS } = require('./config');
const { nowIso, sleep } = require('./utils');
const { mapApprovalPolicy, makeSandboxPolicy } = require('./policies');
const {
  makeQueueItem,
  normalizeQueueItem,
  movePendingToNext: movePendingToNextItem,
  movePendingToFirst: movePendingToFirstItem,
  parseExactCommand,
} = require('./queue');

module.exports = {
  schedulePump(delay = 0) {
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this.pumpQueue().catch((err) => this.setError(err.message));
    }, delay);
    this.pumpTimer.unref();
  },

  isQueueProcessingActive() {
    if (this.currentItemId || this.currentTurnId || this.pumpTimer) return true;
    return ['countdown', 'sending', 'streaming', 'waiting-limits'].includes(this.app.state);
  },

  hasActivePrompt() {
    return !!(this.currentItemId || this.currentTurnId || this.queue.some((i) => i.status === 'sending' || i.status === 'sent'));
  },

  canChangeSession() {
    const unsafeQueue = this.queue.some((i) => i.status === 'pending' || i.status === 'sending' || i.status === 'sent');
    return !!this.app.sessionId && !unsafeQueue && !this.isQueueProcessingActive() && !this.currentItemId && !this.currentTurnId && !this.approval && !['initializing', 'selecting-session', 'approval-required', 'shutting-down'].includes(this.app.state);
  },

  cancelSessionChange() {
    if (!this.app.sessionId || this.app.state !== 'selecting-session') return { ok: true };
    this.app.state = this.sessionPickerReturnState || 'paused';
    this.sessionPickerReturnState = null;
    this.app.message = 'Session unchanged';
    this.broadcastAll();
    return { ok: true };
  },

  async movePendingToNext(item) {
    const result = movePendingToNextItem(this.queue, item, this.currentItemId);
    this.queue = result.queue;
    await this.saveQueue();
    this.appendOutput(`[queue] next #${item.id}`, 'system');
    this.broadcastAll();
    this.schedulePump(200);
    return { ok: true, item: result.item };
  },

  async movePendingToFirst(item) {
    const result = movePendingToFirstItem(this.queue, item);
    this.queue = result.queue;
    await this.saveQueue();
    this.broadcastAll();
    return { ok: true, item: result.item };
  },

  async pumpQueue() {
    if (this.shuttingDown) return;
    if (!this.app.sessionId) return;
    if ((this.app.state === 'paused' && !this.app.scheduledRunAt) || this.app.state === 'approval-required') return;
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

    if (this.app.scheduledRunAt) {
      const scheduledAt = Date.parse(this.app.scheduledRunAt);
      if (Number.isFinite(scheduledAt) && scheduledAt > Date.now()) {
        this.app.state = 'scheduled';
        this.app.message = `Queue scheduled for ${new Date(scheduledAt).toLocaleString()}`;
        this.broadcastAll();
        this.schedulePump(Math.min(Math.max(1000, scheduledAt - Date.now()), this.opts.watchInterval * 1000));
        return;
      }
      this.app.scheduledRunAt = null;
      await this.saveState();
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
  },

  async sendItemNow(item) {
    if (this.shuttingDown) return;
    if (!this.app.sessionId) throw new Error('No Codex session selected');
    if (this.isQueueProcessingActive()) {
      return await this.movePendingToNext(item);
    }
    if (this.currentItemId || this.currentTurnId) throw new Error('A prompt is already running');
    if (!item || item.status !== 'pending') throw new Error('Only pending prompts can be sent');
    await this.movePendingToFirst(item);
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
      return { ok: true, item };
    }
    if (this.rateLimits.status === 'unknown') {
      this.app.state = 'waiting-limits';
      this.app.message = 'Limits unknown; retrying before manual send';
      this.broadcastAll();
      return { ok: true, item };
    }
    this.currentManualSend = true;
    try {
      await this.runCountdownAndSend(item, { continueQueue: false });
    } finally {
      this.currentManualSend = false;
    }
    return { ok: true, item };
  },

  async sendComposerNow(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return { ok: false, message: 'Prompt is empty' };
    const command = parseExactCommand(trimmed);
    if (command) return await this.executeCommand(command);
    if (!this.app.sessionId) throw new Error('No Codex session selected');
    const shouldQueueOnly = this.currentItemId || this.currentTurnId || this.isQueueProcessingActive() || this.queue.some((i) => i.status === 'pending');
    const item = makeQueueItem(String(text).replace(/\r\n/g, '\n'));
    this.queue.push(item);
    await this.saveQueue();
    this.appendOutput(`[queue] added #${item.id} · ${item.lineCount} lines`, 'system');
    this.broadcastAll();
    if (shouldQueueOnly) {
      this.schedulePump(200);
      return { ok: true, clearComposer: true, item };
    }
    if (this.rateLimits.status === 'unknown') {
      await this.pollRateLimits();
    }
    if (this.rateLimits.status === 'limited') {
      this.schedulePump(200);
      return { ok: true, clearComposer: true, item };
    }
    if (this.rateLimits.status === 'unknown') {
      this.schedulePump(200);
      return { ok: true, clearComposer: true, item };
    }
    this.app.state = 'watching';
    this.app.message = 'Sending prompt';
    this.broadcastAll();
    this.sendPrompt(item, { continueQueue: false }).catch((err) => this.setError(err.message));
    return { ok: true, clearComposer: true, item };
  },

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
  },

  visibleIndex(id) {
    const i = this.queue.findIndex((x) => x.id === id);
    return i >= 0 ? i + 1 : '?';
  },

  async sendPrompt(item, options = {}) {
    const continueQueue = options.continueQueue !== false;
    this.currentManualSend = !continueQueue;
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
      this.currentManualSend = false;
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
  },

  waitForTurnCompletion() {
    return new Promise((resolve, reject) => {
      this.currentTurnResolve = resolve;
      this.currentTurnReject = reject;
    });
  },

  pause(message = 'Auto-send paused. Type /resume or click Resume to continue.') {
    this.countdownCancel = true;
    this.app.scheduledRunAt = null;
    this.app.state = 'paused';
    this.app.message = message;
    this.appendOutput(message, 'system');
    this.broadcastAll();
  },

  cancelPendingSend() {
    this.pause('Next prompt send cancelled. Click Resume to continue.');
  },

  async interruptCurrentTurn() {
    if (!this.currentTurnId || !this.app.sessionId) {
      return { ok: false, message: 'No running prompt to interrupt.' };
    }
    const turnId = this.currentTurnId;
    this.appendOutput('[turn] interrupt requested', 'system');
    await this.rpc.request('turn/interrupt', { threadId: this.app.sessionId, turnId }, 3000);
    this.pause('Running prompt interrupted. Click Resume to continue.');
    return { ok: true };
  },

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
  },

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
  },

  async setTheme(theme) {
    const value = theme === 'light' ? 'light' : 'dark';
    this.app.theme = value;
    await this.saveSettings();
    this.broadcastAll();
    return { ok: true, theme: value };
  },

  resume() {
    if (this.approval) {
      this.app.state = 'approval-required';
      this.app.message = 'Resolve approval request first';
      this.broadcastAll();
      return;
    }
    this.app.state = 'watching';
    this.app.scheduledRunAt = null;
    this.app.message = 'Auto-send resumed';
    this.appendOutput('[queue] resumed', 'system');
    this.broadcastAll();
    this.schedulePump(200);
  }
};
