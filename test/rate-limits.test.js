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
  assert.deepEqual(available.resetCredits, { availableCount: 3, expiresAt: null });

  const remainingOnly = normalizeRateLimits({
    rateLimits: {
      limitId: 'codex',
      primary: { remainingPercent: 0, windowDurationMins: 300 },
      secondary: { remaining_percent: 12, windowDurationMins: 10080 },
    },
  });
  assert.equal(remainingOnly.buckets[0].windows[0].remainingPercent, 0);
  assert.equal(remainingOnly.buckets[0].windows[1].remainingPercent, 12);

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

test('rate-limit reset request is required, delayed, short-lived, and consumes app-server credit', async () => {
  let now = 1_700_000_000_000;
  const calls = [];
  const app = makeAppWithQueue([]);
  app.nowMs = () => now;
  app.rateLimits = normalizeRateLimits({
    rateLimits: {
      limitId: 'codex',
      primary: { remainingPercent: 0, windowDurationMins: 300 },
      secondary: { remainingPercent: 55, windowDurationMins: 10080 },
    },
    rateLimitResetCredits: { availableCount: 2, expiresAt: 1_700_003_600 },
  });
  app.rpc = {
    exited: false,
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'account/rateLimitResetCredit/consume') return { outcome: 'reset' };
      if (method === 'account/rateLimits/read') {
        return { rateLimits: { limitId: 'codex', primary: { usedPercent: 0 } }, rateLimitResetCredits: { availableCount: 1 } };
      }
      return {};
    },
  };

  await assert.rejects(() => app.consumeLimitReset({ requestId: 'missing' }), /Request reset/);

  const requested = app.requestLimitReset().resetRequest;
  assert.equal(requested.availableCount, 2);
  assert.equal(requested.creditExpiresAt, 1_700_003_600);
  assert.equal(requested.waitMs, 5000);
  assert.match(requested.requestId, /^[a-f0-9]{16}$/);
  assert.equal(app.currentLimitResetRequest().requestId, requested.requestId);

  await assert.rejects(() => app.consumeLimitReset({ requestId: requested.requestId }), /not ready/);

  now += 5000;
  const consumed = await app.consumeLimitReset({ requestId: requested.requestId });
  assert.deepEqual(consumed, { ok: true, outcome: 'reset' });
  assert.equal(calls[0].method, 'account/rateLimitResetCredit/consume');
  assert.match(calls[0].params.idempotencyKey, /^[0-9a-f-]{36}$/);
  assert.equal(calls[1].method, 'account/rateLimits/read');
  assert.equal(app.limitResetRequest, null);
  assert.equal(app.rateLimits.buckets.length, 1);
});


test('concurrent rate-limit reset consumption shares one RPC request', async () => {
  let now = 1_700_000_000_000;
  let releaseConsume;
  const calls = [];
  const app = makeAppWithQueue([]);
  app.nowMs = () => now;
  app.rateLimits = normalizeRateLimits({
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 100, windowDurationMins: 300 },
      secondary: { usedPercent: 10, windowDurationMins: 10080 },
    },
    rateLimitResetCredits: { availableCount: 1 },
  });
  app.rpc = {
    exited: false,
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'account/rateLimitResetCredit/consume') {
        return await new Promise((resolve) => { releaseConsume = () => resolve({ outcome: 'reset' }); });
      }
      if (method === 'account/rateLimits/read') {
        return { rateLimits: { limitId: 'codex', primary: { usedPercent: 0 } }, rateLimitResetCredits: { availableCount: 0 } };
      }
      return {};
    },
  };

  const request = app.requestLimitReset().resetRequest;
  now += 5000;
  const first = app.consumeLimitReset({ requestId: request.requestId });
  const second = app.consumeLimitReset({ requestId: request.requestId });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((call) => call.method === 'account/rateLimitResetCredit/consume').length, 1);

  releaseConsume();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results, [
    { ok: true, outcome: 'reset' },
    { ok: true, outcome: 'reset' },
  ]);
  assert.equal(calls.filter((call) => call.method === 'account/rateLimits/read').length, 1);
  assert.equal(app.limitResetConsume, null);
});

test('rate-limit reset requests expire after one minute and can be requested again', async () => {
  let now = 1_700_000_000_000;
  const app = makeAppWithQueue([]);
  app.nowMs = () => now;
  app.rateLimits = normalizeRateLimits({
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 100, windowDurationMins: 300 },
      secondary: { usedPercent: 5, windowDurationMins: 10080 },
    },
    rateLimitResetCredits: { availableCount: 1, expiresAt: 1_700_003_600 },
  });

  const first = app.requestLimitReset().resetRequest;
  now += 61_000;

  await assert.rejects(() => app.consumeLimitReset({ requestId: first.requestId }), /expired/);
  assert.equal(app.limitResetRequest, null);

  const second = app.requestLimitReset().resetRequest;
  assert.notEqual(second.requestId, first.requestId);
});

test('rate-limit reset requires reset credit and exhausted 5h or weekly window', () => {
  const app = makeAppWithQueue([]);
  app.rateLimits = normalizeRateLimits({
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 25, windowDurationMins: 300 },
      secondary: { usedPercent: 40, windowDurationMins: 10080 },
    },
    rateLimitResetCredits: { availableCount: 1 },
  });
  assert.throws(() => app.requestLimitReset(), /No rate-limit reset/);

  app.rateLimits = normalizeRateLimits({
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 100, windowDurationMins: 300 },
      secondary: { usedPercent: 40, windowDurationMins: 10080 },
    },
    rateLimitResetCredits: { availableCount: 0 },
  });
  assert.throws(() => app.requestLimitReset(), /No rate-limit reset/);

  app.rateLimits = normalizeRateLimits({
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 20, windowDurationMins: 300 },
      secondary: { remainingPercent: 0, windowDurationMins: 10080 },
    },
    rateLimitResetCredits: { availableCount: 1 },
  });
  assert.equal(app.requestLimitReset().ok, true);
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
