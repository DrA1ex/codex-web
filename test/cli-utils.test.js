'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { parseArgs, validateOptions } = require('../src/cli');
const {
  randomId,
  sha256,
  homeExpand,
  isLocalHost,
  toBool,
  safeJson,
  truncate,
  lineCount,
  previewOf,
  normalizeProjectDir,
  ensureDirSync,
  stripTrailingSep,
  pathRelation,
  asArray,
  maskSecrets,
  friendlyStartError,
  isPidAlive,
  shortId,
} = require('../src/shared/utils');
const { tempDir } = require('./helpers');

test('parseArgs normalizes CLI options and validates supported values', async () => {
  const extraDir = await tempDir();
  const opts = parseArgs([
    'session-1',
    '--host', '0.0.0.0',
    '--port', '8080',
    '--no-open',
    '--state-dir', './state',
    '--codex-bin', '/bin/codex',
    '--project-dir', process.cwd(),
    '--all-sessions',
    '--session-picker-limit', '0',
    '--watch-interval', '1',
    '--countdown', '-1',
    '--model', 'gpt-a',
    '--effort', 'high',
    '--sandbox', 'read-only',
    '--approval-policy', 'never',
    '--approval-response', 'manual',
    '--network', 'false',
    '--add-dir', extraDir,
    '--log-jsonrpc',
    '--debug',
    '--force',
  ]);

  assert.equal(opts.sessionId, 'session-1');
  assert.equal(opts.host, '0.0.0.0');
  assert.equal(opts.port, 8080);
  assert.equal(opts.noOpen, true);
  assert.equal(opts.watchInterval, 5);
  assert.equal(opts.countdown, 0);
  assert.equal(opts.sessionPickerLimit, 50);
  assert.equal(opts.modelProvided, true);
  assert.equal(opts.effortProvided, true);
  assert.equal(opts.network, false);
  assert.deepEqual(opts.addDirs, [fs.realpathSync(extraDir)]);
});

test('parseArgs defaults approvals to manual and records explicit safety overrides', () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.approvalResponse, 'manual');
  assert.equal(defaults.sandboxProvided, false);
  assert.equal(defaults.approvalPolicyProvided, false);
  assert.equal(defaults.approvalResponseProvided, false);

  const explicit = parseArgs([
    '--sandbox', 'read-only',
    '--approval-policy', 'on-request',
    '--approval-response', 'accept',
  ]);
  assert.equal(explicit.sandboxProvided, true);
  assert.equal(explicit.approvalPolicyProvided, true);
  assert.equal(explicit.approvalResponseProvided, true);
});

test('parseArgs and validateOptions reject bad inputs', () => {
  assert.throws(() => parseArgs(['--unknown']), /Unknown option/);
  assert.throws(() => parseArgs(['--port']), /Missing value/);
  assert.throws(() => validateOptions({ sandbox: 'bad', approvalPolicy: 'never', approvalResponse: 'manual', effort: '' }), /Unsupported --sandbox/);
  assert.throws(() => validateOptions({ sandbox: 'read-only', approvalPolicy: 'bad', approvalResponse: 'manual', effort: '' }), /Unsupported --approval-policy/);
  assert.throws(() => validateOptions({ sandbox: 'read-only', approvalPolicy: 'never', approvalResponse: 'bad', effort: '' }), /Unsupported --approval-response/);
  assert.throws(() => validateOptions({ sandbox: 'read-only', approvalPolicy: 'never', approvalResponse: 'manual', effort: 'too high' }), /Unsupported --effort/);
});

test('shared utility helpers cover paths, booleans, strings, and masking', async () => {
  const dir = await tempDir();
  const child = path.join(dir, 'child');
  ensureDirSync(child);

  assert.equal(randomId(8).length, 16);
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(homeExpand('~/x').startsWith(require('node:os').homedir()), true);
  assert.equal(isLocalHost('localhost'), true);
  assert.equal(isLocalHost('127.0.0.1'), true);
  assert.equal(isLocalHost('0.0.0.0'), false);
  assert.equal(toBool('yes', false), true);
  assert.equal(toBool('off', true), false);
  assert.equal(toBool('unknown', true), true);
  assert.equal(safeJson({ ok: true }), '{"ok":true}');
  const circular = {};
  circular.self = circular;
  assert.equal(safeJson(circular), '"[object Object]"');
  assert.equal(truncate('a b c', 10), 'a b c');
  assert.equal(truncate('x'.repeat(20), 5), 'xxxx…');
  assert.equal(lineCount('a\nb'), 2);
  assert.equal(previewOf('\n  first line\nsecond'), 'first line');
  assert.equal(normalizeProjectDir(dir), fs.realpathSync(dir));
  assert.throws(() => normalizeProjectDir(path.join(dir, 'missing')), /Project dir does not exist/);
  assert.equal(stripTrailingSep(child + path.sep), path.resolve(child));
  assert.equal(pathRelation(dir, dir), 0);
  assert.equal(pathRelation(dir, child), 1);
  assert.equal(pathRelation(child, dir), 2);
  assert.equal(pathRelation('/tmp/a', '/var/b'), 10);
  assert.deepEqual(asArray(null), []);
  assert.deepEqual(asArray('x'), ['x']);
  assert.deepEqual(maskSecrets({ token: 'secret', nested: { password: 'pw', value: 1 } }), { token: '[masked]', nested: { password: '[masked]', value: 1 } });
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(shortId('12345678901234567890'), '123456…7890');
});

test('friendlyStartError explains missing codex binary and general failures', () => {
  const missing = new Error('spawn ENOENT');
  missing.code = 'ENOENT';
  assert.match(friendlyStartError(missing, 'codex').message, /binary was not found/);
  assert.match(friendlyStartError(new Error('boom'), 'codex').message, /Reason: boom/);
});

test('numeric CLI options reject non-finite and invalid port values', () => {
  assert.throws(() => parseArgs(['--watch-interval', 'Infinity']), /Invalid numeric value.*watch-interval/);
  assert.throws(() => parseArgs(['--countdown', 'NaN']), /Invalid numeric value.*countdown/);
  assert.throws(() => parseArgs(['--session-picker-limit', 'many']), /Invalid numeric value.*session-picker-limit/);
  assert.throws(() => parseArgs(['--port', '-1']), /Unsupported --port/);
  assert.throws(() => parseArgs(['--port', '65536']), /Unsupported --port/);
  assert.throws(() => parseArgs(['--port', '8000.5']), /Unsupported --port/);

  const bounded = parseArgs([
    '--watch-interval', '999999999',
    '--countdown', '999999999',
    '--session-picker-limit', '999999999',
  ]);
  assert.equal(bounded.watchInterval, 86400);
  assert.equal(bounded.countdown, 86400);
  assert.equal(bounded.sessionPickerLimit, 1000);
});
