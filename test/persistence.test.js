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

test('acquireLock rejects a live existing lock even with force and recovers a stale lock', async () => {
  const dir = await tempDir();
  const app = makeAppWithQueue([], { stateDir: dir, force: false });
  app.lockPath = path.join(dir, 'app.lock');
  await fsp.writeFile(app.lockPath, JSON.stringify({ pid: process.pid, url: 'http://example.local' }));

  await assert.rejects(() => app.acquireLock(), /Another codex-web instance/);

  app.opts.force = true;
  await assert.rejects(() => app.acquireLock(), /live lock cannot be overridden/i);

  await fsp.writeFile(app.lockPath, JSON.stringify({ pid: 99999999, url: 'http://stale.local' }));
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

test('saveQueue writes a restorable queue backup', async () => {
  const dir = await tempDir();
  const queuePath = path.join(dir, 'queue.json');
  const app = makeAppWithQueue([item('pending', 'pending'), item('done', 'completed')]);
  app.queuePath = queuePath;
  app.saveQueue = CodexLimitWatchApp.prototype.saveQueue.bind(app);

  await app.saveQueue();

  assert.deepEqual(JSON.parse(await fsp.readFile(queuePath, 'utf8')).map((i) => i.id), ['done', 'pending']);
  assert.deepEqual(JSON.parse(await fsp.readFile(`${queuePath}.bak`, 'utf8')).map((i) => i.id), ['done', 'pending']);
});

test('loadQueue restores a valid backup when primary queue is corrupted', async () => {
  const dir = await tempDir();
  const queuePath = path.join(dir, 'queue.json');
  await fsp.writeFile(queuePath, '{not json');
  await fsp.writeFile(`${queuePath}.bak`, JSON.stringify([
    { id: 'backup-next', text: 'from backup', status: 'next' },
    { id: 'backup-done', text: 'done backup', status: 'completed' },
  ]));
  const app = makeAppWithQueue([]);
  app.queuePath = queuePath;
  app.eventsLogPath = path.join(dir, 'events.log');
  app.saveQueue = CodexLimitWatchApp.prototype.saveQueue.bind(app);

  await app.loadQueue();

  assert.deepEqual(app.queue.map((i) => i.id), ['backup-done', 'backup-next']);
  assert.deepEqual(app.queue.map((i) => i.status), ['completed', 'pending']);
  assert.equal(JSON.parse(await fsp.readFile(queuePath, 'utf8')).length, 2);
  assert.equal(fs.readdirSync(dir).some((name) => /^queue\.json\.corrupt\..+\.bak$/.test(name)), true);
  assert.match(app.output.at(-1).text, /restored from backup/);
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
  app.opts.sandbox = 'read-only';
  app.app.sandbox = 'read-only';
  app.opts.approvalPolicy = 'never';
  app.app.approvalPolicy = 'never';
  app.app.scheduledRunAt = '2026-01-01T00:00:00.000Z';
  app.saveSettings = CodexLimitWatchApp.prototype.saveSettings.bind(app);
  app.saveState = CodexLimitWatchApp.prototype.saveState.bind(app);

  await app.saveSettings();
  await app.saveState();

  const loaded = makeAppWithQueue([], { stateDir: dir });
  loaded.settingsPath = app.settingsPath;
  await loaded.loadSettings();
  assert.equal(loaded.app.theme, 'light');
  assert.equal(loaded.opts.sandbox, 'read-only');
  assert.equal(loaded.app.sandbox, 'read-only');
  assert.equal(loaded.opts.approvalPolicy, 'never');
  assert.equal(loaded.app.approvalPolicy, 'never');

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

test('overlapping saveQueue calls cannot let an older snapshot overwrite a newer one', async () => {
  const dir = await tempDir();
  const queuePath = path.join(dir, 'queue.json');
  const first = item('first');
  const second = item('second');
  const app = makeAppWithQueue([first]);
  app.queuePath = queuePath;
  app.saveQueue = CodexLimitWatchApp.prototype.saveQueue.bind(app);

  const oldSave = app.saveQueue();
  app.queue.push(second);
  const newSave = app.saveQueue();
  await Promise.all([oldSave, newSave]);
  await app.persistence.drain();

  const persisted = JSON.parse(await fsp.readFile(queuePath, 'utf8'));
  assert.deepEqual(persisted.map((queueItem) => queueItem.id), ['first', 'second']);
});

test('atomic lock acquisition allows only one concurrent owner', async () => {
  const dir = await tempDir();
  const lockPath = path.join(dir, 'app.lock');
  const first = makeAppWithQueue([]);
  const second = makeAppWithQueue([]);
  first.lockPath = lockPath;
  second.lockPath = lockPath;

  const results = await Promise.allSettled([first.acquireLock(), second.acquireLock()]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.match(results.find((result) => result.status === 'rejected').reason.message, /already running|changed repeatedly/);

  first.releaseLock();
  second.releaseLock();
});

test('saveQueue removes completed items before awaiting archive I/O', async () => {
  const dir = await tempDir();
  const done = item('archive-race', 'completed');
  const app = makeAppWithQueue([done]);
  app.queuePath = path.join(dir, 'queue.json');
  app.completedArchivePath = path.join(dir, 'completed.jsonl');
  app.completedArchiveMetaPath = path.join(dir, 'completed.meta.json');
  app.saveQueue = CodexLimitWatchApp.prototype.saveQueue.bind(app);
  let releaseArchive;
  const archiveGate = new Promise((resolve) => { releaseArchive = resolve; });
  app.archiveCompletedItem = async () => {
    await archiveGate;
    return true;
  };

  const saving = app.saveQueue();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.queue.some((entry) => entry.id === done.id), false);

  releaseArchive();
  await saving;
  assert.deepEqual(JSON.parse(await fsp.readFile(app.queuePath, 'utf8')), []);
});

test('saveQueue restores removed completed items when archive append fails', async () => {
  const dir = await tempDir();
  const done = item('archive-failure', 'completed');
  const pending = item('still-pending');
  const app = makeAppWithQueue([done, pending]);
  app.queuePath = path.join(dir, 'queue.json');
  app.completedArchivePath = path.join(dir, 'completed.jsonl');
  app.completedArchiveMetaPath = path.join(dir, 'completed.meta.json');
  app.saveQueue = CodexLimitWatchApp.prototype.saveQueue.bind(app);
  app.archiveCompletedItem = async () => { throw new Error('archive unavailable'); };

  await assert.rejects(app.saveQueue(), /archive unavailable/);
  assert.deepEqual(app.queue.map((entry) => entry.id), ['archive-failure', 'still-pending']);
  assert.equal(app.queue[0].status, 'completed');
});

test('finalizeCompletedQueueItem restores the item if archive persistence fails', async () => {
  const done = item('finalize-failure', 'completed');
  const app = makeAppWithQueue([done]);
  app.completedArchivePath = '/tmp/not-used.jsonl';
  app.archiveCompletedItem = async () => { throw new Error('cannot append'); };

  await assert.rejects(app.finalizeCompletedQueueItem(done), /cannot append/);
  assert.equal(app.queue[0], done);
  assert.equal(done.status, 'completed');
});

test('setupPairState persists the target session identity before app selection is committed', async () => {
  const stateDir = await tempDir();
  const app = makeAppWithQueue([], { stateDir });
  app.app.sessionId = 'old-session';
  app.app.sessionTitle = 'Old title';
  app.saveState = CodexLimitWatchApp.prototype.saveState.bind(app);

  await app.setupPairState('target-session', 'Target title');
  const saved = JSON.parse(await fsp.readFile(app.statePath, 'utf8'));

  assert.equal(saved.sessionId, 'target-session');
  assert.equal(saved.sessionTitle, 'Target title');
  app.releaseLock();
});
