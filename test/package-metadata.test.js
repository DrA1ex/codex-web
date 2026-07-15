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
  assert.equal(pkg.scripts.e2e, 'node scripts/run-e2e.js');
  assert.match(pkg.scripts.validate, /npm run check/);
  assert.match(pkg.scripts.validate, /npm test/);
  assert.match(pkg.scripts.validate, /npm run e2e/);
  assert.equal(pkg.devDependencies.playwright, '1.61.1');
});


test('package exposes the codex-web executable for npm link', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.bin, { 'codex-web': './codex-web' });
  const launcher = path.join(ROOT, pkg.bin['codex-web']);
  assert.equal(fs.statSync(launcher).isFile(), true);
  if (process.platform !== 'win32') {
    assert.notEqual(fs.statSync(launcher).mode & 0o111, 0);
  }
});

test('README is user-focused and links contributor documentation', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const development = fs.readFileSync(path.join(ROOT, 'docs', 'DEVELOPMENT.md'), 'utf8');
  assert.match(readme, /npm link/);
  assert.match(readme, /docs\/DEVELOPMENT\.md/);
  assert.doesNotMatch(readme, /E2E_PARALLEL_PROCESSES|E2E_FILE_TIMEOUT_MS|mock app-server process/);
  assert.match(development, /E2E_PARALLEL_PROCESSES/);
  assert.match(development, /Mock app-server/);
});
