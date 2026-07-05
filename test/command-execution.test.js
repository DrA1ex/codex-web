'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { item, makeAppWithQueue } = require('./helpers');

test('/pending writes a command output block', async () => {
  const app = makeAppWithQueue([item('abc123'), item('def456')]);
  const result = await app.executeCommand('/pending');
  assert.equal(result.ok, true);
  const last = app.output.at(-1);
  assert.equal(last.type, 'command');
  assert.equal(last.command.status, 'info');
  assert.match(last.command.message, /Next:/);
  assert.match(last.command.message, /#abc123/);
});

test('/pending handles an empty queue cleanly', async () => {
  const app = makeAppWithQueue([]);
  const result = await app.executeCommand('/pending');
  assert.equal(result.ok, true);
  assert.equal(app.output.at(-1).type, 'command');
  assert.equal(app.output.at(-1).command.status, 'info');
  assert.match(app.output.at(-1).command.message, /No pending items/);
});

test('/next moves a pending item without starting or resuming queue processing', async () => {
  const app = makeAppWithQueue([item('active', 'sent'), item('first'), item('second')]);
  app.currentItemId = 'active';
  app.app.state = 'paused';
  const result = await app.executeCommand('/next second');
  assert.equal(result.ok, true);
  assert.equal(app.app.state, 'paused');
  assert.equal(app.lastScheduledDelay, undefined);
  assert.deepEqual(app.queue.map((entry) => entry.id), ['active', 'second', 'first']);
});

test('/next moves an idle pending item to the first pending position without sending', async () => {
  const app = makeAppWithQueue([item('first'), item('second'), item('third')]);
  app.app.state = 'paused';
  const result = await app.executeCommand('/next third');
  assert.equal(result.ok, true);
  assert.equal(app.app.state, 'paused');
  assert.equal(app.lastScheduledDelay, undefined);
  assert.deepEqual(app.queue.map((entry) => entry.id), ['third', 'first', 'second']);
});

test('/next rejects already next and non-pending items', async () => {
  const app = makeAppWithQueue([item('first'), item('done', 'completed')]);
  let result = await app.executeCommand('/next first');
  assert.equal(result.ok, false);
  assert.equal(app.output.at(-1).type, 'command');
  assert.equal(app.output.at(-1).command.status, 'error');

  result = await app.executeCommand('/next done');
  assert.equal(result.ok, false);
  assert.match(app.output.at(-1).command.message, /pending/i);

  result = await app.executeCommand('/next missing');
  assert.equal(result.ok, false);
  assert.match(app.output.at(-1).command.message, /not found/i);
});

test('/send <id> uses sendItemNow path', async () => {
  const target = item('abc123');
  const app = makeAppWithQueue([target]);
  let called = null;
  app.sendItemNow = async (queueItem) => { called = queueItem; return { ok: true, item: queueItem }; };
  const result = await app.executeCommand('/send abc123');
  assert.equal(result.ok, true);
  assert.equal(called, target);
  assert.equal(app.output.at(-1).type, 'command');
});

test('/send <id> while running moves the item to next through the real send path', async () => {
  const active = item('active', 'sent');
  const target = item('target');
  const other = item('other');
  const app = makeAppWithQueue([active, other, target]);
  app.currentItemId = 'active';
  app.hasActivePrompt = () => true;
  const result = await app.executeCommand('/send target');
  assert.equal(result.ok, true);
  assert.deepEqual(app.queue.map((entry) => entry.id), ['active', 'target', 'other']);
});

test('/send <id> reports command errors for missing and non-pending items', async () => {
  const app = makeAppWithQueue([item('done', 'completed')]);
  let result = await app.executeCommand('/send missing');
  assert.equal(result.ok, false);
  assert.equal(app.output.at(-1).type, 'command');
  assert.equal(app.output.at(-1).command.status, 'error');
  assert.match(app.output.at(-1).command.message, /not found/i);

  result = await app.executeCommand('/send done');
  assert.equal(result.ok, false);
  assert.equal(app.output.at(-1).command.status, 'error');
  assert.match(app.output.at(-1).command.message, /pending/i);
});

test('/stop calls prompt interrupt and no-active stop writes an info block', async () => {
  const app = makeAppWithQueue([]);
  let called = false;
  app.interruptCurrentTurn = async () => { called = true; return { ok: true }; };
  let result = await app.executeCommand('/stop');
  assert.equal(result.ok, true);
  assert.equal(called, true);
  assert.match(app.output.at(-1).command.message, /Interrupt requested/);

  app.interruptCurrentTurn = async () => ({ ok: false, message: 'Nothing is running.' });
  result = await app.executeCommand('/stop');
  assert.equal(result.ok, true);
  assert.equal(app.output.at(-1).command.status, 'info');
});

test('/quit shuts down the server and does not use prompt interruption', async () => {
  const app = makeAppWithQueue([]);
  let shutdownReason = null;
  let interrupted = false;
  app.shutdown = async (reason) => { shutdownReason = reason; };
  app.interruptCurrentTurn = async () => { interrupted = true; return { ok: true }; };
  const result = await app.executeCommand('/quit');
  assert.equal(result.ok, true);
  assert.equal(shutdownReason, 'quit command');
  assert.equal(interrupted, false);
});

test('/schedule reset clears schedule and /schedule without args requests the modal', async () => {
  const app = makeAppWithQueue([item('pending')]);
  app.app.state = 'scheduled';
  app.app.scheduledRunAt = new Date(Date.now() + 100000).toISOString();
  let result = await app.executeCommand('/schedule reset');
  assert.equal(result.ok, true);
  assert.equal(app.app.scheduledRunAt, null);

  result = await app.executeCommand('/schedule');
  assert.equal(result.openScheduleModal, true);
});

test('/schedule without args reports an error when scheduling is not allowed', async () => {
  const app = makeAppWithQueue([item('pending')]);
  app.app.state = 'watching';
  const result = await app.executeCommand('/schedule');
  assert.equal(result.ok, false);
  assert.equal(result.openScheduleModal, undefined);
  assert.equal(app.output.at(-1).type, 'command');
  assert.equal(app.output.at(-1).command.status, 'error');
  assert.match(app.output.at(-1).command.message, /paused, scheduled, or waiting/i);
});

test('/schedule duration sets queue schedule', async () => {
  const app = makeAppWithQueue([item('pending')]);
  app.app.state = 'paused';
  const result = await app.executeCommand('/schedule 10m');
  assert.equal(result.ok, true);
  assert.ok(app.app.scheduledRunAt);
  assert.equal(app.app.state, 'scheduled');
});

test('/schedule invalid values write command error output', async () => {
  const app = makeAppWithQueue([item('pending')]);
  app.app.state = 'paused';
  const result = await app.executeCommand('/schedule nonsense');
  assert.equal(result.ok, false);
  const command = app.output.at(-1).command;
  assert.equal(app.output.at(-1).type, 'command');
  assert.equal(command.status, 'error');
  assert.equal(command.raw, '/schedule nonsense');
  assert.match(command.message, /Invalid schedule value/);
  assert.match(command.usage, /\/schedule/);
});
