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

  ctx.app.scheduledRunAt = null;
  await ctx.saveState();
  return false;
}

function updateIdleStateAfterQueueDrain(ctx) {
  if (allHaveStatus(ctx.queue, FINISHED_QUEUE_STATUSES)) {
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
    if (this.app.state === 'initializing' || this.app.state === 'selecting-session') return;
    if ((this.app.state === 'paused' && !this.app.scheduledRunAt) || this.app.state === 'approval-required') return;
    if (this.currentItemId || this.currentTurnId) return;
    if (hasStatus(this.queue, RUNNING_QUEUE_STATUSES)) return;

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
