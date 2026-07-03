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
