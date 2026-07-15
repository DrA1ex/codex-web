'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const MOCK_BIN = path.resolve(__dirname, '../e2e/mock-app-server.js');

function startMock() {
  const child = spawn(process.execPath, [MOCK_BIN, 'app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, MOCK_APP_SERVER_PROJECT_DIR: process.cwd() },
  });
  const messages = [];
  const waiters = [];
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    messages.push(message);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (!waiter.predicate(message)) continue;
      waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const waitFor = (predicate, timeoutMs = 2000) => new Promise((resolve, reject) => {
    const existing = messages.find(predicate);
    if (existing) return resolve(existing);
    const waiter = { predicate, resolve, reject, timer: null };
    waiter.timer = setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      reject(new Error(`Timed out waiting for mock message. Seen: ${JSON.stringify(messages)}`));
    }, timeoutMs);
    waiters.push(waiter);
  });
  const stop = async () => {
    if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode) return resolve();
      child.once('exit', resolve);
      setTimeout(resolve, 1000).unref();
    });
  };
  return { child, messages, send, waitFor, stop };
}

async function initialize(mock) {
  mock.send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'test', version: '1' } } });
  const initialized = await mock.waitFor((message) => message.id === 1);
  assert.equal(initialized.result.userAgent, 'mock-codex-app-server/1.0');
  mock.send({ method: 'initialized', params: {} });
}

test('mock enforces initialize handshake and exposes documented thread/model methods', async (t) => {
  const mock = startMock();
  t.after(() => mock.stop());

  mock.send({ id: 9, method: 'model/list', params: {} });
  const early = await mock.waitFor((message) => message.id === 9);
  assert.equal(early.error.code, -32002);

  await initialize(mock);
  mock.send({ id: 2, method: 'model/list', params: {} });
  mock.send({ id: 3, method: 'thread/list', params: {} });

  const models = await mock.waitFor((message) => message.id === 2);
  const threads = await mock.waitFor((message) => message.id === 3);
  assert.equal(models.result.data[0].model, 'gpt-5.4');
  assert.ok(threads.result.data.some((thread) => thread.id === 'mock-thread'));
  assert.equal(Object.hasOwn(models, 'jsonrpc'), false);
});

test('mock can complete a turn before turn/start response without losing lifecycle events', async (t) => {
  const mock = startMock();
  t.after(() => mock.stop());
  await initialize(mock);

  mock.send({
    id: 4,
    method: 'turn/start',
    params: { threadId: 'mock-thread', input: [{ type: 'text', text: 'MOCK:COMPLETION_BEFORE_RESPONSE' }] },
  });

  const completed = await mock.waitFor((message) => message.method === 'turn/completed');
  const response = await mock.waitFor((message) => message.id === 4);
  assert.equal(completed.params.turn.status, 'completed');
  assert.equal(response.result.turn.id, completed.params.turn.id);

  const responseIndex = mock.messages.indexOf(response);
  const completionIndex = mock.messages.indexOf(completed);
  assert.ok(completionIndex < responseIndex, 'terminal event must precede the request response in this scenario');
});

test('mock compaction follows contextCompaction item lifecycle', async (t) => {
  const mock = startMock();
  t.after(() => mock.stop());
  await initialize(mock);

  mock.send({ id: 5, method: 'thread/compact/start', params: { threadId: 'mock-thread' } });
  await mock.waitFor((message) => message.id === 5);
  const started = await mock.waitFor((message) => message.method === 'item/started' && message.params.item.type === 'contextCompaction');
  const completed = await mock.waitFor((message) => message.method === 'item/completed' && message.params.item.type === 'contextCompaction');
  const turnCompleted = await mock.waitFor((message) => message.method === 'turn/completed' && message.params.turn.id === started.params.turnId);

  assert.equal(completed.params.turnId, started.params.turnId);
  assert.equal(turnCompleted.params.turn.status, 'completed');
  assert.equal(mock.messages.some((message) => message.method === 'thread/compacted'), false);
});
