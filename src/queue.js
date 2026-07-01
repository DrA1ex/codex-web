'use strict';

const { nowIso, randomId, lineCount, previewOf } = require('./utils');

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
  for (const item of queue) counts[item.status] = (counts[item.status] || 0) + 1;
  return counts;
}
function parseExactCommand(text) {
  const trimmed = String(text || '').trim();
  const commands = new Set(['/send', '/undo', '/clear', '/pause', '/resume', '/quit', '/help', '/approve', '/approve-session', '/decline', '/cancel']);
  return commands.has(trimmed) ? trimmed : null;
}

module.exports = {
  makeQueueItem,
  normalizeQueueItem,
  countQueue,
  parseExactCommand,
};
