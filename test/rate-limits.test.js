'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizeRateLimits, markRateLimitRefreshFailed } = require('../src/codex/rate-limits');
const { waitForAvailableLimits, setWaitingForLimits, setRefreshingLimits } = require('../src/app/limit-wait');
const { makeAppWithQueue } = require('./helpers');

test('rate limits normalize available, limited, and unknown responses', () => {
  const available = normalizeRateLimits({
    rateLimitsByLimitId: {
      codex: {
        limitId: 'codex',
        limitName: 'codex',
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1000 },
        secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: 2000 },
      },
    },
    rateLimitResetCredits: 3,
  });
  assert.equal(available.status, 'available');
  assert.equal(available.buckets[0].remainingPercent, undefined);
  assert.equal(available.buckets[0].windows[0].remainingPercent, 75);
  assert.equal(available.resetCredits, 3);

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
  assert.equal(unknown.refreshing, false);
});

test('failed rate-limit refresh preserves stale known limits but marks empty state refreshing', () => {
  const err = new Error('temporary fetch failure');
  const known = normalizeRateLimits({ rateLimits: { limitId: 'codex', primary: { usedPercent: 10 } } });
  const stale = markRateLimitRefreshFailed(known, err);
  assert.equal(stale.status, 'available');
  assert.equal(stale.stale, true);
  assert.equal(stale.refreshing, true);
  assert.equal(stale.refreshError, 'temporary fetch failure');
  assert.equal(stale.lastSuccessfulUpdatedAt, known.updatedAt);

  const empty = markRateLimitRefreshFailed({ status: 'unknown', buckets: [] }, err);
  assert.equal(empty.status, 'unknown');
  assert.equal(empty.refreshing, true);
  assert.equal(empty.refreshError, 'temporary fetch failure');
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
    err.data = { apiKey: 'secret', nested: { token: 'also-secret' }, reason: 'no response' };
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

test('waitForAvailableLimits handles limited, refreshing, unknown, and available states', async () => {
  const app = makeAppWithQueue([]);
  app.opts.watchInterval = 30;

  app.rateLimits = { status: 'limited', resetAt: Math.floor(Date.now() / 1000) + 500, buckets: [] };
  assert.equal(await waitForAvailableLimits(app, 'auto-send'), true);
  assert.equal(app.app.state, 'waiting-limits');
  assert.match(app.app.message, /Waiting for limit reset/);
  assert.equal(app.lastScheduledDelay, 30_000);

  app.rateLimits = { status: 'available', refreshing: true, buckets: [] };
  app.pollRateLimits = async () => {};
  assert.equal(await waitForAvailableLimits(app, 'manual send'), true);
  assert.equal(app.app.state, 'waiting-limits');
  assert.match(app.app.message, /Refreshing limits/);

  app.rateLimits = { status: 'unknown', refreshing: false, buckets: [] };
  app.pollRateLimits = async () => { app.rateLimits = { status: 'unknown', refreshing: false, buckets: [] }; };
  assert.equal(await waitForAvailableLimits(app, 'auto-send'), true);
  assert.match(app.app.message, /Limits unknown/);

  app.rateLimits = { status: 'available', refreshing: false, buckets: [] };
  assert.equal(await waitForAvailableLimits(app, 'auto-send'), false);
});

test('limit waiting helpers set user-facing state messages', () => {
  const appState = { state: 'watching', message: '' };
  const noResetDelay = setWaitingForLimits(appState, { resetAt: null }, 45);
  assert.equal(noResetDelay, 45_000);
  assert.equal(appState.state, 'waiting-limits');
  assert.equal(appState.message, 'Waiting for rate limits');

  setRefreshingLimits(appState, 'manual send');
  assert.equal(appState.state, 'waiting-limits');
  assert.equal(appState.message, 'Refreshing limits; retrying before manual send');
});
