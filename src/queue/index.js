'use strict';

const { nowIso, randomId, lineCount, previewOf } = require('../shared/utils');

const PENDING_LIKE_STATUSES = new Set(['pending', 'next']);

function isPendingLikeStatus(status) {
  return PENDING_LIKE_STATUSES.has(status);
}

function makeQueueItem(text) {
  const item = {
    id: randomId(4),
    text,
    status: 'pending',
    createdAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    lineCount: 0,
    preview: '',
    error: null,
  };
  normalizeQueueItem(item);
  return item;
}
function normalizeQueueItem(item) {
  item.id = item.id || randomId(4);
  item.text = String(item.text || '');
  item.status = item.status || 'pending';
  item.createdAt = item.createdAt || nowIso();
  item.startedAt = item.startedAt || null;
  item.finishedAt = item.finishedAt || null;
  item.lineCount = lineCount(item.text);
  item.preview = previewOf(item.text);
  if (!Object.prototype.hasOwnProperty.call(item, 'error')) item.error = null;
  return item;
}
function countQueue(queue) {
  const counts = { total: queue.length, pending: 0, sending: 0, sent: 0, completed: 0, failed: 0, paused: 0, unknown: 0, cancelled: 0 };
  for (const item of queue) {
    if (item.status === 'next') counts.pending += 1;
    else counts[item.status] = (counts[item.status] || 0) + 1;
  }
  return counts;
}
function queueStatusPriority(item) {
  return item.status === 'completed' ? 0 : (isPendingLikeStatus(item.status) ? 2 : 1);
}
function normalizeQueueOrder(queue) {
  return queue
    .map((item, index) => ({ item, index }))
    .sort((a, b) => queueStatusPriority(a.item) - queueStatusPriority(b.item) || a.index - b.index)
    .map((entry) => entry.item);
}
function movePendingToNext(queue, item, currentItemId) {
  if (!item || !isPendingLikeStatus(item.status)) throw new Error('Only pending prompts can be sent');
  queue = normalizeQueueOrder(queue);
  const from = queue.indexOf(item);
  if (from < 0) throw new Error('Queue item not found');
  let target = 0;
  const runningIndex = queue.findIndex((i) => i.id === currentItemId || i.status === 'sending' || i.status === 'sent');
  if (runningIndex >= 0) target = runningIndex + 1;
  queue.splice(from, 1);
  if (from < target) target -= 1;
  queue.splice(Math.max(0, target), 0, item);
  return { queue, item };
}
function movePendingToFirst(queue, item) {
  if (!item || !isPendingLikeStatus(item.status)) throw new Error('Only pending prompts can be sent');
  const from = queue.indexOf(item);
  if (from < 0) throw new Error('Queue item not found');
  if (from === 0) return { queue, item };
  queue.splice(from, 1);
  queue.splice(0, 0, item);
  return { queue, item };
}
function undoLastPending(queue) {
  for (let i = queue.length - 1; i >= 0; i--) {
    if (isPendingLikeStatus(queue[i].status)) {
      const [item] = queue.splice(i, 1);
      return { queue, item };
    }
  }
  return { queue, item: null };
}
function clearPending(queue) {
  const before = queue.length;
  const next = queue.filter((i) => !isPendingLikeStatus(i.status));
  return { queue: next, removed: before - next.length };
}
function clearCompleted(queue) {
  const before = queue.length;
  const next = queue.filter((i) => i.status !== 'completed');
  return { queue: next, removed: before - next.length };
}
function updateQueueItemData(queue, body) {
  const item = queue.find((i) => i.id === body.id);
  if (!item) throw new Error('Queue item not found');
  if (body.action === 'edit') {
    if (!['pending', 'next', 'failed', 'unknown', 'cancelled'].includes(item.status)) throw new Error('Only pending/failed/unknown/cancelled items can be edited');
    item.text = String(body.text || '');
    item.status = 'pending';
    item.error = null;
    normalizeQueueItem(item);
  } else if (body.action === 'duplicate') {
    const dup = makeQueueItem(item.text);
    const idx = queue.indexOf(item);
    queue.splice(idx + 1, 0, dup);
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
  return { queue, item };
}
function removeQueueItem(queue, id, currentItemId) {
  const idx = queue.findIndex((i) => i.id === id);
  if (idx < 0) throw new Error('Queue item not found');
  const item = queue[idx];
  if (item.id === currentItemId) throw new Error('Cannot remove active prompt');
  queue.splice(idx, 1);
  return { queue, item };
}
function reorderPendingItem(queue, id, body = {}) {
  const idx = queue.findIndex((i) => i.id === id);
  if (idx < 0) throw new Error('Queue item not found');
  const item = queue[idx];
  if (!isPendingLikeStatus(item.status)) throw new Error('Only pending prompts can be reordered');
  const pending = queue.filter((i) => isPendingLikeStatus(i.status));
  const fromPending = pending.findIndex((i) => i.id === id);
  if (fromPending < 0) throw new Error('Queue item not found');
  pending.splice(fromPending, 1);
  let toPending = fromPending;
  if (Object.prototype.hasOwnProperty.call(body, 'beforeId')) {
    toPending = pending.length;
    if (body.beforeId) {
      const beforeItem = queue.find((i) => i.id === body.beforeId);
      if (!beforeItem || !isPendingLikeStatus(beforeItem.status)) throw new Error('Can reorder only around pending prompts');
      const beforePending = pending.findIndex((i) => i.id === body.beforeId);
      if (beforePending >= 0) toPending = beforePending;
    }
  } else if (body.direction) {
    toPending = body.direction === 'up' ? Math.max(0, fromPending - 1) : Math.min(pending.length, fromPending + 1);
  }
  pending.splice(toPending, 0, item);
  let pendingIndex = 0;
  return {
    queue: queue.map((queueItem) => isPendingLikeStatus(queueItem.status) ? pending[pendingIndex++] : queueItem),
    item,
  };
}
function parseExactCommand(text) {
  const trimmed = String(text || '').trim();
  const commands = new Set(['/send', '/undo', '/clear', '/pause', '/resume', '/quit', '/help', '/approve', '/approve-session', '/decline', '/cancel']);
  return commands.has(trimmed) ? trimmed : null;
}

module.exports = {
  makeQueueItem,
  isPendingLikeStatus,
  normalizeQueueItem,
  normalizeQueueOrder,
  countQueue,
  movePendingToNext,
  movePendingToFirst,
  undoLastPending,
  clearPending,
  clearCompleted,
  updateQueueItemData,
  removeQueueItem,
  reorderPendingItem,
  parseExactCommand,
};
