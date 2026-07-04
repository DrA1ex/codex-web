'use strict';

const {
  PROCESSING_STATES,
  SESSION_CHANGE_RUNNING_STATES,
  SESSION_CHANGE_BLOCKED_STATES,
  PENDING_QUEUE_STATUSES,
  RUNNING_QUEUE_STATUSES,
  hasStatus,
} = require('./states');

module.exports = {
  schedulePump(delay = 0) {
    this.clearPumpTimer();

    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this.pumpQueue().catch((err) => this.setError(err.message));
    }, delay);

    if (typeof this.pumpTimer.unref === 'function') this.pumpTimer.unref();
  },

  clearPumpTimer() {
    if (!this.pumpTimer) return false;

    clearTimeout(this.pumpTimer);
    this.pumpTimer = null;
    return true;
  },

  isQueueProcessingActive() {
    if (this.currentItemId || this.currentTurnId) return true;
    return PROCESSING_STATES.has(this.app.state);
  },

  hasActivePrompt() {
    return !!(
      this.currentItemId
      || this.currentTurnId
      || hasStatus(this.queue, RUNNING_QUEUE_STATUSES)
    );
  },

  canChangeSession() {
    if (!this.app.sessionId) return false;
    if (this.approval) return false;
    if (this.currentItemId || this.currentTurnId) return false;
    if (SESSION_CHANGE_BLOCKED_STATES.has(this.app.state)) return false;
    if (SESSION_CHANGE_RUNNING_STATES.has(this.app.state)) return false;
    if (hasStatus(this.queue, RUNNING_QUEUE_STATUSES)) return false;

    if (this.app.state === 'scheduled') return false;
    return !(this.app.state === 'watching' && hasStatus(this.queue, PENDING_QUEUE_STATUSES));
  },

  cancelSessionChange() {
    if (!this.app.sessionId || this.app.state !== 'selecting-session') return {ok: true};

    this.app.state = this.sessionPickerReturnState || 'paused';
    this.sessionPickerReturnState = null;
    this.app.message = 'Session unchanged';
    this.broadcastAll();

    if (!['paused', 'done', 'error'].includes(this.app.state)) {
      this.schedulePump(200);
    }

    return {ok: true};
  },

  pause(message = 'Auto-send paused. Type /resume or click Resume to continue.') {
    this.clearPumpTimer();
    this.countdownCancel = true;
    this.manualSendContinueQueue = false;
    this.app.scheduledRunAt = null;
    this.app.state = 'paused';
    this.app.message = message;
    this.appendOutput(message, 'system');
    this.broadcastAll();
  },

  cancelPendingSend() {
    this.manualSendContinueQueue = false;
    this.currentManualSend = false;
    this.pause('Next prompt send cancelled. Click Resume to continue.');
  },

  async interruptCurrentTurn() {
    if (!this.currentTurnId || !this.app.sessionId) {
      return {ok: false, message: 'No running prompt to interrupt.'};
    }

    const turnId = this.currentTurnId;
    this.appendOutput('[turn] interrupt requested', 'system');
    await this.rpc.request('turn/interrupt', {threadId: this.app.sessionId, turnId}, 3000);
    this.pause('Running prompt interrupted. Click Resume to continue.');

    return {ok: true};
  },

  resume() {
    this.clearPumpTimer();

    if (this.approval) {
      this.app.state = 'approval-required';
      this.app.message = 'Resolve approval request first';
      this.broadcastAll();
      return;
    }

    if (this.currentManualSend && (this.currentItemId || this.currentTurnId)) {
      this.manualSendContinueQueue = true;
      const item = this.queue.find((queueItem) => queueItem.id === this.currentItemId);

      this.app.state = item?.status === 'sending' ? 'sending' : 'streaming';
      this.app.message = 'Queue will resume after current prompt';
      this.appendOutput('[queue] will resume after current prompt', 'system');
      this.broadcastAll();
      return;
    }

    this.app.state = 'watching';
    this.app.scheduledRunAt = null;
    this.app.message = 'Auto-send resumed';
    this.appendOutput('[queue] resumed', 'system');
    this.broadcastAll();
    this.schedulePump(200);
  },

  setError(message) {
    this.clearPumpTimer();
    this.app.state = 'error';
    this.app.message = message;
    this.appendOutput(`[error] ${message}`, 'error');
    this.eventLog('error', message);
    this.broadcastAll();
  },

  async shutdown(reason = 'shutdown') {
    if (this.shuttingDown) return;

    this.clearPumpTimer();
    if (this.usageRefreshTimer) clearTimeout(this.usageRefreshTimer);
    if (this.currentQueueCommandTimer) clearTimeout(this.currentQueueCommandTimer);
    this.usageRefreshTimer = null;
    this.currentQueueCommandTimer = null;
    this.shuttingDown = true;
    this.app.state = 'shutting-down';
    this.app.message = reason;
    this.broadcastAll();
    this.eventLog('info', `shutdown ${reason}`);

    try {
      if (this.currentTurnId && this.app.sessionId) {
        await this.rpc.request('turn/interrupt', {
          threadId: this.app.sessionId,
          turnId: this.currentTurnId,
        }, 3000).catch(() => {});
      }
    } catch (_) {
    }

    try {
      await this.saveQueue();
    } catch (_) {
    }
    try {
      await this.saveState();
    } catch (_) {
    }
    try {
      await this.rpc.stop();
    } catch (_) {
    }

    for (const client of this.clients) {
      try {
        client.res.write('event: done\ndata: {}\n\n');
        client.res.end();
      } catch (_) {
      }
    }

    this.clients.clear();
    try {
      if (this.server) this.server.close();
    } catch (_) {
    }
    this.releaseLock();
    setTimeout(() => process.exit(0), 100).unref();
  },
};
