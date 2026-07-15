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
