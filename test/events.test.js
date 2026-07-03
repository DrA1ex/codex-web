'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { item, makeAppWithQueue } = require('./helpers');

test('handleNotification updates rate limits and app state for turn lifecycle events', async () => {
  const active = item('active', 'sending');
  const app = makeAppWithQueue([active]);
  app.currentItemId = 'active';
  let resolved = false;
  app.currentTurnResolve = () => { resolved = true; };
  app.tryReadSession = async () => {};

  app.handleNotification('account/rateLimits/updated', { rateLimits: { limitId: 'codex', primary: { usedPercent: 20 } } });
  assert.equal(app.rateLimits.status, 'available');

  app.handleNotification('turn/started', { turn: { id: 'turn-1' } });
  assert.equal(app.currentTurnId, 'turn-1');
  assert.equal(active.status, 'sent');
  assert.equal(app.app.state, 'streaming');
  assert.match(app.output.at(-1).text, /started/);

  app.handleNotification('turn/completed', { turn: { status: 'completed' } });
  assert.equal(active.status, 'completed');
  assert.equal(resolved, true);
  assert.match(app.output.at(-1).text, /completed/);
});

test('handleNotification marks failed turns, appends error, and pauses queue', () => {
  const active = item('active', 'sending');
  const app = makeAppWithQueue([active]);
  app.currentItemId = 'active';
  app.currentTurnId = 'turn-1';
  app.tryReadSession = async () => {};

  app.handleNotification('turn/failed', { turn: { status: 'failed', error: { message: 'boom' } } });

  assert.equal(active.status, 'failed');
  assert.equal(active.error, 'boom');
  assert.equal(app.app.state, 'paused');
  assert.match(app.app.message, /turn failure/);
});

test('thread token usage notifications attach only to matching active turn', () => {
  const active = item('active', 'sent');
  const app = makeAppWithQueue([active]);
  app.currentItemId = 'active';
  app.currentTurnId = 'turn-1';
  app.app.sessionId = 'thread-1';

  app.handleNotification('thread/tokenUsage/updated', {
    threadId: 'other-thread',
    turnId: 'turn-1',
    tokenUsage: { last: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 2 } },
  });
  assert.equal(active.usage, null);

  app.handleNotification('thread/tokenUsage/updated', {
    threadId: 'thread-1',
    turnId: 'other-turn',
    tokenUsage: { last: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 2 } },
  });
  assert.equal(active.usage, null);

  app.handleNotification('thread/tokenUsage/updated', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    tokenUsage: { last: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 6, reasoningOutputTokens: 2, totalTokens: 18 } },
  });

  assert.equal(active.usage.threadId, 'thread-1');
  assert.equal(active.usage.turnId, 'turn-1');
  assert.equal(active.usage.tokenUsage.totalTokens, 18);
});

test('thread token usage notifications can update a finished matching item', () => {
  const done = item('done', 'completed');
  done.usage = {
    threadId: 'thread-1',
    turnId: 'turn-done',
    tokenUsage: null,
    startedLimits: null,
    finishedLimits: null,
    refreshedLimits: null,
    limitDeltas: [],
    limitDeltaScope: 'account',
    usageStatus: 'pending',
    usageUpdatedAt: new Date(0).toISOString(),
    refreshPending: false,
  };
  const app = makeAppWithQueue([done]);
  app.app.sessionId = 'thread-1';
  app.currentItemId = null;
  app.currentTurnId = null;

  app.handleNotification('thread/tokenUsage/updated', {
    threadId: 'thread-1',
    turnId: 'turn-done',
    tokenUsage: { last: { inputTokens: 2, cachedInputTokens: 1, outputTokens: 3, reasoningOutputTokens: 0, totalTokens: 5 } },
  });

  assert.equal(done.usage.tokenUsage.totalTokens, 5);
});

test('handleNotification routes item, delta, plan, diff, and error events to output handlers', () => {
  const app = makeAppWithQueue([]);

  app.handleNotification('error', { error: { message: 'bad event' } });
  assert.equal(app.output.at(-1).type, 'error');

  app.handleNotification('item/started', { item: { id: 'cmd-1', type: 'commandExecution', command: ['npm', 'test'] } });
  assert.equal(app.output.at(-1).tool.command, 'npm test');

  app.handleNotification('item/commandExecution/outputDelta', { item: { id: 'cmd-1' }, delta: 'line\n' });
  assert.equal(app.output.at(-1).tool.output, 'line\n');

  app.handleNotification('item/completed', { item: { id: 'cmd-1', type: 'commandExecution', status: 'completed', exitCode: 0 } });
  assert.equal(app.output.at(-1).tool.active, false);

  app.handleNotification('item/started', { item: { type: 'reasoning' } });
  assert.equal(app.output.at(-1).type, 'reasoning');

  app.handleNotification('turn/delta', { delta: 'hello ' });
  app.handleNotification('turn/delta', { delta: 'world' });
  assert.equal(app.output.at(-1).text, 'hello world');

  app.handleNotification('turn/summary/delta', { delta: 'summary' });
  assert.equal(app.output.at(-1).type, 'context-delta');

  app.handleNotification('turn/plan/updated', { plan: [{ status: 'pending', step: 'write tests' }] });
  assert.equal(app.output.at(-1).type, 'plan');
  assert.match(app.output.at(-1).text, /write tests/);

  app.handleNotification('turn/diff/updated', { diff: { unified: 'diff --git a/a b/a\n--- a/a\n+++ b/a\n-old\n+new' } });
  assert.equal(app.output.at(-1).type, 'diff');
  assert.equal(app.output.at(-1).diff.caption, 'a');

  app.opts.debug = true;
  app.handleNotification('unknown/event', { token: 'secret', a: 1 });
  assert.equal(app.output.at(-1).type, 'event');
});

test('handleServerRequest auto-responds configured approvals and built-in server requests', async () => {
  const app = makeAppWithQueue([], { approvalResponse: 'accept-for-session' });
  const responses = [];
  app.rpc = { respond: (...args) => { responses.push(args); } };

  await app.handleServerRequest({ id: 1, method: 'item/fileChange/requestApproval', params: { requestId: 'r1' } });
  assert.deepEqual(responses[0], [1, 'acceptForSession']);
  assert.match(app.output.at(-1).text, /accept-for-session/);

  await app.handleServerRequest({ id: 2, method: 'currentTime/read', params: {} });
  assert.equal(typeof responses[1][1].currentTimeAt, 'number');

  await app.handleServerRequest({ id: 3, method: 'item/tool/requestUserInput', params: {} });
  assert.deepEqual(responses[2], [3, { action: 'decline', content: null }]);

  await app.handleServerRequest({ id: 4, method: 'unsupported/request', params: {} });
  assert.equal(responses[3][2], true);
  assert.equal(responses[3][1].code, -32601);
});

test('manual approval requests can be resolved, responded to, and auto-rejected', async () => {
  const app = makeAppWithQueue([], { approvalResponse: 'manual' });
  const responses = [];
  app.rpc = { respond: (...args) => { responses.push(args); } };
  app.scheduleApprovalTimeout = (requestId) => { app.scheduledApprovalRequestId = requestId; };
  app.clearApprovalTimeout = () => { app.clearedApprovalTimeout = true; };

  await app.handleServerRequest({ id: 1, method: 'item/fileChange/requestApproval', params: { requestId: 'req-1' } });
  assert.equal(app.approval.requestId, 'req-1');
  assert.equal(app.app.state, 'approval-required');
  assert.equal(app.scheduledApprovalRequestId, 'req-1');

  await app.respondApproval('accept');
  assert.deepEqual(responses[0], [1, 'accept']);
  assert.equal(app.approval, null);
  assert.equal(app.app.state, 'watching');

  await app.handleServerRequest({ id: 2, method: 'item/fileChange/requestApproval', params: { requestId: 'req-2' } });
  await app.autoRejectApproval('wrong');
  assert.ok(app.approval);
  await app.autoRejectApproval('req-2');
  assert.deepEqual(responses[1], [2, 'decline']);
  assert.equal(app.approval, null);
  assert.equal(app.app.state, 'paused');
});

test('serverRequest/resolved clears matching approval and resumes if required', () => {
  const app = makeAppWithQueue([]);
  app.approval = { requestId: 'req-1', rpcId: 1 };
  app.app.state = 'approval-required';
  app.clearApprovalTimeout = () => { app.clearedApprovalTimeout = true; };

  app.handleNotification('serverRequest/resolved', { requestId: 'req-1' });

  assert.equal(app.approval, null);
  assert.equal(app.clearedApprovalTimeout, true);
  assert.equal(app.app.state, 'watching');
});
