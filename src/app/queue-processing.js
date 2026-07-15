'use strict';

const {
  FINISHED_QUEUE_STATUSES,
  FAILURE_QUEUE_STATUSES,
  RUNNING_QUEUE_STATUSES,
  allHaveStatus,
  hasStatus,
} = require('./states');
const { waitForAvailableLimits } = require('./limit-wait');
const {
  isPendingLikeStatus,
  movePendingToNext: movePendingToNextItem,
  movePendingToFirst: movePendingToFirstItem,
} = require('../queue');

function cloneQueue(queue) {
  if (typeof structuredClone === 'function') return structuredClone(queue);
  return JSON.parse(JSON.stringify(queue));
}

async function waitUntilScheduledTime(ctx) {
  if (!ctx.app.scheduledRunAt) return false;

  const scheduledAt = Date.parse(ctx.app.scheduledRunAt);
  if (Number.isFinite(scheduledAt) && scheduledAt > Date.now()) {
    ctx.app.state = 'scheduled';
    ctx.app.message = `Queue scheduled for ${new Date(scheduledAt).toLocaleString()}`;
    ctx.broadcastAll();
    ctx.schedulePump(Math.min(
      Math.max(1000, scheduledAt - Date.now()),
      ctx.opts.watchInterval * 1000,
    ));
    return true;
  }

  const previousScheduledRunAt = ctx.app.scheduledRunAt;
  ctx.app.scheduledRunAt = null;
  try {
    await ctx.saveState();
  } catch (err) {
    ctx.app.scheduledRunAt = previousScheduledRunAt;
    throw err;
  }
  return false;
}

function updateIdleStateAfterQueueDrain(ctx) {
  const hasArchivedCompletion = Math.max(0, Number(ctx.completedArchiveTotal) || 0) > 0;
  const queueDrained = allHaveStatus(ctx.queue, FINISHED_QUEUE_STATUSES)
    || (ctx.queue.length === 0 && hasArchivedCompletion);
  if (queueDrained) {
    if (ctx.app.state !== 'done' && !hasStatus(ctx.queue, FAILURE_QUEUE_STATUSES)) {
      ctx.app.state = 'done';
      ctx.appendOutput('[queue] completed', 'system');
      ctx.broadcastAll();
      return;
    }

    if (!['paused', 'error', 'done'].includes(ctx.app.state)) {
      ctx.app.state = 'watching';
      ctx.broadcastAll();
    }

    return;
  }

  if (!['paused', 'error', 'done'].includes(ctx.app.state)) {
    ctx.app.state = 'watching';
    ctx.broadcastAll();
  }
}

module.exports = {
  reconcilePendingManualSend() {
    const pendingId = this.pendingManualSendItemId;
    if (!pendingId) return false;
    const stillPending = this.queue.some((item) => item.id === pendingId && isPendingLikeStatus(item.status));
    if (stillPending) return false;
    this.pendingManualSendItemId = null;
    if (!this.currentItemId && !this.currentTurnId) {
      this.currentManualSend = false;
      this.manualSendContinueQueue = false;
    }
    return true;
  },

  async movePendingToNext(item) {
    const previousQueue = cloneQueue(this.queue);
    const result = movePendingToNextItem(this.queue, item, this.currentItemId);
    this.queue = result.queue;

    try {
      await this.saveQueue();
    } catch (err) {
      this.queue = previousQueue;
      throw err;
    }
    this.appendOutput(`[queue] next #${item.id}`, 'system');
    this.broadcastAll();
    this.schedulePump(200);

    return { ok: true, item: result.item };
  },

  async movePendingToFirst(item) {
    const previousQueue = cloneQueue(this.queue);
    const result = movePendingToFirstItem(this.queue, item);
    this.queue = result.queue;

    try {
      await this.saveQueue();
    } catch (err) {
      this.queue = previousQueue;
      throw err;
    }
    this.broadcastAll();

    return { ok: true, item: result.item };
  },

  async pumpQueue() {
    if (this.shuttingDown) return;
    if (!this.app.sessionId) return;
    if (this.app.state === 'initializing' || this.app.state === 'selecting-session') return;
    if ((this.app.state === 'paused' && !this.app.scheduledRunAt) || this.app.state === 'approval-required') return;
    if (this.currentItemId || this.currentTurnId) return;
    if (hasStatus(this.queue, RUNNING_QUEUE_STATUSES)) return;

    this.reconcilePendingManualSend();
    const pending = this.queue.find((item) => isPendingLikeStatus(item.status));
    if (!pending) {
      updateIdleStateAfterQueueDrain(this);
      return;
    }

    if (await waitUntilScheduledTime(this)) return;
    if (await waitForAvailableLimits(this, 'auto-send')) return;

    const manualPending = this.pendingManualSendItemId === pending.id;
    if (manualPending) this.pendingManualSendItemId = null;
    await this.runCountdownAndSend(pending, { continueQueue: !manualPending });
  },
};
