'use strict';

const { nowIso, randomId } = require('../shared/utils');
const { isPendingLikeStatus } = require('../queue');

const UNDO_STACK_LIMIT = 5;
const STEER_SENT_GRACE_MS = 30_000;

function timeMs(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : 0;
}

function sentSteerAgeMs(action, now = Date.now()) {
  return now - timeMs(action?.sentAt);
}

module.exports = {
  recordUndoAction(action) {
    if (!action || !action.type) return null;
    if (!Array.isArray(this.undoActions)) this.undoActions = [];
    const entry = {
      id: randomId(5),
      createdAt: nowIso(),
      ...action,
    };
    this.undoActions.push(entry);
    if (this.undoActions.length > UNDO_STACK_LIMIT) {
      this.undoActions.splice(0, this.undoActions.length - UNDO_STACK_LIMIT);
    }
    return entry;
  },

  recordPendingUndo(item) {
    if (!item?.id) return null;
    return this.recordUndoAction({
      type: 'pending',
      queueItemId: item.id,
      text: item.text,
    });
  },

  recordSteerUndo(action) {
    return this.recordUndoAction({
      type: 'steer',
      status: 'waiting',
      ...action,
    });
  },

  removeUndoAction(actionOrId) {
    if (!Array.isArray(this.undoActions)) return null;
    const id = typeof actionOrId === 'string' ? actionOrId : actionOrId?.id;
    const index = this.undoActions.findIndex((action) => action.id === id);
    if (index < 0) return null;
    const [removed] = this.undoActions.splice(index, 1);
    return removed;
  },

  forgetUndoAction(actionOrId) {
    return this.removeUndoAction(actionOrId);
  },

  undoActionQueueItem(action) {
    if (!action?.queueItemId) return null;
    return this.queue.find((item) => item.id === action.queueItemId) || null;
  },

  undoActionOutputEntry(action) {
    if (!action?.outputId) return null;
    return this.output.find((entry) => entry.id === action.outputId) || null;
  },

  hasRecentSteerUndoAction(now = Date.now()) {
    if (!Array.isArray(this.undoActions)) return false;
    return this.undoActions.some((action) => {
      if (action?.type !== 'steer') return false;
      if (action.status === 'waiting') return Boolean(this.undoActionOutputEntry(action));
      if (action.status === 'sent') {
        return Boolean(this.undoActionOutputEntry(action)) && sentSteerAgeMs(action, now) < STEER_SENT_GRACE_MS;
      }
      return false;
    });
  },

  canUndoAction(now = Date.now()) {
    if (this.queue.some((item) => isPendingLikeStatus(item.status))) return true;
    return this.hasRecentSteerUndoAction(now);
  },

  undoSentSteerAgeMs: sentSteerAgeMs,
  STEER_SENT_GRACE_MS,
};
