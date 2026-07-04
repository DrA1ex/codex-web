'use strict';

const {
  isPendingLikeStatus,
  makeQueueItem,
  undoLastPending,
  clearPending: clearPendingItems,
  clearCompleted: clearCompletedItems,
  updateQueueItemData,
  removeQueueItem: removeQueueItemData,
  reorderPendingItem,
  parseExactCommand,
  parseQueuedCommand,
} = require('../../queue');
const { commandHelpPayload } = require('../commands');

const COMPLETED_ARCHIVE_INITIAL_COUNT = 10;
const COMPLETED_ARCHIVE_PAGE_SIZE = 50;

function queueItemTime(item) {
  const time = new Date(item?.finishedAt || item?.createdAt || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function completedQueueEntries(queue) {
  return queue
    .map((item, index) => ({ item, index, time: queueItemTime(item) }))
    .filter((entry) => entry.item.status === 'completed')
    .sort((left, right) => left.time - right.time || left.index - right.index);
}

function completedQueuePage(queue, before = null, limit = COMPLETED_ARCHIVE_INITIAL_COUNT) {
  const entries = completedQueueEntries(queue);
  if (!entries.length) {
    return { items: [], hasMore: false, cursor: null, totalCompleted: 0 };
  }

  let end = entries.length;
  if (before?.id) {
    const beforeIndex = entries.findIndex((entry) => entry.item.id === before.id);
    if (beforeIndex >= 0) {
      end = beforeIndex;
    } else {
      const beforeTime = Date.parse(before.finishedAt || before.createdAt || '');
      if (!Number.isFinite(beforeTime)) end = 0;
      else {
        const timeIndex = entries.findIndex((entry) => entry.time >= beforeTime);
        end = timeIndex >= 0 ? timeIndex : entries.length;
      }
    }
  }

  const pageLimit = Math.max(1, Math.min(200, Number(limit) || COMPLETED_ARCHIVE_INITIAL_COUNT));
  const start = Math.max(0, end - pageLimit);
  const items = entries.slice(start, end).map((entry) => entry.item);

  return {
    items,
    hasMore: start > 0,
    cursor: items[0] ? {
      id: items[0].id,
      finishedAt: items[0].finishedAt || null,
    } : null,
    totalCompleted: entries.length,
  };
}

module.exports = {
  async addPrompt(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return { ok: false, message: 'Prompt is empty' };
    const command = parseExactCommand(trimmed);
    if (command) return await this.executeCommand(command);
    const queuedCommand = parseQueuedCommand(trimmed);
    const item = makeQueueItem(String(text).replace(/\r\n/g, '\n'));
    this.queue.push(item);
    await this.saveQueue();
    this.app.state = this.app.state === 'done' ? 'watching' : this.app.state;
    this.appendOutput(queuedCommand ? `[queue] added #${item.id} · command ${queuedCommand}` : `[queue] added #${item.id} · ${item.lineCount} lines`, 'system');
    this.broadcastAll();
    this.schedulePump(200);
    return { ok: true, clearComposer: true, item };
  },

  canScheduleQueue() {
    const hasPending = this.queue.some((i) => isPendingLikeStatus(i.status));
    const hasSchedule = !!this.app.scheduledRunAt;
    return !!this.app.sessionId && (hasPending || hasSchedule) && !this.currentItemId && !this.currentTurnId && !this.approval && (this.app.state === 'paused' || this.app.state === 'waiting-limits' || this.app.state === 'scheduled');
  },

  async setQueueSchedule(value) {
    if (!this.canScheduleQueue()) throw new Error('Queue can be scheduled only when it is paused, scheduled, or waiting for limits.');
    if (!this.queue.some((i) => isPendingLikeStatus(i.status))) throw new Error('Queue has no pending prompts to schedule.');
    const ts = Date.parse(String(value || ''));
    if (!Number.isFinite(ts)) throw new Error('Invalid schedule time.');
    if (ts <= Date.now()) throw new Error('Schedule time must be in the future.');
    this.app.scheduledRunAt = new Date(ts).toISOString();
    this.app.state = 'scheduled';
    this.app.message = `Queue scheduled for ${new Date(ts).toLocaleString()}`;
    await this.saveState();
    this.appendOutput(`[queue] scheduled ${this.app.scheduledRunAt}`, 'system');
    this.broadcastAll();
    this.schedulePump(Math.min(Math.max(1000, ts - Date.now()), this.opts.watchInterval * 1000));
    return { ok: true, scheduledRunAt: this.app.scheduledRunAt };
  },

  async resetQueueSchedule() {
    this.clearPumpTimer();
    this.app.scheduledRunAt = null;
    if (this.app.state === 'scheduled') this.app.state = 'paused';
    this.app.message = 'Queue schedule reset';
    await this.saveState();
    this.appendOutput('[queue] schedule reset', 'system');
    this.broadcastAll();
    return { ok: true };
  },

  async cancelQueueRun() {
    this.clearPumpTimer();
    this.countdownCancel = true;
    this.app.scheduledRunAt = null;
    this.app.state = 'paused';
    this.app.message = 'Queue cancelled';
    await this.saveState();
    this.appendOutput('[queue] cancelled', 'system');
    this.broadcastAll();
    return { ok: true };
  },

  async executeCommand(command) {
    switch (command) {
      case '/send':
        return { ok: false, message: 'Type a prompt and press Cmd+Enter or click Add to queue. /send is accepted only as a standalone command, so there is no prompt body to enqueue.' };
      case '/undo': return await this.undoLast();
      case '/clear': await this.clearPending(); return { ok: true, clearComposer: true };
      case '/pause': this.pause(); return { ok: true, clearComposer: true };
      case '/resume': this.resume(); return { ok: true, clearComposer: true };
      case '/quit': await this.shutdown('quit command'); return { ok: true, clearComposer: true };
      case '/help': return { ok: true, clearComposer: true, help: { commands: commandHelpPayload() } };
      case '/approve': await this.respondApproval('accept'); return { ok: true, clearComposer: true };
      case '/approve-session': await this.respondApproval('accept-for-session'); return { ok: true, clearComposer: true };
      case '/decline': await this.respondApproval('decline'); return { ok: true, clearComposer: true };
      case '/cancel': await this.respondApproval('cancel'); return { ok: true, clearComposer: true };
      default: return { ok: false, message: `Unknown command: ${command}` };
    }
  },

  async undoLast() {
    const result = undoLastPending(this.queue);
    this.queue = result.queue;
    if (!result.item) return { ok: false, message: 'No pending prompt to undo' };
    await this.saveQueue();
    this.appendOutput(`[queue] undo #${result.item.id}`, 'system');
    this.broadcastAll();
    return { ok: true, composerText: result.item.text };
  },

  async clearPending() {
    const result = clearPendingItems(this.queue);
    this.queue = result.queue;
    await this.saveQueue();
    this.appendOutput(`[queue] cleared ${result.removed} pending prompt(s)`, 'system');
    this.broadcastAll();
  },

  async clearCompleted() {
    const result = clearCompletedItems(this.queue);
    this.queue = result.queue;
    await this.saveQueue();
    this.appendOutput(`[queue] cleared ${result.removed} completed prompt(s)`, 'system');
    this.broadcastAll();
  },

  completedArchiveSnapshot() {
    return completedQueuePage(this.queue, null, COMPLETED_ARCHIVE_INITIAL_COUNT);
  },

  async loadCompletedArchivePage(body = {}) {
    const before = body.before || null;
    return completedQueuePage(this.queue, before, body.limit || COMPLETED_ARCHIVE_PAGE_SIZE);
  },

  async updateQueueItem(body) {
    if (body.action === 'sendNow') {
      const item = this.queue.find((i) => i.id === body.id);
      if (!item) throw new Error('Queue item not found');
      return await this.sendItemNow(item);
    }
    const result = updateQueueItemData(this.queue, body);
    this.queue = result.queue;
    await this.saveQueue();
    this.broadcastAll();
    this.schedulePump(200);
    return { ok: true, item: result.item };
  },

  async removeQueueItem(id) {
    const result = removeQueueItemData(this.queue, id, this.currentItemId);
    this.queue = result.queue;
    await this.saveQueue();
    this.broadcastAll();
  },

  async reorderQueueItem(id, body = {}) {
    const result = reorderPendingItem(this.queue, id, body);
    this.queue = result.queue;
    await this.saveQueue();
    this.broadcastAll();
  }
};
