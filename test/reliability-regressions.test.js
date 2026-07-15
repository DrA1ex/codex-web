'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { CodexLimitWatchApp } = require('../src/app');
const { item, makeAppWithQueue, tempDir } = require('./helpers');

function stubPromptUsage(app) {
  app.beginQueueItemUsage = async () => {};
  app.completeQueueItemUsage = async () => {};
  app.recordQueueItemTurn = async () => {};
  app.finalizeCompletedQueueItem = async () => false;
  app.tryReadSession = async () => {};
}

function withTimeout(promise, ms = 250) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms)),
  ]);
}

test('foreign thread and turn notifications cannot mutate or complete the active operation', async () => {
  const active = item('active', 'sending');
  const app = makeAppWithQueue([active]);
  app.tryReadSession = async () => {};
  app.turnCoordinator.begin({ threadId: 'session', itemId: active.id });
  app.turnCoordinator.acceptTurn('turn-current');

  app.handleNotification('turn/started', {
    threadId: 'foreign-session',
    turn: { id: 'turn-foreign' },
  });
  app.handleNotification('turn/completed', {
    threadId: 'foreign-session',
    turn: { id: 'turn-foreign', status: 'completed' },
  });
  app.handleNotification('turn/completed', {
    threadId: 'session',
    turn: { id: 'turn-other', status: 'completed' },
  });

  assert.equal(app.currentTurnId, 'turn-current');
  assert.equal(active.status, 'sending');
  assert.equal(app.turnCompletionSeen, false);

  const waiter = app.waitForTurnCompletion();
  app.handleNotification('turn/completed', {
    threadId: 'session',
    turn: { id: 'turn-current', status: 'completed' },
  });

  const terminal = await waiter;
  assert.equal(terminal.turnId, 'turn-current');
  assert.equal(active.status, 'completed');
});

test('sendPrompt cannot lose a completion delivered before turn/start returns', async () => {
  const active = item('active');
  const app = makeAppWithQueue([active]);
  stubPromptUsage(app);
  app.rpc = {
    request: async (method) => {
      if (method !== 'turn/start') return {};
      app.handleNotification('turn/completed', {
        threadId: 'session',
        turn: { id: 'turn-early', status: 'completed' },
      });
      return { turn: { id: 'turn-early' } };
    },
  };

  await withTimeout(app.sendPrompt(active, { continueQueue: false }));

  assert.equal(active.status, 'completed');
  assert.equal(app.currentItemId, null);
  assert.equal(app.currentTurnId, null);
  assert.equal(app.app.state, 'paused');
});

test('force steer replacement failure rejects the active waiter and leaves a recoverable failed item', async () => {
  const active = item('active', 'sent');
  const app = makeAppWithQueue([active]);
  app.rateLimits.status = 'available';
  app.turnCoordinator.begin({ threadId: 'session', itemId: active.id });
  app.turnCoordinator.acceptTurn('turn-original');
  app.createOutputGroupForItem(active);
  app.rpc = {
    request: async (method) => {
      if (method === 'turn/interrupt') return {};
      if (method === 'turn/start') throw new Error('replacement start failed');
      return {};
    },
  };

  const waiter = app.waitForTurnCompletion();
  const result = await app.forceSteerActivePrompt('correct the implementation', { confirmed: true });

  assert.equal(result.ok, false);
  assert.match(result.message, /replacement start failed/);
  assert.equal(active.status, 'failed');
  assert.equal(app.forceSteer, null);
  assert.equal(app.app.state, 'paused');
  await assert.rejects(waiter, /replacement start failed/);

  app.handleNotification('turn/failed', {
    threadId: 'session',
    turn: { id: 'turn-original', status: 'failed', error: { message: 'interrupted' } },
  });
  assert.equal(active.status, 'failed');
});

test('app-server exit rejects active turn waiters and persists an unknown outcome', async () => {
  const active = item('active', 'sent');
  const app = makeAppWithQueue([active]);
  app.turnCoordinator.begin({ threadId: 'session', itemId: active.id });
  app.turnCoordinator.acceptTurn('turn-active');
  const waiter = app.waitForTurnCompletion();

  await app.handleRpcExit(new Error('app-server exited unexpectedly'));

  await assert.rejects(waiter, /exited unexpectedly/);
  assert.equal(active.status, 'unknown');
  assert.equal(app.app.state, 'error');
  assert.match(active.error, /exited unexpectedly/);
});


test('app-server exit during turn/start cannot be overwritten by manual-send cleanup', async () => {
  const active = item('exit-during-start');
  const app = makeAppWithQueue([active]);
  stubPromptUsage(app);
  let rejectTurnStart;
  app.rpc = {
    request: async () => await new Promise((resolve, reject) => {
      rejectTurnStart = reject;
    }),
  };

  const sending = app.sendPrompt(active, { continueQueue: false });
  await withTimeout(new Promise((resolve) => {
    const poll = () => rejectTurnStart ? resolve() : setImmediate(poll);
    poll();
  }));

  const exitError = new Error('codex app-server exited: code=42, signal=none');
  exitError.code = 'APP_SERVER_EXITED';
  const handlingExit = app.handleRpcExit(exitError);
  rejectTurnStart(exitError);

  await withTimeout(Promise.all([handlingExit, sending]));
  assert.equal(active.status, 'unknown');
  assert.equal(app.app.state, 'error');
  assert.match(app.app.message, /code=42/);
  assert.equal(app.currentItemId, null);
  assert.equal(app.currentTurnId, null);
});

test('persistent app-server exit error survives coordinator cleanup races', async () => {
  const active = item('exit-after-coordinator-reset');
  const app = makeAppWithQueue([active]);
  stubPromptUsage(app);
  let rejectTurnStart;
  app.rpc = {
    request: async () => await new Promise((resolve, reject) => {
      rejectTurnStart = reject;
    }),
  };

  const sending = app.sendPrompt(active, { continueQueue: false });
  await withTimeout(new Promise((resolve) => {
    const poll = () => rejectTurnStart ? resolve() : setImmediate(poll);
    poll();
  }));

  const exitError = new Error('codex app-server exited during coordinator cleanup');
  exitError.code = 'APP_SERVER_EXITED';
  const handlingExit = app.handleRpcExit(exitError);
  app.turnCoordinator.reset();
  rejectTurnStart(new Error('secondary turn/start rejection'));

  await withTimeout(Promise.all([handlingExit, sending]));
  assert.equal(active.status, 'unknown');
  assert.equal(active.error, exitError.message);
  assert.equal(app.app.state, 'error');
  assert.equal(app.app.message, exitError.message);
});

test('manual prompt cleanup cannot downgrade a latched app-server failure', async () => {
  const active = item('generic-error-after-exit');
  const app = makeAppWithQueue([active]);
  stubPromptUsage(app);
  const exitError = new Error('latched app-server failure');
  exitError.code = 'APP_SERVER_EXITED';
  exitError.reported = true;
  app.appServerExited = true;
  app.appServerExitError = exitError;
  app.app.state = 'error';
  app.rpc = { request: async () => { throw new Error('app-server is not running'); } };

  await withTimeout(app.sendPrompt(active, { continueQueue: false }));

  assert.equal(active.status, 'unknown');
  assert.equal(active.error, exitError.message);
  assert.equal(app.app.state, 'error');
  assert.equal(app.app.message, exitError.message);
});

test('app-server exit during turn metadata persistence preserves the fatal state', async () => {
  const active = item('exit-during-turn-record');
  const app = makeAppWithQueue([active]);
  stubPromptUsage(app);

  let recordStarted;
  let releaseRecord;
  const recordEntered = new Promise((resolve) => { recordStarted = resolve; });
  const recordBlocked = new Promise((resolve) => { releaseRecord = resolve; });
  app.recordQueueItemTurn = async () => {
    recordStarted();
    await recordBlocked;
  };
  app.rpc = {
    request: async (method) => {
      assert.equal(method, 'turn/start');
      return { turn: { id: 'turn-record-race' } };
    },
  };

  const sending = app.sendPrompt(active, { continueQueue: false });
  await withTimeout(recordEntered);

  const exitError = new Error('codex app-server exited while recording turn metadata');
  exitError.code = 'APP_SERVER_EXITED';
  const handlingExit = app.handleRpcExit(exitError);
  releaseRecord();

  await withTimeout(Promise.all([handlingExit, sending]));
  assert.equal(active.status, 'unknown');
  assert.equal(app.app.state, 'error');
  assert.match(app.app.message, /recording turn metadata/);
  assert.equal(app.currentItemId, null);
  assert.equal(app.currentTurnId, null);
});

test('app-server exit before turn id assignment marks a sending item unknown', async () => {
  const active = item('sending-on-exit', 'sending');
  const app = makeAppWithQueue([active]);
  app.turnCoordinator.begin({ threadId: 'session', itemId: active.id });

  await app.handleRpcExit(new Error('server disappeared before turn/start response'));

  assert.equal(active.status, 'unknown');
  assert.equal(app.app.state, 'error');
  assert.match(active.error, /disappeared/);
});

test('fatal app-server exit latches queue processing and resume in error state', async () => {
  const pending = item('pending-after-exit');
  const app = makeAppWithQueue([pending]);
  let sends = 0;
  app.runCountdownAndSend = async () => { sends += 1; };

  await app.handleRpcExit(new Error('app-server terminated'));
  assert.equal(app.appServerExited, true);
  assert.equal(app.app.state, 'error');

  app.resume();
  assert.equal(app.app.state, 'error');
  await app.pumpQueue();
  assert.equal(sends, 0);
  assert.equal(pending.status, 'pending');
});

test('manual send waiting for limits schedules and performs its own retry', async () => {
  const pending = item('pending');
  const app = makeAppWithQueue([pending]);
  app.rateLimits = {
    ...app.rateLimits,
    status: 'limited',
    resetAt: Math.floor(Date.now() / 1000) + 60,
  };
  const schedules = [];
  app.schedulePump = (delay) => schedules.push(delay);

  const result = await app.sendItemNow(pending);

  assert.equal(result.ok, true);
  assert.equal(app.pendingManualSendItemId, pending.id);
  assert.equal(app.currentManualSend, true);
  assert.equal(app.app.state, 'waiting-limits');
  assert.equal(schedules.length, 1);

  let sent = null;
  app.rateLimits.status = 'available';
  app.runCountdownAndSend = async (queueItem, options) => { sent = { queueItem, options }; };
  await app.pumpQueue();

  assert.equal(app.pendingManualSendItemId, null);
  assert.equal(sent.queueItem.id, pending.id);
  assert.equal(sent.options.continueQueue, false);
});

test('pause durably clears a previously scheduled run', async () => {
  const dir = await tempDir();
  const app = makeAppWithQueue([]);
  app.statePath = path.join(dir, 'state.json');
  app.saveState = CodexLimitWatchApp.prototype.saveState.bind(app);
  app.app.scheduledRunAt = new Date(Date.now() + 60_000).toISOString();

  app.pause('Paused for test');
  await app.persistence.drain();

  const saved = JSON.parse(await fsp.readFile(app.statePath, 'utf8'));
  assert.equal(saved.scheduledRunAt, null);
  assert.equal(saved.state, 'paused');
});

test('explicit sandbox and approval CLI options override saved settings', async () => {
  const dir = await tempDir();
  const settingsPath = path.join(dir, 'settings.json');
  await fsp.writeFile(settingsPath, JSON.stringify({
    sandbox: 'danger-full-access',
    approvalPolicy: 'never',
    theme: 'light',
  }));

  const explicit = makeAppWithQueue([], {
    sandbox: 'read-only',
    approvalPolicy: 'on-request',
    sandboxProvided: true,
    approvalPolicyProvided: true,
  });
  explicit.settingsPath = settingsPath;
  await explicit.loadSettings();
  assert.equal(explicit.opts.sandbox, 'read-only');
  assert.equal(explicit.opts.approvalPolicy, 'on-request');
  assert.equal(explicit.app.configSources.sandbox, 'cli');
  assert.equal(explicit.app.configSources.approvalPolicy, 'cli');

  const saved = makeAppWithQueue([], {
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    sandboxProvided: false,
    approvalPolicyProvided: false,
  });
  saved.settingsPath = settingsPath;
  await saved.loadSettings();
  assert.equal(saved.opts.sandbox, 'danger-full-access');
  assert.equal(saved.opts.approvalPolicy, 'never');
  assert.equal(saved.app.configSources.sandbox, 'saved');
  assert.equal(saved.app.configSources.approvalPolicy, 'saved');
});

test('intentional interrupt records are scoped to one turn operation', () => {
  const first = item('first', 'sent');
  const second = item('second', 'sending');
  const app = makeAppWithQueue([first, second]);

  app.turnCoordinator.begin({ threadId: 'session', itemId: first.id });
  app.turnCoordinator.acceptTurn('turn-old');
  app.turnCoordinator.beginForceSteer({ originalTurnId: 'turn-old', queueItemId: first.id });
  app.turnCoordinator.resolveSynthetic('interrupted');
  app.turnCoordinator.reset();

  app.turnCoordinator.begin({ threadId: 'session', itemId: second.id });
  app.turnCoordinator.acceptTurn('turn-new');
  const result = app.turnCoordinator.correlateTerminal(
    'turn/failed',
    { threadId: 'session' },
    'failed',
    'cancelled by server',
  );

  assert.equal(result.matched, true);
  assert.equal(result.ignored, false);
  assert.equal(result.turnId, 'turn-new');
  assert.equal(app.intentionalInterrupts.size, 0);
});

test('sendPrompt cleans coordinator and item state when setup persistence fails', async () => {
  const active = item('setup-failure');
  const app = makeAppWithQueue([active]);
  stubPromptUsage(app);
  let saveCalls = 0;
  app.saveQueue = async () => {
    saveCalls += 1;
    throw new Error('queue disk unavailable');
  };

  await app.sendPrompt(active, { continueQueue: false });

  assert.equal(active.status, 'failed');
  assert.match(active.error, /queue disk unavailable/);
  assert.equal(app.currentItemId, null);
  assert.equal(app.currentTurnId, null);
  assert.equal(app.turnCoordinator.operation, null);
  assert.equal(app.currentManualSend, false);
  assert.ok(saveCalls >= 2);
});

test('sendPrompt cleanup failures cannot leave a completed turn active', async () => {
  const active = item('cleanup-failure');
  const app = makeAppWithQueue([active]);
  const reported = [];
  app.reportPersistenceFailure = (operation, err) => reported.push(`${operation}: ${err.message}`);
  app.beginQueueItemUsage = async () => {};
  app.recordQueueItemTurn = async () => {};
  app.completeQueueItemUsage = async () => { throw new Error('usage cleanup failed'); };
  app.finalizeCompletedQueueItem = async () => { throw new Error('archive failed'); };
  app.saveState = async () => { throw new Error('state failed'); };
  app.tryReadSession = async () => {};
  app.rpc = {
    request: async () => {
      app.handleNotification('turn/completed', {
        threadId: 'session',
        turn: { id: 'turn-cleanup', status: 'completed' },
      });
      return { turn: { id: 'turn-cleanup' } };
    },
  };

  await withTimeout(app.sendPrompt(active, { continueQueue: false }));

  assert.equal(active.status, 'completed');
  assert.equal(app.turnCoordinator.operation, null);
  assert.equal(app.currentItemId, null);
  assert.equal(app.currentTurnId, null);
  assert.equal(app.currentManualSend, false);
  assert.equal(reported.length, 3);
  assert.match(reported.join('\n'), /usage cleanup failed/);
  assert.match(reported.join('\n'), /archive failed/);
  assert.match(reported.join('\n'), /state failed/);
});

test('queued compact start failure clears command waiters and active state', async () => {
  const command = item('compact-failure', 'pending', { text: '/compact' });
  const app = makeAppWithQueue([command]);
  app.beginQueuedCommandUsage = async () => {};
  app.rpc = { request: async () => { throw new Error('compact start failed'); } };

  await app.executeQueuedCommand(command, { continueQueue: false });

  assert.equal(command.status, 'failed');
  assert.equal(app.currentQueueCommand, null);
  assert.equal(app.currentQueueCommandResolve, null);
  assert.equal(app.currentQueueCommandReject, null);
  assert.equal(app.currentQueueCommandTimer, null);
  assert.equal(app.currentItemId, null);
  assert.equal(app.currentManualSend, false);
});

test('removing a manually scheduled pending item does not block future manual sends', async () => {
  const first = item('manual-pending');
  const second = item('next-manual');
  const app = makeAppWithQueue([first, second]);
  app.pendingManualSendItemId = first.id;
  app.currentManualSend = true;

  await app.removeQueueItem(first.id);

  assert.equal(app.pendingManualSendItemId, null);
  assert.equal(app.currentManualSend, false);
  app.movePendingToFirst = async () => ({ ok: true, item: second });
  app.runCountdownAndSend = async () => {};
  app.rateLimits.status = 'available';
  const result = await app.sendItemNow(second);
  assert.equal(result.ok, true);
});

test('late started and duplicate terminal events are ignored after completion', async () => {
  const active = item('completed-once', 'sending');
  const app = makeAppWithQueue([active]);
  app.tryReadSession = async () => {};
  app.turnCoordinator.begin({ threadId: 'session', itemId: active.id });
  app.turnCoordinator.acceptTurn('turn-once');

  app.handleNotification('turn/completed', {
    threadId: 'session',
    turn: { id: 'turn-once', status: 'completed' },
  });
  const outputCount = app.output.length;

  app.handleNotification('turn/started', {
    threadId: 'session',
    turn: { id: 'turn-once' },
  });
  app.handleNotification('turn/completed', {
    threadId: 'session',
    turn: { id: 'turn-once', status: 'completed' },
  });

  assert.equal(active.status, 'completed');
  assert.equal(app.output.length, outputCount);
});

test('queue move helpers roll back ordering when persistence fails', async () => {
  const first = item('first');
  const second = item('second');
  const app = makeAppWithQueue([first, second]);
  app.saveQueue = async () => { throw new Error('disk full'); };

  await assert.rejects(() => app.movePendingToNext(second), /disk full/);
  assert.deepEqual(app.queue.map((queueItem) => queueItem.id), ['first', 'second']);

  await assert.rejects(() => app.movePendingToFirst(app.queue.find((queueItem) => queueItem.id === 'second')), /disk full/);
  assert.deepEqual(app.queue.map((queueItem) => queueItem.id), ['first', 'second']);
});

test('pump marks a fully archived JSONL queue done instead of leaving it watching', async () => {
  const app = makeAppWithQueue([]);
  app.completedArchiveTotal = 2;
  app.app.state = 'watching';
  app.app.sessionId = 'session';

  await app.pumpQueue();

  assert.equal(app.app.state, 'done');
  assert.match(app.output.at(-1).text, /queue.*completed/);
});
