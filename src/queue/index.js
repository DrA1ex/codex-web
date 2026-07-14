'use strict';

const { nowIso, randomId, lineCount, previewOf } = require('../shared/utils');
const { isQueuedCommandName } = require('../app/commands');
const { parseComposerCommand } = require('../app/command-parser');

const PENDING_LIKE_STATUSES = new Set(['pending', 'next']);
const QUEUE_STATUSES = new Set(['pending', 'next', 'sending', 'sent', 'completed', 'cancelled', 'failed', 'unknown', 'interrupted']);
const QUEUE_TRANSITIONS = new Map([
  ['pending', new Set(['next', 'sending', 'cancelled', 'completed'])],
  ['next', new Set(['pending', 'sending', 'cancelled', 'completed'])],
  ['sending', new Set(['sent', 'completed', 'failed', 'unknown', 'interrupted'])],
  ['sent', new Set(['completed', 'failed', 'unknown', 'interrupted'])],
  ['failed', new Set(['pending', 'completed'])],
  ['unknown', new Set(['pending', 'completed'])],
  ['cancelled', new Set(['pending', 'completed'])],
  ['interrupted', new Set(['pending', 'completed'])],
  ['completed', new Set()],
]);

function transitionQueueItem(item, nextStatus, options = {}) {
  if (!item || typeof item !== 'object') throw new Error('Queue item is required');
  const current = item.status || 'pending';
  if (!QUEUE_STATUSES.has(nextStatus)) throw new Error(`Unsupported queue status: ${nextStatus}`);
  if (current === nextStatus) return item;
  if (!options.force && !QUEUE_TRANSITIONS.get(current)?.has(nextStatus)) {
    throw new Error(`Invalid queue transition: ${current} -> ${nextStatus}`);
  }
  item.status = nextStatus;
  return item;
}


function isPendingLikeStatus(status) {
  return PENDING_LIKE_STATUSES.has(status);
}

function makeQueueItem(text) {
  const command = parseQueuedCommand(text);
  const item = {
    id: randomId(16),
    text,
    kind: command ? 'command' : 'prompt',
    command,
    status: 'pending',
    createdAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    lineCount: 0,
    preview: '',
    error: null,
    usage: null,
  };
  normalizeQueueItem(item);
  return item;
}
function normalizeQueueItem(item) {
  item.id = item.id || randomId(16);
  item.text = String(item.text || '');
  const command = parseQueuedCommand(item.text);
  item.kind = command ? 'command' : (item.kind || 'prompt');
  item.command = command || (item.kind === 'command' ? item.command || '' : null);
  item.status = item.status || 'pending';
  if (!QUEUE_STATUSES.has(item.status)) {
    item.error = item.error || `Recovered unsupported queue status: ${item.status}`;
    item.status = 'unknown';
  }
  item.createdAt = item.createdAt || nowIso();
  item.startedAt = item.startedAt || null;
  item.finishedAt = item.finishedAt || null;
  item.lineCount = lineCount(item.text);
  item.preview = previewOf(item.text);
  if (!Object.prototype.hasOwnProperty.call(item, 'error')) item.error = null;
  if (!Object.prototype.hasOwnProperty.call(item, 'usage')) item.usage = null;
  return item;
}
function countQueue(queue) {
  const counts = { total: queue.length, pending: 0, sending: 0, sent: 0, completed: 0, failed: 0, paused: 0, unknown: 0, cancelled: 0, interrupted: 0 };
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
    if (!['pending', 'next', 'failed', 'unknown', 'cancelled', 'interrupted'].includes(item.status)) throw new Error('Only pending, next, failed, unknown, cancelled, or interrupted items can be edited');
    const text = String(body.text || '');
    if (!text.trim()) throw new Error('Prompt is empty');
    item.text = text;
    transitionQueueItem(item, 'pending');
    item.startedAt = null;
    item.finishedAt = null;
    item.error = null;
    item.usage = null;
    normalizeQueueItem(item);
  } else if (body.action === 'duplicate') {
    const dup = makeQueueItem(item.text);
    const idx = queue.indexOf(item);
    queue.splice(idx + 1, 0, dup);
  } else if (body.action === 'markCompleted') {
    transitionQueueItem(item, 'completed');
    item.finishedAt = nowIso();
    item.error = null;
  } else if (body.action === 'retry') {
    if (!['failed', 'unknown', 'cancelled', 'interrupted'].includes(item.status)) throw new Error('Only failed, unknown, cancelled, or interrupted items can be retried');
    transitionQueueItem(item, 'pending');
    item.startedAt = null;
    item.finishedAt = null;
    item.error = null;
    item.usage = null;
  } else {
    throw new Error(`Unsupported queue action: ${body.action || '(missing)'}`);
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
  const parsed = parseComposerCommand(trimmed);
  if (!parsed || !parsed.ok || parsed.execution === 'queued') return null;
  return parsed.raw === parsed.command ? parsed.command : null;
}
function parseQueuedCommand(text) {
  const trimmed = String(text || '').trim();
  const parsed = parseComposerCommand(trimmed);
  if (!parsed || !parsed.ok || !isQueuedCommandName(parsed.command)) return null;
  return parsed.raw === parsed.command ? parsed.command : null;
}
function parseSteerCommand(text) {
  const trimmed = String(text || '').trim();
  const parsed = parseComposerCommand(trimmed);
  if (!parsed || (parsed.ok && !['/think', '/think!'].includes(parsed.command)) || (!parsed.ok && !['/think', '/think!'].includes(parsed.command))) return null;

  const command = parsed.command;
  const mode = command === '/think!' ? 'force' : 'soft';
  if (!parsed.ok) {
    return {
      ok: false,
      command,
      mode,
      message: command === '/think!'
        ? '/think! needs a follow-up prompt.'
        : '/think needs a note to send to the active prompt.',
    };
  }

  return { ok: true, command, mode, text: parsed.args.text };
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
  parseQueuedCommand,
  parseSteerCommand,
  QUEUE_STATUSES,
  transitionQueueItem,
};
