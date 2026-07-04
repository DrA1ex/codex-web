'use strict';

const { nowIso, sleep } = require('../shared/utils');
const { mapApprovalPolicy, makeSandboxPolicy } = require('../codex/policies');
const {
  makeQueueItem,
  isPendingLikeStatus,
  normalizeQueueItem,
  parseExactCommand,
  parseQueuedCommand,
  parseSteerCommand,
} = require('../queue');
const {
  waitForAvailableLimits,
  setWaitingForLimits,
  setRefreshingLimits,
} = require('./limit-wait');
const { compactUsageOutput } = require('./usage');

function normalizePromptText(text) {
  return String(text || '').replace(/\r\n/g, '\n');
}

function shouldOnlyQueuePrompt(ctx) {
  return !!(
    ctx.app.state !== 'watching'
    || ctx.app.scheduledRunAt
    || ctx.hasActivePrompt()
    || ctx.currentItemId
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

function queueAddLabel(item) {
  return item.kind === 'command'
    ? `[queue] added #${item.id} · command ${item.command}`
    : `[queue] added #${item.id} · ${item.lineCount} lines`;
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

    if (this.isQueueProcessingActive() || this.hasActivePrompt()) {
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

    const steerCommand = parseSteerCommand(trimmed);
    if (steerCommand) {
      if (!steerCommand.ok) return { ok: false, message: steerCommand.message };
      return steerCommand.mode === 'force'
        ? await this.forceSteerActivePrompt(steerCommand.text)
        : await this.steerActivePrompt(steerCommand.text);
    }

    const command = parseExactCommand(trimmed);
    if (command) return await this.executeCommand(command);
    const queuedCommand = parseQueuedCommand(trimmed);
    if (!this.app.sessionId) throw new Error('No Codex session selected');

    const queueOnly = shouldOnlyQueuePrompt(this);
    const item = makeQueueItem(normalizedText);
    this.queue.push(item);

    await this.saveQueue();
    this.appendOutput(queueAddLabel(item), 'system');
    this.broadcastAll();

    if (queuedCommand) {
      if (!queueOnly) {
        this.app.state = 'watching';
        this.app.message = 'Command queued';
        this.broadcastAll();
      }
      this.schedulePump(200);
      return { ok: true, clearComposer: true, item };
    }

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
    if (item.kind === 'command') {
      await this.executeQueuedCommand(item, { continueQueue });
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
    this.createOutputGroupForItem(item);

    await this.beginQueueItemUsage(item);
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
      await this.recordQueueItemTurn(item, this.currentTurnId);

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

      await this.completeQueueItemUsage(item);
      if (this.currentOutputGroupId) {
        this.finishCurrentOutputGroup(item.status === 'failed' ? 'failed' : 'completed', item.error || null);
      }
      this.currentItemId = null;
      this.currentTurnId = null;
      this.currentOutputGroupId = null;
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

  async executeQueuedCommand(item, options = {}) {
    const continueQueue = options.continueQueue !== false;

    normalizeQueueItem(item);
    if (item.kind !== 'command' || !item.command) throw new Error('Queue item is not a command');

    this.currentManualSend = !continueQueue;
    item.status = 'sending';
    item.startedAt = nowIso();
    item.error = null;

    this.currentItemId = item.id;
    this.app.state = 'sending';
    this.app.message = `Running command ${item.command}`;
    if (item.command === '/compact') await this.beginQueuedCommandUsage(item);
    await this.saveQueue();
    this.appendOutput(`[command] #${this.visibleIndex(item.id)} ${item.command}`, 'system');
    this.broadcastAll();

    try {
      const commandResult = await this.runQueueCommand(item.command);
      item.status = 'completed';
      item.finishedAt = nowIso();
      if (item.command === '/compact') {
        const usage = await this.completeQueuedCommandUsage(item, commandResult);
        if (usage) this.appendOutput(compactUsageOutput(usage), 'system');
      }
      this.appendOutput(`[command] ${item.command} completed`, 'system');
      await this.saveQueue();
    } catch (err) {
      item.status = 'failed';
      item.finishedAt = nowIso();
      item.error = err.message;
      await this.saveQueue();
      this.appendOutput(`[error] command ${item.command} failed: ${err.message}`, 'error');
      this.pause('Auto-send paused after queued command failure. Type /resume after reviewing the error.');
    } finally {
      if (this.currentQueueCommandTimer) clearTimeout(this.currentQueueCommandTimer);
      this.currentQueueCommandTimer = null;
      this.currentQueueCommandResolve = null;
      this.currentQueueCommandReject = null;
      this.currentQueueCommand = null;
      this.currentItemId = null;
      this.currentManualSend = false;
      this.manualSendContinueQueue = false;
      await this.saveState();
      this.broadcastAll();
    }

    const failed = item.status === 'failed';
    if (!failed && continueQueue && !['paused', 'approval-required', 'error'].includes(this.app.state)) {
      this.app.state = 'watching';
      this.broadcastAll();
      this.schedulePump(200);
      return;
    }

    if (!failed && !continueQueue && !['paused', 'approval-required', 'error'].includes(this.app.state)) {
      this.app.state = 'paused';
      this.app.message = 'Manual command completed. Auto-send paused.';
      this.broadcastAll();
    }
  },

  async runQueueCommand(command) {
    switch (command) {
      case '/compact':
        return await this.runCompactCommand();
      default:
        throw new Error(`Unsupported queued command: ${command}`);
    }
  },

  async runCompactCommand() {
    if (!this.app.sessionId) throw new Error('No Codex session selected');
    const completion = this.waitForQueuedCommand('/compact');
    await this.rpc.request('thread/compact/start', { threadId: this.app.sessionId });
    return await completion;
  },

  waitForQueuedCommand(command) {
    return new Promise((resolve, reject) => {
      this.currentQueueCommand = command;
      this.currentQueueCommandResolve = resolve;
      this.currentQueueCommandReject = reject;
      this.currentQueueCommandTimer = setTimeout(() => {
        if (this.currentQueueCommand === command) reject(new Error(`${command} did not finish before timeout`));
      }, 10 * 60 * 1000);
      if (typeof this.currentQueueCommandTimer.unref === 'function') this.currentQueueCommandTimer.unref();
    });
  },

  waitForTurnCompletion() {
    return new Promise((resolve, reject) => {
      this.currentTurnResolve = resolve;
      this.currentTurnReject = reject;
    });
  },

};
