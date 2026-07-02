'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { CodexLimitWatchApp } = require('../src/app');
const { item, tempDir, makeAppWithQueue } = require('./helpers');

test('setupPairState creates per-session paths, acquires lock, loads state and queue', async () => {
  const dir = await tempDir();
  const app = makeAppWithQueue([], { stateDir: dir, projectDir: process.cwd(), logJsonrpc: true, force: true });
  app.saveQueue = CodexLimitWatchApp.prototype.saveQueue.bind(app);
  app.saveState = CodexLimitWatchApp.prototype.saveState.bind(app);
  let synced = false;
  app.syncModelConfigState = async () => { synced = true; };

  await app.setupPairState('session-a');

  assert.equal(fs.existsSync(app.stateDirForPair), true);
  assert.equal(path.basename(app.queuePath), 'queue.json');
  assert.equal(path.basename(app.statePath), 'state.json');
  assert.equal(path.basename(app.jsonRpcLogPath), 'jsonrpc.log');
  assert.equal(app.lockAcquired, true);
  assert.equal(synced, true);
  assert.deepEqual(JSON.parse(await fsp.readFile(app.queuePath, 'utf8')), []);
  assert.equal(app.debug.queuePath, app.queuePath);

  app.releaseLock();
  assert.equal(app.lockAcquired, false);
});

test('acquireLock rejects a live existing lock unless force is enabled', async () => {
  const dir = await tempDir();
  const app = makeAppWithQueue([], { stateDir: dir, force: false });
  app.lockPath = path.join(dir, 'app.lock');
  await fsp.writeFile(app.lockPath, JSON.stringify({ pid: process.pid, url: 'http://example.local' }));

  await assert.rejects(() => app.acquireLock(), /Another codex-web instance/);

  app.opts.force = true;
  await app.acquireLock();
  assert.equal(app.lockAcquired, true);
  app.releaseLock();
});

test('loadQueue recovers interrupted sending items as unknown', async () => {
  const dir = await tempDir();
  const queuePath = path.join(dir, 'queue.json');
  await fsp.writeFile(queuePath, JSON.stringify([
    { id: 'sending', text: 'was sending', status: 'sending' },
    { id: 'sent', text: 'was sent', status: 'sent' },
    { id: 'next', text: 'was next', status: 'next' },
    { id: 'pending', text: 'still pending', status: 'pending' },
  ]));
  const app = makeAppWithQueue([]);
  app.queuePath = queuePath;
  app.saveQueue = CodexLimitWatchApp.prototype.saveQueue.bind(app);

  await app.loadQueue();

  assert.deepEqual(app.queue.map((i) => i.status), ['unknown', 'unknown', 'pending', 'pending']);
  assert.match(app.queue[0].error, /Previous run exited/);
  assert.match(app.queue[1].error, /Previous run exited/);
  const persisted = JSON.parse(await fsp.readFile(queuePath, 'utf8'));
  assert.deepEqual(persisted.map((i) => i.status), ['unknown', 'unknown', 'pending', 'pending']);
});

test('loadQueue backs up corrupted queue file and starts empty', async () => {
  const dir = await tempDir();
  const queuePath = path.join(dir, 'queue.json');
  await fsp.writeFile(queuePath, '{not json');
  const app = makeAppWithQueue([]);
  app.queuePath = queuePath;
  app.eventsLogPath = path.join(dir, 'events.log');
  app.saveQueue = CodexLimitWatchApp.prototype.saveQueue.bind(app);

  await app.loadQueue();

  assert.deepEqual(app.queue, []);
  assert.deepEqual(JSON.parse(await fsp.readFile(queuePath, 'utf8')), []);
  assert.equal(fs.readdirSync(dir).some((name) => /^queue\.json\.corrupt\..+\.bak$/.test(name)), true);
  assert.equal(app.output.at(-1).type, 'error');
});

test('loadState respects command-line model/effort overrides and restores schedule', async () => {
  const dir = await tempDir();
  const statePath = path.join(dir, 'state.json');
  const scheduled = new Date(Date.now() + 60_000).toISOString();
  await fsp.writeFile(statePath, JSON.stringify({ model: 'stored-model', effort: 'high', scheduledRunAt: scheduled }));

  const app = makeAppWithQueue([], { model: '', effort: '', modelProvided: false, effortProvided: false });
  app.statePath = statePath;
  await app.loadState();
  assert.equal(app.opts.model, 'stored-model');
  assert.equal(app.opts.effort, 'high');
  assert.equal(app.app.scheduledRunAt, scheduled);

  const override = makeAppWithQueue([], { model: 'cli-model', effort: 'low', modelProvided: true, effortProvided: true });
  override.statePath = statePath;
  await override.loadState();
  assert.equal(override.opts.model, 'cli-model');
  assert.equal(override.opts.effort, 'low');
});

test('settings and state files are saved and loaded', async () => {
  const dir = await tempDir();
  const app = makeAppWithQueue([], { stateDir: dir });
  app.settingsPath = path.join(dir, 'settings.json');
  app.statePath = path.join(dir, 'state.json');
  app.app.theme = 'light';
  app.app.scheduledRunAt = '2026-01-01T00:00:00.000Z';
  app.saveSettings = CodexLimitWatchApp.prototype.saveSettings.bind(app);
  app.saveState = CodexLimitWatchApp.prototype.saveState.bind(app);

  await app.saveSettings();
  await app.saveState();

  const loaded = makeAppWithQueue([], { stateDir: dir });
  loaded.settingsPath = app.settingsPath;
  await loaded.loadSettings();
  assert.equal(loaded.app.theme, 'light');

  const state = JSON.parse(await fsp.readFile(app.statePath, 'utf8'));
  assert.equal(state.sessionId, 'session');
  assert.equal(state.scheduledRunAt, '2026-01-01T00:00:00.000Z');
});

test('eventLog and debugLog append log lines when a path is configured', async () => {
  const dir = await tempDir();
  const app = makeAppWithQueue([]);
  app.eventLog = CodexLimitWatchApp.prototype.eventLog.bind(app);
  app.debugLog = CodexLimitWatchApp.prototype.debugLog.bind(app);
  app.eventsLogPath = path.join(dir, 'events.log');

  app.eventLog('info', 'hello');
  app.debugLog('debug message', 'payload');
  await new Promise((resolve) => setTimeout(resolve, 80));

  const text = await fsp.readFile(app.eventsLogPath, 'utf8');
  assert.match(text, /info hello/);
  assert.match(text, /debug debug message payload/);
});
