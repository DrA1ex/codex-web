'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  makeQueueItem,
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
} = require('../src/queue');
const { item } = require('./helpers');

test('queue items are normalized, ordered, and counted', () => {
  const queueItem = makeQueueItem('first line\nsecond line');
  assert.equal(queueItem.status, 'pending');
  assert.equal(queueItem.lineCount, 2);
  assert.equal(queueItem.preview, 'first line');

  const normalized = normalizeQueueItem({ id: 'abc', text: '', status: 'failed' });
  assert.equal(normalized.id, 'abc');
  assert.equal(normalized.lineCount, 0);
  assert.equal(normalized.error, null);

  const ordered = normalizeQueueOrder([
    item('pending'),
    item('done', 'completed'),
    item('sent', 'sent'),
    item('next', 'next'),
  ]);
  assert.deepEqual(ordered.map((i) => i.id), ['done', 'sent', 'pending', 'next']);

  assert.deepEqual(countQueue([
    { status: 'pending' },
    { status: 'next' },
    { status: 'completed' },
    { status: 'custom' },
  ]), {
    total: 4,
    pending: 2,
    sending: 0,
    sent: 0,
    completed: 1,
    failed: 0,
    paused: 0,
    unknown: 0,
    cancelled: 0,
    interrupted: 0,
    custom: 1,
  });
});

test('standalone commands are parsed exactly', () => {
  assert.equal(parseExactCommand(' /pause\n'), '/pause');
  assert.equal(parseExactCommand('/approve-session'), '/approve-session');
  assert.equal(parseExactCommand('/compact'), null);
  assert.equal(parseQueuedCommand('/compact'), '/compact');
  assert.equal(parseQueuedCommand('/pause'), null);
  assert.equal(parseExactCommand('/send now'), null);
  assert.equal(parseExactCommand('hello'), null);

  const compact = makeQueueItem('/compact');
  assert.equal(compact.kind, 'command');
  assert.equal(compact.command, '/compact');
});

test('active prompt steering commands parse payloads and support no-arg force promotion', () => {
  assert.deepEqual(parseSteerCommand('/think focus on queue state'), {
    ok: true,
    command: '/think',
    mode: 'soft',
    text: 'focus on queue state',
  });
  assert.deepEqual(parseSteerCommand(' /think!  interrupt and fix it  '), {
    ok: true,
    command: '/think!',
    mode: 'force',
    text: 'interrupt and fix it',
  });
  assert.deepEqual(parseSteerCommand('/think'), {
    ok: false,
    command: '/think',
    mode: 'soft',
    message: '/think needs a note to send to the active prompt.',
  });
  assert.deepEqual(parseSteerCommand('/think!   '), {
    ok: true,
    command: '/think!',
    mode: 'force',
    text: '',
  });
  assert.equal(parseSteerCommand('/pause'), null);
  assert.equal(parseSteerCommand('hello'), null);
});

test('queue data helpers move, undo, clear, edit, duplicate, retry, and remove safely', () => {
  const active = item('active', 'sent');
  const first = item('first');
  const failed = item('failed', 'failed', {
    error: 'boom',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
  });
  const second = item('second');

  let queue = [first, active, failed, second];
  ({ queue } = movePendingToNext(queue, second, 'active'));
  assert.deepEqual(queue.map((i) => i.id), ['active', 'second', 'failed', 'first']);

  let result = updateQueueItemData(queue, { id: 'failed', action: 'edit', text: 'new\ntext' });
  ({ queue } = movePendingToFirst(queue, failed));
  assert.deepEqual(queue.map((i) => i.id), ['failed', 'active', 'second', 'first']);

  result = updateQueueItemData(queue, { id: 'failed', action: 'edit', text: 'new\ntext' });
  assert.equal(result.item.status, 'pending');
  assert.equal(result.item.error, null);
  assert.equal(result.item.lineCount, 2);

  result = updateQueueItemData(queue, { id: 'failed', action: 'duplicate' });
  assert.equal(queue.length, 5);
  assert.equal(queue[1].text, 'new\ntext');
  assert.notEqual(queue[1].id, 'failed');

  result = updateQueueItemData(queue, { id: 'failed', action: 'markCompleted' });
  assert.equal(result.item.status, 'completed');
  assert.equal(typeof result.item.finishedAt, 'string');

  result.item.status = 'failed';
  result.item.error = 'again';
  result.item.startedAt = '2026-01-01T00:00:00.000Z';
  result.item.finishedAt = '2026-01-01T00:01:00.000Z';
  result = updateQueueItemData(queue, { id: 'failed', action: 'retry' });
  assert.equal(result.item.status, 'pending');
  assert.equal(result.item.startedAt, null);
  assert.equal(result.item.finishedAt, null);

  result = undoLastPending(queue);
  assert.equal(result.item.id, 'first');
  queue = result.queue;

  result = clearPending(queue);
  assert.equal(result.removed >= 2, true);
  queue = result.queue;

  result = clearCompleted(queue);
  assert.equal(result.queue.some((i) => i.status === 'completed'), false);

  assert.throws(() => removeQueueItem([active], 'active', 'active'), /Cannot remove active prompt/);
  assert.throws(() => updateQueueItemData([item('done', 'completed')], { id: 'done', action: 'edit', text: 'x' }), /Only pending/);
});

test('reorderPendingItem reorders only pending slots and validates targets', () => {
  const queue = [item('running', 'sent'), item('first'), item('done', 'completed'), item('second'), item('third')];

  const byBefore = reorderPendingItem(queue, 'third', { beforeId: 'first' }).queue;
  assert.deepEqual(byBefore.map((i) => i.id), ['running', 'third', 'done', 'first', 'second']);

  const byDirection = reorderPendingItem(byBefore, 'second', { direction: 'up' }).queue;
  assert.deepEqual(byDirection.filter((i) => i.status === 'pending').map((i) => i.id), ['third', 'second', 'first']);

  const toEnd = reorderPendingItem(byDirection, 'third', { beforeId: null }).queue;
  assert.deepEqual(toEnd.filter((i) => i.status === 'pending').map((i) => i.id), ['second', 'first', 'third']);

  assert.throws(() => reorderPendingItem(queue, 'running', { beforeId: 'first' }), /Only pending/);
  assert.throws(() => reorderPendingItem(queue, 'third', { beforeId: 'done' }), /pending prompts/);
});
