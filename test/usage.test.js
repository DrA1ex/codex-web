'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { calculateLimitDeltas, normalizeTokenBreakdown } = require('../src/app/usage');
const { item, makeAppWithQueue } = require('./helpers');

test('calculateLimitDeltas reports positive matching window deltas only', () => {
  const started = {
    buckets: [{
      limitId: 'codex',
      limitName: 'codex',
      windows: [
        { name: 'primary', usedPercent: 20, windowDurationMins: 300 },
        { name: 'secondary', usedPercent: 50, windowDurationMins: 10080 },
      ],
    }],
  };
  const finished = {
    buckets: [{
      limitId: 'codex',
      limitName: 'codex',
      windows: [
        { name: 'primary', usedPercent: 23, windowDurationMins: 300 },
        { name: 'secondary', usedPercent: 49, windowDurationMins: 10080 },
      ],
    }],
  };

  assert.deepEqual(calculateLimitDeltas(started, finished), [{
    limitId: 'codex',
    limitName: 'codex',
    window: '5h',
    windowDurationMins: 300,
    usedPercent: 3,
  }]);
});

test('normalizeTokenBreakdown keeps app-server token usage fields numeric', () => {
  assert.deepEqual(normalizeTokenBreakdown({
    inputTokens: 10,
    cachedInputTokens: 4,
    outputTokens: 6,
    reasoningOutputTokens: 2,
    totalTokens: 18,
  }), {
    inputTokens: 10,
    cachedInputTokens: 4,
    outputTokens: 6,
    reasoningOutputTokens: 2,
    totalTokens: 18,
  });

  assert.equal(normalizeTokenBreakdown(null), null);
});

test('refreshPreviousQueueItemUsage updates the same completed item', async () => {
  const done = item('done', 'completed');
  done.usage = {
    threadId: 'session',
    turnId: 'turn-done',
    tokenUsage: null,
    startedLimits: {
      buckets: [{
        limitId: 'codex',
        limitName: 'codex',
        windows: [{ name: 'primary', usedPercent: 10, windowDurationMins: 300 }],
      }],
    },
    finishedLimits: null,
    refreshedLimits: null,
    limitDeltas: [],
    limitDeltaScope: 'account',
    usageStatus: 'pending',
    usageUpdatedAt: new Date(0).toISOString(),
    refreshPending: true,
  };
  const app = makeAppWithQueue([done]);
  app.pendingUsageRefreshItemId = 'done';
  app.rpc = {
    request: async () => ({
      rateLimits: {
        limitId: 'codex',
        limitName: 'codex',
        primary: { usedPercent: 13, windowDurationMins: 300 },
      },
    }),
  };

  const updated = await app.refreshPreviousQueueItemUsage();

  assert.equal(updated, true);
  assert.equal(done.usage.refreshPending, false);
  assert.deepEqual(done.usage.limitDeltas.map((delta) => [delta.window, delta.usedPercent]), [['5h', 3]]);
  assert.equal(app.pendingUsageRefreshItemId, null);
});

test('foreign token usage notifications cannot overwrite current session context', async () => {
  const active = item('active', 'sent');
  active.usage = { threadId: 'session', turnId: 'turn-active' };
  const app = makeAppWithQueue([active]);
  app.currentItemId = 'active';
  app.currentTurnId = 'turn-active';
  app.app.contextTokens = 100;

  const handled = app.handleTokenUsageUpdated({
    threadId: 'foreign-session',
    turnId: 'foreign-turn',
    totalTokens: 999,
    tokenUsage: { totalTokens: 999 },
  });

  assert.equal(handled, false);
  assert.equal(app.app.contextTokens, 100);
});

test('late token usage updates persist into the recent completed archive', async () => {
  const done = item('done', 'completed');
  done.usage = { threadId: 'session', turnId: 'turn-done', usageStatus: 'pending' };
  const app = makeAppWithQueue([]);
  app.completedArchivePath = '/virtual/completed.jsonl';
  app.completedArchiveRecent = [done];
  let archived = null;
  app.archiveCompletedItem = async (queueItem) => { archived = structuredClone(queueItem); };

  const handled = app.handleTokenUsageUpdated({
    threadId: 'session',
    turnId: 'turn-done',
    tokenUsage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(handled, true);
  assert.deepEqual(done.usage.tokenUsage, {
    inputTokens: 4,
    cachedInputTokens: 0,
    outputTokens: 3,
    reasoningOutputTokens: 0,
    totalTokens: 7,
  });
  assert.equal(archived.id, 'done');
  assert.equal(archived.usage.tokenUsage.totalTokens, 7);
});

test('usage refresh keeps retry ownership and refreshPending when persistence fails', async () => {
  const done = item('done', 'completed');
  done.usage = {
    threadId: 'session',
    turnId: 'turn-done',
    startedLimits: { buckets: [] },
    refreshPending: true,
  };
  const app = makeAppWithQueue([done]);
  app.pendingUsageRefreshItemId = 'done';
  app.rpc = { request: async () => ({ rateLimits: [] }) };
  app.saveQueue = async () => { throw new Error('disk unavailable'); };

  await assert.rejects(() => app.refreshPreviousQueueItemUsage(), /disk unavailable/);

  assert.equal(app.pendingUsageRefreshItemId, 'done');
  assert.equal(done.usage.refreshPending, true);
});

test('thread token reads ignore stale responses after a session switch', async () => {
  const app = makeAppWithQueue([]);
  app.app.contextTokens = 100;
  let resolveRead;
  app.rpc = { request: async () => await new Promise((resolve) => { resolveRead = resolve; }) };

  const reading = app.readThreadTokenCount();
  await new Promise((resolve) => setImmediate(resolve));
  app.app.sessionId = 'new-session';
  resolveRead({ thread: { tokenUsage: { totalTokens: 999 } } });

  assert.equal(await reading, null);
  assert.equal(app.app.contextTokens, 100);
});
