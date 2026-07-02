'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { CodexLimitWatchApp } = require('../src/app');
const { makeSandboxPolicy, mapApprovalResponse, humanApprovalResponse } = require('../src/policies');
const { extractThreadList, normalizeSession } = require('../src/codex-sessions');
const { makeQueueItem, normalizeQueueItem, normalizeQueueOrder, countQueue, parseExactCommand } = require('../src/queue');
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

async function tempDir() {
  return await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-web-test-'));
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
  app.saveQueue = async () => { app.queue = normalizeQueueOrder(app.queue); };
  app.saveState = async () => {};
  app.broadcastAll = () => {};
  app.broadcast = () => {};
  app.schedulePump = (delay = 0) => { app.lastScheduledDelay = delay; };
  return app;
}

function mockResponse() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body || '';
    },
  };
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

test('rate-limit polling writes terminal diagnostics for unknown and recovery', async () => {
  const app = makeAppWithQueue([]);
  const warnings = [];
  const logs = [];
  const originalWarn = console.warn;
  const originalLog = console.log;
  console.warn = (message) => { warnings.push(String(message)); };
  console.log = (message) => { logs.push(String(message)); };
  try {
    app.rpc = { exited: false, request: async () => ({}) };
    await app.pollRateLimits();
    assert.equal(app.rateLimits.status, 'unknown');
    assert.match(warnings.at(-1), /\[limits\].*poll unknown: no rate-limit buckets returned/);

    app.rpc = { exited: false, request: async () => ({ rateLimits: { limitId: 'codex', primary: { usedPercent: 10 } } }) };
    await app.pollRateLimits();
    assert.equal(app.rateLimits.status, 'available');
    assert.match(logs.at(-1), /\[limits\].*poll recovered: available/);
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
  }
});

test('rate-limit polling logs RPC errors with code and masked data', async () => {
  const app = makeAppWithQueue([]);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => { warnings.push(String(message)); };
  try {
    const err = new Error('temporary outage');
    err.code = 'E_LIMITS';
    err.data = { apiKey: 'secret', reason: 'no response' };
    app.rpc = { exited: false, request: async () => { throw err; } };

    await app.pollRateLimits();

    assert.equal(app.rateLimits.status, 'unknown');
    assert.match(warnings.at(-1), /poll failed: temporary outage code=E_LIMITS/);
    assert.match(warnings.at(-1), /apiKey.*masked/);
    assert.doesNotMatch(warnings.at(-1), /secret/);
  } finally {
    console.warn = originalWarn;
  }
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

test('sendComposerNow creates a queue item and sends immediately only when idle', async () => {
  const app = makeAppWithQueue([]);
  app.rateLimits = { status: 'available', buckets: [], resetAt: null };
  const sent = [];
  app.sendPrompt = async (queueItem, options) => {
    sent.push({ queueItem, options });
  };

  const result = await app.sendComposerNow('hello from composer');

  assert.equal(result.ok, true);
  assert.equal(result.clearComposer, true);
  assert.equal(result.item.text, 'hello from composer');
  assert.deepEqual(app.queue.map((i) => i.id), [result.item.id]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].queueItem.id, result.item.id);
  assert.deepEqual(sent[0].options, { continueQueue: false });
});

test('sendComposerNow queues instead of erroring when busy or pending exists', async () => {
  const busy = makeAppWithQueue([]);
  busy.rateLimits = { status: 'available', buckets: [], resetAt: null };
  busy.app.state = 'countdown';
  const busyResult = await busy.sendComposerNow('hello');
  assert.equal(busyResult.ok, true);
  assert.equal(busyResult.clearComposer, true);
  assert.deepEqual(busy.queue.map((i) => i.text), ['hello']);
  assert.equal(busy.lastScheduledDelay, 200);

  const queued = makeAppWithQueue([item('pending')]);
  queued.rateLimits = { status: 'available', buckets: [], resetAt: null };
  const queuedResult = await queued.sendComposerNow('hello');
  assert.equal(queuedResult.ok, true);
  assert.equal(queuedResult.clearComposer, true);
  assert.deepEqual(queued.queue.map((i) => i.text), ['Prompt pending', 'hello']);
  assert.equal(queued.lastScheduledDelay, 200);
});

test('sendComposerNow queues and clears composer when limits are not available', async () => {
  const app = makeAppWithQueue([]);
  app.rateLimits = { status: 'limited', buckets: [], resetAt: null };
  app.sendPrompt = async () => { throw new Error('should not send while limited'); };

  const result = await app.sendComposerNow('wait for limit');

  assert.equal(result.ok, true);
  assert.equal(result.clearComposer, true);
  assert.deepEqual(app.queue.map((i) => i.text), ['wait for limit']);
  assert.equal(app.lastScheduledDelay, 200);
});

test('sendItemNow keeps active prompt above pending item when queue is already processing', async () => {
  const active = item('active', 'sent');
  const first = item('first');
  const second = item('second');
  const app = makeAppWithQueue([first, active, second]);
  app.currentItemId = 'active';

  await app.sendItemNow(second);

  assert.deepEqual(app.queue.map((i) => i.id), ['active', 'first', 'second']);
  assert.equal(app.lastScheduledDelay, 200);
  assert.match(app.output.at(-1).text, /\[queue\] next #second/);
});

test('sendItemNow promotes idle item to first pending slot before manual send', async () => {
  const first = item('first');
  const second = item('second');
  const done = item('done', 'completed');
  const third = item('third');
  const app = makeAppWithQueue([first, done, second, third]);
  app.rateLimits = { status: 'available', buckets: [], resetAt: null };
  const sent = [];
  app.runCountdownAndSend = async (queueItem, options) => {
    sent.push({ queueItem, options });
  };

  const result = await app.sendItemNow(second);

  assert.equal(result.ok, true);
  assert.deepEqual(app.queue.map((i) => i.id), ['done', 'second', 'first', 'third']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].queueItem.id, 'second');
  assert.deepEqual(sent[0].options, { continueQueue: false });
});

test('sendItemNow rejects extra sends while countdown is active', async () => {
  const first = item('first');
  const second = item('second');
  const app = makeAppWithQueue([first, second]);
  app.app.state = 'countdown';

  await assert.rejects(() => app.sendItemNow(second), /already scheduled to send/);

  assert.deepEqual(app.queue.map((i) => i.id), ['first', 'second']);
  assert.equal(app.lastScheduledDelay, undefined);
});

test('sendItemNow reserves manual send before async rate-limit polling', async () => {
  const first = item('first');
  const second = item('second');
  const app = makeAppWithQueue([first, second]);
  app.rateLimits = { status: 'unknown', buckets: [], resetAt: null };
  let releasePoll;
  app.pollRateLimits = async () => {
    await new Promise((resolve) => {
      releasePoll = () => {
        app.rateLimits = { status: 'available', buckets: [], resetAt: null };
        resolve();
      };
    });
  };
  const sent = [];
  app.runCountdownAndSend = async (queueItem, options) => {
    sent.push({ queueItem, options });
  };

  const firstSend = app.sendItemNow(first);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(app.currentManualSend, true);
  await assert.rejects(() => app.sendItemNow(second), /already scheduled to send/);
  assert.deepEqual(app.queue.map((i) => i.id), ['first', 'second']);

  releasePoll();
  await firstSend;

  assert.equal(app.currentManualSend, false);
  assert.deepEqual(sent.map((entry) => entry.queueItem.id), ['first']);
});

test('manual send disables queue pause control while prompt is running', () => {
  const app = makeAppWithQueue([item('active', 'sending')]);
  app.app.state = 'sending';
  app.currentItemId = 'active';
  app.currentManualSend = true;

  const snap = app.snapshot();

  assert.equal(snap.app.isManualSend, true);
  assert.equal(snap.app.canPause, false);
  assert.equal(snap.app.canInterrupt, false);
});

test('manual send can arm and disarm queue continuation while prompt is active', () => {
  const active = item('active', 'sent');
  const pending = item('pending');
  const app = makeAppWithQueue([active, pending]);
  app.app.state = 'streaming';
  app.currentItemId = 'active';
  app.currentManualSend = true;

  let snap = app.snapshot();
  assert.equal(snap.app.canResume, true);
  assert.equal(snap.app.canPause, false);

  app.resume();
  snap = app.snapshot();
  assert.equal(app.manualSendContinueQueue, true);
  assert.equal(snap.app.canResume, false);
  assert.equal(snap.app.canPause, true);

  app.pause();
  snap = app.snapshot();
  assert.equal(app.manualSendContinueQueue, false);
  assert.equal(snap.app.canPause, false);
  assert.equal(snap.app.canResume, true);

  app.resume();
  snap = app.snapshot();
  assert.equal(app.manualSendContinueQueue, true);
  assert.equal(app.app.state, 'streaming');
  assert.equal(snap.app.canPause, true);
  assert.equal(snap.app.canResume, false);
});

test('manual send countdown does not expose queue resume before prompt starts', () => {
  const app = makeAppWithQueue([item('pending')]);
  app.app.state = 'countdown';
  app.currentManualSend = true;

  const snap = app.snapshot();

  assert.equal(snap.app.canResume, false);
  assert.equal(snap.app.canPause, false);
});

test('manual send continuation schedules pending queue after current prompt', async () => {
  const active = item('active');
  const pending = item('pending');
  const app = makeAppWithQueue([active, pending]);
  app.app.state = 'streaming';
  app.manualSendContinueQueue = true;
  app.rpc = { request: async () => ({ turn: { id: 'turn-active' } }) };
  app.waitForTurnCompletion = async () => {};

  await app.sendPrompt(active, { continueQueue: false });

  assert.equal(app.manualSendContinueQueue, false);
  assert.equal(app.currentManualSend, false);
  assert.equal(app.app.state, 'watching');
  assert.equal(app.lastScheduledDelay, 1500);
});

test('cancelPendingSend clears manual send reservation immediately', () => {
  const app = makeAppWithQueue([item('pending')]);
  app.app.state = 'countdown';
  app.currentManualSend = true;

  app.cancelPendingSend();
  const snap = app.snapshot();

  assert.equal(app.app.state, 'paused');
  assert.equal(snap.app.isManualSend, false);
});

test('canChangeSession blocks unsafe queue states and allows completed idle session', () => {
  const pending = makeAppWithQueue([item('pending')]);
  pending.app.state = 'paused';
  assert.equal(pending.canChangeSession(), false);

  const completed = makeAppWithQueue([item('done', 'completed')]);
  completed.app.state = 'done';
  assert.equal(completed.canChangeSession(), true);

  completed.approval = { rpcId: 1 };
  assert.equal(completed.canChangeSession(), false);
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

test('diff output skips identical repeated diffs and updates changed diff block', () => {
  const app = makeAppWithQueue([]);

  app.updateDiffOutput('diff --git a/file b/file\n+one');
  app.updateDiffOutput('diff --git a/file b/file\n+one');
  assert.equal(app.output.length, 1);
  assert.equal(app.output[0].type, 'diff');

  app.updateDiffOutput('diff --git a/file b/file\n+two');
  assert.equal(app.output.length, 1);
  assert.match(app.output[0].text, /\+two/);
});

test('command output completion updates existing tool block once', () => {
  const app = makeAppWithQueue([]);
  const out = app.appendOutput('[tool] command\nnpm test', 'tool');
  app.trackCommandOutput({ id: 'cmd-1' }, out);

  app.updateCommandOutput({ id: 'cmd-1', status: 'completed', exitCode: 0 });
  app.updateCommandOutput({ id: 'cmd-1', status: 'completed', exitCode: 0 });

  assert.equal(app.output.length, 1);
  assert.equal((app.output[0].text.match(/\nexit: 0/g) || []).length, 1);
});

test('loadQueue recovers interrupted sending items as unknown', async () => {
  const dir = await tempDir();
  const queuePath = path.join(dir, 'queue.json');
  await fsp.writeFile(queuePath, JSON.stringify([
    { id: 'sending', text: 'was sending', status: 'sending' },
    { id: 'sent', text: 'was sent', status: 'sent' },
    { id: 'pending', text: 'still pending', status: 'pending' },
  ]));
  const app = makeAppWithQueue([]);
  app.queuePath = queuePath;
  app.saveQueue = CodexLimitWatchApp.prototype.saveQueue.bind(app);

  await app.loadQueue();

  assert.deepEqual(app.queue.map((i) => i.status), ['unknown', 'unknown', 'pending']);
  assert.match(app.queue[0].error, /Previous run exited/);
  assert.match(app.queue[1].error, /Previous run exited/);
  const persisted = JSON.parse(await fsp.readFile(queuePath, 'utf8'));
  assert.deepEqual(persisted.map((i) => i.status), ['unknown', 'unknown', 'pending']);
});

test('loadQueue backs up corrupted queue file and starts empty', async () => {
  const dir = await tempDir();
  const queuePath = path.join(dir, 'queue.json');
  await fsp.writeFile(queuePath, '{not json');
  const app = makeAppWithQueue([]);
  app.queuePath = queuePath;
  app.eventsLogPath = path.join(dir, 'events.log');
  app.saveQueue = CodexLimitWatchApp.prototype.saveQueue.bind(app);

  await app.loadQueue();

  assert.deepEqual(app.queue, []);
  assert.deepEqual(JSON.parse(await fsp.readFile(queuePath, 'utf8')), []);
  assert.equal(fs.readdirSync(dir).some((name) => /^queue\.json\.corrupt\..+\.bak$/.test(name)), true);
  assert.equal(app.output.at(-1).type, 'error');
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

test('updateQueueItem handles edit, duplicate, retry, and completed transitions', async () => {
  const failed = item('failed', 'failed');
  failed.error = 'boom';
  failed.startedAt = '2026-01-01T00:00:00.000Z';
  failed.finishedAt = '2026-01-01T00:01:00.000Z';
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
});

test('sandbox and approval policy payload mapping preserves app-server values', () => {
  assert.deepEqual(makeSandboxPolicy({
    sandbox: 'workspace-write',
    projectDir: '/project',
    addDirs: ['/extra'],
    network: true,
  }), {
    type: 'workspaceWrite',
    writableRoots: ['/project', '/extra'],
    networkAccess: true,
  });
  assert.deepEqual(makeSandboxPolicy({ sandbox: 'read-only', projectDir: '/project', addDirs: [], network: false }), {
    type: 'readOnly',
    networkAccess: false,
  });
  assert.equal(mapApprovalResponse('accept-for-session'), 'acceptForSession');
  assert.equal(humanApprovalResponse('acceptForSession'), 'accept-for-session');
});

test('session list normalization extracts IDs, preview, cwd match, and updated time', () => {
  const projectDir = process.cwd();
  const result = { threads: [{ threadId: 'thread-1' }] };
  assert.deepEqual(extractThreadList(result), result.threads);

  const session = normalizeSession({
    threadId: 'thread-1',
    cwd: projectDir,
    updatedAt: '2026-01-02T03:04:05.000Z',
    turns: [{
      items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Latest prompt text' }] }],
    }],
  }, projectDir);

  assert.equal(session.id, 'thread-1');
  assert.equal(session.cwdMatch, 'exact');
  assert.equal(session.preview, 'Latest prompt text');
  assert.equal(session.title, 'Latest prompt text');
  assert.equal(session.updatedAt, '2026-01-02T03:04:05.000Z');
});

test('index requires a valid token and does not leak token on auth error', () => {
  const app = makeAppWithQueue([]);
  app.token = 'secret-token';
  const res = mockResponse();

  app.serveIndex({ headers: {} }, res, new URL('http://localhost/'));

  assert.equal(res.status, 403);
  assert.match(res.body, /Authorization error/);
  assert.doesNotMatch(res.body, /secret-token/);
});
