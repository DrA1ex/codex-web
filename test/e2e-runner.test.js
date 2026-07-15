'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const {
  collectCounts,
  createJobs,
} = require('../scripts/run-e2e');

test('E2E discovery counts nested Playwright suites and skips invalid specs', () => {
  const counts = collectCounts([
    {
      specs: [
        { file: 'alpha.spec.js', ok: true },
        { file: 'alpha.spec.js', ok: true },
        { file: 'ignored.spec.js', ok: false },
      ],
      suites: [
        {
          specs: [
            { file: 'beta.spec.js', ok: true },
            { file: 'alpha.spec.js', ok: true },
          ],
        },
      ],
    },
  ]);

  assert.deepEqual([...counts.entries()].sort(), [
    ['alpha.spec.js', 3],
    ['beta.spec.js', 1],
  ]);
});

test('E2E jobs shard large spec files without losing or duplicating tests', () => {
  const counts = new Map([
    ['small.spec.js', 3],
    ['large.spec.js', 17],
  ]);
  const jobs = createJobs(counts, 8);

  assert.deepEqual(jobs, [
    { file: path.join('e2e', 'large.spec.js'), count: 17, shard: 1, shards: 3 },
    { file: path.join('e2e', 'large.spec.js'), count: 17, shard: 2, shards: 3 },
    { file: path.join('e2e', 'large.spec.js'), count: 17, shard: 3, shards: 3 },
    { file: path.join('e2e', 'small.spec.js'), count: 3, shard: 1, shards: 1 },
  ]);
});

test('E2E jobs clamp an invalid shard limit to one test per process', () => {
  const jobs = createJobs(new Map([['edge.spec.js', 2]]), 0);
  assert.deepEqual(jobs, [
    { file: path.join('e2e', 'edge.spec.js'), count: 2, shard: 1, shards: 2 },
    { file: path.join('e2e', 'edge.spec.js'), count: 2, shard: 2, shards: 2 },
  ]);
});

test('E2E parallel process count defaults to two and respects host capacity', () => {
  const { resolveParallelProcesses } = require('../scripts/run-e2e');
  assert.equal(resolveParallelProcesses(undefined, 16), 2);
  assert.equal(resolveParallelProcesses(undefined, 1), 1);
  assert.equal(resolveParallelProcesses('4', 3), 3);
  assert.equal(resolveParallelProcesses('0', 8), 1);
  assert.equal(resolveParallelProcesses('invalid', 8), 1);
});

test('E2E job pool never exceeds configured concurrency', async () => {
  const { runJobPool } = require('../scripts/run-e2e');
  const jobs = Array.from({ length: 9 }, (_, id) => ({ id }));
  let active = 0;
  let peak = 0;
  const seen = [];

  const status = await runJobPool(jobs, 3, async (job) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    seen.push(job.id);
    active -= 1;
    return 0;
  });

  assert.equal(status, 0);
  assert.equal(peak, 3);
  assert.deepEqual(seen.sort((a, b) => a - b), jobs.map((job) => job.id));
});

test('E2E job pool stops scheduling new jobs after a batch fails', async () => {
  const { runJobPool } = require('../scripts/run-e2e');
  const started = [];
  const status = await runJobPool([0, 1, 2, 3, 4], 2, async (job) => {
    started.push(job);
    if (job === 1) return 7;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return 0;
  });

  assert.equal(status, 7);
  assert.equal(started.includes(1), true);
  assert.equal(started.includes(4), false);
});
