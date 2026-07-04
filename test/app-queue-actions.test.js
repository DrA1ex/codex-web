'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { item, makeAppWithQueue } = require('./helpers');

test('addPrompt normalizes CRLF text, executes immediate commands, and queues queue commands', async () => {
  const app = makeAppWithQueue([]);
  const commands = [];
  app.executeCommand = async (command) => { commands.push(command); return { ok: true, clearComposer: true }; };

  assert.deepEqual(await app.addPrompt('   '), { ok: false, message: 'Prompt is empty' });

  const commandResult = await app.addPrompt('/pause');
  assert.deepEqual(commandResult, { ok: true, clearComposer: true });
  assert.deepEqual(commands, ['/pause']);
  assert.equal(app.queue.length, 0);

  const compactResult = await app.addPrompt('/compact');
  assert.equal(compactResult.ok, true);
  assert.equal(compactResult.item.kind, 'command');
  assert.equal(compactResult.item.command, '/compact');
  assert.equal(app.queue.length, 1);
  assert.match(app.output.at(-1).text, /command \/compact/);

  const result = await app.addPrompt('one\r\ntwo');
  assert.equal(result.ok, true);
  assert.equal(result.item.text, 'one\ntwo');
  assert.equal(result.item.lineCount, 2);
  assert.equal(app.queue.length, 2);
  assert.equal(app.lastScheduledDelay, 200);
});

test('help command returns structured command reference', async () => {
  const app = makeAppWithQueue([]);

  const result = await app.executeCommand('/help');

  assert.equal(result.ok, true);
  assert.equal(result.clearComposer, true);
  assert.ok(Array.isArray(result.help.commands));
  assert.ok(result.help.commands.some((entry) => entry.command === '/think <text>' && /active prompt/i.test(entry.short)));
  assert.ok(result.help.commands.some((entry) => entry.command === '/think! <text>' && /interrupt/i.test(entry.short)));
  assert.ok(result.help.commands.some((entry) => entry.command === '/compact' && /Compact/i.test(entry.short)));
  assert.ok(result.help.commands.every((entry) => entry.details && entry.examples?.length));
});

test('reorderQueueItem reorders only pending slots and preserves non-pending positions', async () => {
  const running = item('running', 'sent');
  const first = item('first');
  const done = item('done', 'completed');
  const second = item('second');
  const third = item('third');
  const app = makeAppWithQueue([running, first, done, second, third]);

  await app.reorderQueueItem('third', { beforeId: 'first' });

  assert.deepEqual(app.queue.map((i) => i.id), ['done', 'running', 'third', 'first', 'second']);
  assert.deepEqual(app.queue.map((i) => i.status), ['completed', 'sent', 'pending', 'pending', 'pending']);
});

test('reorderQueueItem rejects moving non-pending items or targeting non-pending items', async () => {
  const app = makeAppWithQueue([item('active', 'sent'), item('a'), item('done', 'completed'), item('b')]);

  await assert.rejects(() => app.reorderQueueItem('active', { beforeId: 'a' }), /Only pending/);
  await assert.rejects(() => app.reorderQueueItem('b', { beforeId: 'done' }), /pending prompts/);
});

test('reorderQueueItem supports explicit move to end of pending segment', async () => {
  const app = makeAppWithQueue([item('a'), item('done', 'completed'), item('b'), item('c')]);

  await app.reorderQueueItem('a', { beforeId: null });

  assert.deepEqual(app.queue.map((i) => i.id), ['done', 'b', 'c', 'a']);
});

test('queue scheduling requires paused pending queue and stores future schedule', async () => {
  const app = makeAppWithQueue([item('pending')]);
  app.app.state = 'paused';
  const future = new Date(Date.now() + 60_000).toISOString();

  const result = await app.setQueueSchedule(future);

  assert.equal(result.ok, true);
  assert.equal(app.app.state, 'scheduled');
  assert.equal(app.app.scheduledRunAt, future);
  assert.equal(app.lastScheduledDelay >= 1000, true);

  await app.resetQueueSchedule();
  assert.equal(app.app.state, 'paused');
  assert.equal(app.app.scheduledRunAt, null);
});

test('queue schedule validation rejects missing session, no pending, invalid, and past times', async () => {
  const noSession = makeAppWithQueue([item('pending')]);
  noSession.app.state = 'paused';
  noSession.app.sessionId = null;
  await assert.rejects(() => noSession.setQueueSchedule(new Date(Date.now() + 60_000).toISOString()), /paused, scheduled, or waiting/);

  const noPending = makeAppWithQueue([item('done', 'completed')]);
  noPending.app.state = 'scheduled';
  noPending.app.scheduledRunAt = new Date(Date.now() + 60_000).toISOString();
  await assert.rejects(() => noPending.setQueueSchedule(new Date(Date.now() + 60_000).toISOString()), /no pending/);

  const app = makeAppWithQueue([item('pending')]);
  app.app.state = 'paused';
  await assert.rejects(() => app.setQueueSchedule('not a date'), /Invalid schedule/);
  await assert.rejects(() => app.setQueueSchedule(new Date(Date.now() - 60_000).toISOString()), /future/);
});

test('cancelQueueRun clears schedule and pauses queue', async () => {
  const app = makeAppWithQueue([item('pending')]);
  app.app.state = 'scheduled';
  app.app.scheduledRunAt = new Date(Date.now() + 60_000).toISOString();

  const result = await app.cancelQueueRun();

  assert.equal(result.ok, true);
  assert.equal(app.app.state, 'paused');
  assert.equal(app.app.scheduledRunAt, null);
  assert.match(app.output.at(-1).text, /cancelled/);
});

test('undo and clear operations affect only expected queue items', async () => {
  const app = makeAppWithQueue([item('done', 'completed'), item('first'), item('second')]);

  const undo = await app.undoLast();
  assert.equal(undo.ok, true);
  assert.equal(undo.composerText, 'Prompt second');
  assert.deepEqual(app.queue.map((i) => i.id), ['done', 'first']);

  await app.clearPending();
  assert.deepEqual(app.queue.map((i) => i.id), ['done']);

  await app.clearCompleted();
  assert.deepEqual(app.queue, []);
});

test('updateQueueItem handles edit, duplicate, retry, completed, status, and sendNow transitions', async () => {
  const failed = item('failed', 'failed', {
    error: 'boom',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:01:00.000Z',
  });
  const app = makeAppWithQueue([failed]);

  const editResult = await app.updateQueueItem({ id: 'failed', action: 'edit', text: 'new\ntext' });
  assert.equal(editResult.ok, true);
  assert.equal(editResult.item.id, 'failed');
  assert.equal(editResult.item.text, 'new\ntext');
  assert.equal(app.queue[0].status, 'pending');
  assert.equal(app.queue[0].error, null);
  assert.equal(app.queue[0].lineCount, 2);

  await app.updateQueueItem({ id: 'failed', action: 'duplicate' });
  assert.equal(app.queue.length, 2);
  assert.equal(app.queue[1].text, 'new\ntext');
  assert.notEqual(app.queue[1].id, 'failed');

  await app.updateQueueItem({ id: 'failed', action: 'markCompleted' });
  const completed = app.queue.find((i) => i.id === 'failed');
  assert.equal(completed.status, 'completed');
  assert.equal(typeof completed.finishedAt, 'string');

  await app.updateQueueItem({ id: app.queue[1].id, status: 'cancelled' });
  assert.equal(app.queue[1].status, 'cancelled');

  completed.status = 'failed';
  completed.error = 'again';
  completed.startedAt = '2026-01-01T00:00:00.000Z';
  completed.finishedAt = '2026-01-01T00:01:00.000Z';
  await app.updateQueueItem({ id: 'failed', action: 'retry' });
  const retried = app.queue.find((i) => i.id === 'failed');
  assert.equal(retried.status, 'pending');
  assert.equal(retried.error, null);
  assert.equal(retried.startedAt, null);
  assert.equal(retried.finishedAt, null);

  app.sendItemNow = async (queueItem) => ({ ok: true, sent: queueItem.id });
  assert.deepEqual(await app.updateQueueItem({ id: 'failed', action: 'sendNow' }), { ok: true, sent: 'failed' });
});

test('removeQueueItem deletes inactive prompts and rejects missing ids', async () => {
  const app = makeAppWithQueue([item('a'), item('b')]);

  await app.removeQueueItem('a');
  assert.deepEqual(app.queue.map((i) => i.id), ['b']);

  await assert.rejects(() => app.removeQueueItem('missing'), /Queue item not found/);
});
