'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');

const { CodexLimitWatchApp } = require('../src/app');
const { makeQueueItem, normalizeQueueItem, countQueue, parseExactCommand } = require('../src/queue');
const { normalizeRateLimits } = require('../src/rate-limits');
const {
  canAppendOutput,
  extractDeltaText,
  formatItemStarted,
  outputTypeForItem,
  formatItemCompleted,
} = require('../src/output-format');

function item(id, status = 'pending') {
  return normalizeQueueItem({ id, text: `Prompt ${id}`, status });
}

function makeAppWithQueue(queue) {
  const app = new CodexLimitWatchApp({
    stateDir: path.join(os.tmpdir(), 'codex-web-test'),
    projectDir: process.cwd(),
    sessionId: 'session',
    model: '',
    effort: '',
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    approvalResponse: '',
    network: true,
    addDirs: [],
    allSessions: false,
    debug: false,
    watchInterval: 60,
  });
  app.queue = queue;
  app.saveQueue = async () => {};
  app.broadcastAll = () => {};
  return app;
}

test('queue items are normalized and counted', () => {
  const item = makeQueueItem('first line\nsecond line');
  assert.equal(item.status, 'pending');
  assert.equal(item.lineCount, 2);
  assert.equal(item.preview, 'first line');

  const normalized = normalizeQueueItem({ id: 'abc', text: '', status: 'failed' });
  assert.equal(normalized.id, 'abc');
  assert.equal(normalized.lineCount, 0);
  assert.equal(normalized.error, null);

  assert.deepEqual(countQueue([
    { status: 'pending' },
    { status: 'pending' },
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
    custom: 1,
  });
});

test('standalone commands are parsed exactly', () => {
  assert.equal(parseExactCommand(' /pause\n'), '/pause');
  assert.equal(parseExactCommand('/send now'), null);
  assert.equal(parseExactCommand('hello'), null);
});

test('rate limits normalize available, limited, and unknown responses', () => {
  const available = normalizeRateLimits({
    rateLimitsByLimitId: {
      codex: {
        limitId: 'codex',
        limitName: 'codex',
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1000 },
      },
    },
  });
  assert.equal(available.status, 'available');
  assert.equal(available.buckets[0].remainingPercent, undefined);
  assert.equal(available.buckets[0].windows[0].remainingPercent, 75);

  const limited = normalizeRateLimits({
    rateLimitsByLimitId: {
      weekly: {
        limitId: 'weekly',
        limitName: 'weekly',
        rateLimitReachedType: 'weekly',
        primary: { usedPercent: 100, resetsAt: 2000 },
      },
    },
  });
  assert.equal(limited.status, 'limited');
  assert.equal(limited.resetAt, 2000);
  assert.match(limited.message, /weekly/);

  const unknown = normalizeRateLimits({});
  assert.equal(unknown.status, 'unknown');
});

test('output formatting classifies stream items and deltas', () => {
  assert.equal(canAppendOutput('delta', 'delta'), true);
  assert.equal(canAppendOutput('tool', 'tool'), false);
  assert.equal(extractDeltaText('turn/delta', { deltaBase64: Buffer.from('hello').toString('base64') }), 'hello');
  assert.equal(formatItemStarted({ type: 'commandExecution', command: ['npm', 'test'] }), '[tool] command: npm test');
  assert.equal(outputTypeForItem({ type: 'fileChange' }), 'diff');
  assert.equal(outputTypeForItem({ type: 'userMessage' }), 'prompt');
  assert.equal(formatItemCompleted({ type: 'dynamicToolCall', status: 'completed' }), '[tool] completed');
  assert.equal(formatItemCompleted({ type: 'fileChange', status: 'completed' }), '');
});

test('reorderQueueItem reorders only pending slots and preserves non-pending positions', async () => {
  const running = item('running', 'sent');
  const first = item('first');
  const done = item('done', 'completed');
  const second = item('second');
  const third = item('third');
  const app = makeAppWithQueue([running, first, done, second, third]);

  await app.reorderQueueItem('third', { beforeId: 'first' });

  assert.deepEqual(app.queue.map((i) => i.id), ['running', 'third', 'done', 'first', 'second']);
  assert.deepEqual(app.queue.map((i) => i.status), ['sent', 'pending', 'completed', 'pending', 'pending']);
});

test('reorderQueueItem rejects moving non-pending items or targeting non-pending items', async () => {
  const app = makeAppWithQueue([item('active', 'sent'), item('a'), item('done', 'completed'), item('b')]);

  await assert.rejects(() => app.reorderQueueItem('active', { beforeId: 'a' }), /Only pending/);
  await assert.rejects(() => app.reorderQueueItem('b', { beforeId: 'done' }), /pending prompts/);
});

test('reorderQueueItem supports explicit move to end of pending segment', async () => {
  const app = makeAppWithQueue([item('a'), item('done', 'completed'), item('b'), item('c')]);

  await app.reorderQueueItem('a', { beforeId: null });

  assert.deepEqual(app.queue.map((i) => i.id), ['b', 'done', 'c', 'a']);
});
