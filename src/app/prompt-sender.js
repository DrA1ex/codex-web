'use strict';

const { nowIso, sleep } = require('../shared/utils');
const { mapApprovalPolicy, makeSandboxPolicy } = require('../codex/policies');
const {
  makeQueueItem,
  isPendingLikeStatus,
  normalizeQueueItem,
  parseExactCommand,
} = require('../queue');
const {
  waitForAvailableLimits,
  setWaitingForLimits,
  setRefreshingLimits,
} = require('./limit-wait');

function normalizePromptText(text) {
  return String(text || '').replace(/\r\n/g, '\n');
}

function shouldOnlyQueuePrompt(ctx) {
  return !!(
    ctx.currentItemId
    || ctx.currentTurnId
    || ctx.isQueueProcessingActive()
    || ctx.queue.some((item) => isPendingLikeStatus(item.status))
  );
}

function createTurnStartParams(ctx, item) {
  const params = {
    threadId: ctx.app.sessionId,
    cwd: ctx.opts.projectDir,
    input: [{ type: 'text', text: item.text }],
    approvalPolicy: mapApprovalPolicy(ctx.opts.approvalPolicy),
    sandboxPolicy: makeSandboxPolicy(ctx.opts),
  };

  if (ctx.opts.model) params.model = ctx.opts.model;
  if (ctx.opts.effort) params.effort = ctx.opts.effort;

  return params;
}

function promptModelLabel(ctx) {
  const selected = ctx.opts.model || ctx.app.model || '';
  if (selected) return selected;
  return ctx.app.defaultModel ? `${ctx.app.defaultModel} (default)` : 'default';
}

function promptEffortLabel(ctx) {
  return ctx.opts.effort || ctx.app.effort || 'default';
}

function promptSendLabel(ctx, item) {
  return `[send] #${item.id} · ${item.lineCount} lines · model: ${promptModelLabel(ctx)} · effort: ${promptEffortLabel(ctx)}`;
}

function finishFailedPrompt(ctx, item, err) {
  item.finishedAt = nowIso();
  item.status = 'failed';
  item.error = err.message;

  if (ctx.turnStarted) {
    ctx.pause(`Error after turn/started: ${err.message}`);
  } else {
    ctx.pause(`turn/start failed before confirmation: ${err.message}`);
  }

  ctx.appendOutput(`[error] ${err.message}`, 'error');
}

function shouldContinueAfterPrompt(ctx, continueQueue) {
  return continueQueue || ctx.manualSendContinueQueue;
}

module.exports = {
  async sendItemNow(item) {
    if (this.shuttingDown) return undefined;
    if (!this.app.sessionId) throw new Error('No Codex session selected');
    if (this.app.state === 'countdown') {
      throw new Error('A prompt is already scheduled to send');
    }

    if (this.currentManualSend && (this.currentItemId || this.currentTurnId)) {
      return await this.movePendingToNext(item);
    }

    if (this.currentManualSend) {
      throw new Error('A prompt is already scheduled to send');
    }

    if (this.isQueueProcessingActive()) {
      return await this.movePendingToNext(item);
    }

    if (this.currentItemId || this.currentTurnId) throw new Error('A prompt is already running');
    if (!item || !isPendingLikeStatus(item.status)) throw new Error('Only pending prompts can be sent');

    this.currentManualSend = true;

    try {
      await this.movePendingToFirst(item);
      this.app.state = 'watching';
      this.app.message = 'Manual send requested';
      this.broadcastAll();

      if (this.rateLimits.status === 'unknown' || this.rateLimits.refreshing) await this.pollRateLimits();

      if (this.rateLimits.status === 'limited') {
        setWaitingForLimits(this.app, this.rateLimits, this.opts.watchInterval);
        this.broadcastAll();
        return { ok: true, item };
      }

      if (this.rateLimits.refreshing) {
        setRefreshingLimits(this.app, 'manual send');
        this.broadcastAll();
        return { ok: true, item };
      }

      if (this.rateLimits.status === 'unknown') {
        this.app.state = 'waiting-limits';
        this.app.message = 'Limits unknown; retrying before manual send';
        this.broadcastAll();
        return { ok: true, item };
      }

      await this.runCountdownAndSend(item, { continueQueue: false });
    } finally {
      this.manualSendContinueQueue = false;
      this.currentManualSend = false;
      this.broadcastAll();
    }

    return { ok: true, item };
  },

  async sendComposerNow(text) {
    const normalizedText = normalizePromptText(text);
    const trimmed = normalizedText.trim();

    if (!trimmed) return { ok: false, message: 'Prompt is empty' };

    const command = parseExactCommand(trimmed);
    if (command) return await this.executeCommand(command);
    if (!this.app.sessionId) throw new Error('No Codex session selected');

    const queueOnly = shouldOnlyQueuePrompt(this);
    const item = makeQueueItem(normalizedText);
    this.queue.push(item);

    await this.saveQueue();
    this.appendOutput(`[queue] added #${item.id} · ${item.lineCount} lines`, 'system');
    this.broadcastAll();

    if (queueOnly || await waitForAvailableLimits(this, 'manual send')) {
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
    normalizeQueueItem(item);
    if (item.status === 'pending') {
      item.status = 'next';
      await this.saveQueue();
    }
    this.app.state = 'countdown';
    this.broadcastAll();

    const resetNext = async () => {
      if (item.status !== 'next') return;
      item.status = 'pending';
      await this.saveQueue();
      this.broadcastAll();
    };

    const idx = this.visibleIndex(item.id);
    for (let secondsLeft = this.opts.countdown; secondsLeft > 0; secondsLeft--) {
      if (this.app.state === 'paused' || this.countdownCancel) {
        await resetNext();
        return;
      }

      this.appendOutput(`Sending prompt #${idx} in ${secondsLeft}…`, 'system');
      await sleep(1000);
    }

    if (this.app.state === 'paused' || this.countdownCancel) {
      await resetNext();
      return;
    }
    await this.sendPrompt(item, { continueQueue });
  },

  visibleIndex(id) {
    const index = this.queue.findIndex((item) => item.id === id);
    return index >= 0 ? index + 1 : '?';
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
    this.appendOutput(promptSendLabel(this, item), 'send');
    this.appendOutput(`[prompt]\n${item.text}`, 'prompt');
    this.broadcastAll();

    try {
      const result = await this.rpc.request('turn/start', createTurnStartParams(this, item));
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
      finishFailedPrompt(this, item, err);
      await this.saveQueue();
    } finally {
      const continueAfterPrompt = shouldContinueAfterPrompt(this, continueQueue);

      this.currentItemId = null;
      this.currentTurnId = null;
      this.currentManualSend = false;
      this.manualSendContinueQueue = false;
      this.currentTurnResolve = null;
      this.currentTurnReject = null;
      this.turnStarted = false;

      await this.saveState();
      this.broadcastAll();

      if (continueAfterPrompt && !['paused', 'approval-required', 'error'].includes(this.app.state)) {
        this.app.state = 'watching';
        this.broadcastAll();
        this.schedulePump(1500);
        return;
      }

      if (!continueAfterPrompt && !['paused', 'approval-required', 'error'].includes(this.app.state)) {
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

};
