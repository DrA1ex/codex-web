'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

test('package lock uses only public npm registry URLs', () => {
  const lockText = fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8');
  const lock = JSON.parse(lockText);
  assert.equal(lock.lockfileVersion, 3);
  assert.doesNotMatch(lockText, /openai\.org|internal\.api|artifactory/i);
  for (const entry of Object.values(lock.packages || {})) {
    if (!entry?.resolved) continue;
    assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//);
  }
});

test('development scripts expose unit, E2E, and aggregate validation commands', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node --test test/*.test.js');
  assert.equal(pkg.scripts.e2e, 'playwright test');
  assert.match(pkg.scripts.validate, /npm run check/);
  assert.match(pkg.scripts.validate, /npm test/);
  assert.match(pkg.scripts.validate, /npm run e2e/);
  assert.equal(pkg.devDependencies.playwright, '1.61.1');
});
