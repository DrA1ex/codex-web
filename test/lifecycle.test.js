'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const lifecycleMethods = require('../src/app/lifecycle');
const { item, makeAppWithQueue } = require('./helpers');

test('schedulePump and clearPumpTimer manage one active timer', () => {
  const app = makeAppWithQueue([]);
  Object.assign(app, {
    schedulePump: lifecycleMethods.schedulePump,
    clearPumpTimer: lifecycleMethods.clearPumpTimer,
    pumpQueue: async () => {},
    setError: (message) => { app.errorMessage = message; },
  });

  app.schedulePump(10_000);
  const firstTimer = app.pumpTimer;
  assert.ok(firstTimer);

  app.schedulePump(10_000);
  assert.ok(app.pumpTimer);
  assert.notEqual(app.pumpTimer, firstTimer);

  assert.equal(app.clearPumpTimer(), true);
  assert.equal(app.clearPumpTimer(), false);
});

test('processing and active prompt helpers follow state, turn, and queue statuses', () => {
  const app = makeAppWithQueue([item('sent', 'sent')]);
  assert.equal(app.hasActivePrompt(), true);
  assert.equal(app.isQueueProcessingActive(), false);

  app.app.state = 'streaming';
  assert.equal(app.isQueueProcessingActive(), true);

  app.app.state = 'paused';
  app.currentTurnId = 'turn-1';
  assert.equal(app.isQueueProcessingActive(), true);
  assert.equal(app.hasActivePrompt(), true);
});

test('pumpQueue does not start another item when queue still has a sent item', async () => {
  const active = item('active', 'sent');
  const pending = item('pending');
  const app = makeAppWithQueue([active, pending]);
  app.app.state = 'watching';
  app.rateLimits = { status: 'available', buckets: [], resetAt: null };
  app.runCountdownAndSend = async () => { throw new Error('should not start another item while sent item exists'); };

  await app.pumpQueue();

  assert.deepEqual(app.queue.map((queueItem) => [queueItem.id, queueItem.status]), [
    ['active', 'sent'],
    ['pending', 'pending'],
  ]);
  assert.equal(app.lastScheduledDelay, undefined);
});

test('canChangeSession blocks unsafe queue states and allows completed idle session', () => {
  const pending = makeAppWithQueue([item('pending')]);
  pending.app.state = 'watching';
  assert.equal(pending.canChangeSession(), false);

  const completed = makeAppWithQueue([item('done', 'completed')]);
  completed.app.state = 'done';
  assert.equal(completed.canChangeSession(), true);

  completed.approval = { rpcId: 1 };
  assert.equal(completed.canChangeSession(), false);

  const scheduled = makeAppWithQueue([item('pending')]);
  scheduled.app.state = 'scheduled';
  assert.equal(scheduled.canChangeSession(), false);
});

test('cancelSessionChange restores previous state and schedules pump for active return states', () => {
  const app = makeAppWithQueue([]);
  app.app.state = 'selecting-session';
  app.sessionPickerReturnState = 'watching';

  const result = app.cancelSessionChange();

  assert.deepEqual(result, { ok: true });
  assert.equal(app.app.state, 'watching');
  assert.equal(app.sessionPickerReturnState, null);
  assert.equal(app.lastScheduledDelay, 200);

  app.app.sessionId = null;
  app.app.state = 'selecting-session';
  assert.deepEqual(app.cancelSessionChange(), { ok: true });
});

test('pause and cancelPendingSend clear scheduled/manual state', () => {
  const app = makeAppWithQueue([item('pending')]);
  app.manualSendContinueQueue = true;
  app.currentManualSend = true;
  app.app.scheduledRunAt = new Date(Date.now() + 60_000).toISOString();

  app.cancelPendingSend();

  assert.equal(app.app.state, 'paused');
  assert.equal(app.app.scheduledRunAt, null);
  assert.equal(app.currentManualSend, false);
  assert.equal(app.manualSendContinueQueue, false);
  assert.match(app.output.at(-1).text, /Next prompt send cancelled/);
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

test('empty active queue can be paused and resumed explicitly', () => {
  const app = makeAppWithQueue([]);
  app.app.state = 'watching';

  let snap = app.snapshot();
  assert.equal(snap.app.canPause, true);
  assert.equal(snap.app.canResume, false);

  app.pause();
  snap = app.snapshot();
  assert.equal(app.app.state, 'paused');
  assert.equal(snap.app.canPause, false);
  assert.equal(snap.app.canResume, true);

  app.resume();
  snap = app.snapshot();
  assert.equal(app.app.state, 'watching');
  assert.equal(snap.app.canPause, true);
  assert.equal(snap.app.canResume, false);
});

test('resume respects approvals and schedules queue pump when unpaused', () => {
  const approval = makeAppWithQueue([]);
  approval.approval = { rpcId: 1 };
  approval.resume();
  assert.equal(approval.app.state, 'approval-required');
  assert.match(approval.app.message, /Resolve approval/);

  const app = makeAppWithQueue([]);
  app.app.state = 'paused';
  app.resume();
  assert.equal(app.app.state, 'watching');
  assert.equal(app.app.scheduledRunAt, null);
  assert.equal(app.lastScheduledDelay, 200);
});

test('interruptCurrentTurn sends app-server request and pauses after success', async () => {
  const app = makeAppWithQueue([]);
  const requests = [];
  app.currentTurnId = 'turn-1';
  app.rpc = { request: async (...args) => { requests.push(args); return {}; } };

  const result = await app.interruptCurrentTurn();

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(requests, [['turn/interrupt', { threadId: 'session', turnId: 'turn-1' }, 3000]]);
  assert.equal(app.app.state, 'paused');

  const idle = makeAppWithQueue([]);
  assert.deepEqual(await idle.interruptCurrentTurn(), { ok: false, message: 'No running prompt to interrupt.' });
});

test('setError switches app to error state and logs output', () => {
  const app = makeAppWithQueue([]);
  app.setError('boom');

  assert.equal(app.app.state, 'error');
  assert.equal(app.app.message, 'boom');
  assert.equal(app.output.at(-1).type, 'error');
});

test('app-server exit clears stale approval state and timeout', async () => {
  const app = makeAppWithQueue([]);
  let approvalBroadcast = 'unset';
  app.broadcast = (event, value) => {
    if (event === 'approval') approvalBroadcast = value;
  };
  app.approval = { rpcId: 1, requestId: 'approval-1' };
  app.approvalTimer = setTimeout(() => {}, 60_000);
  app.app.state = 'approval-required';

  await app.handleRpcExit(new Error('server gone'));

  assert.equal(app.approval, null);
  assert.equal(app.approvalTimer, null);
  assert.equal(approvalBroadcast, null);
  assert.equal(app.app.state, 'error');
});
