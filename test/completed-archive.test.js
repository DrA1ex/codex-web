'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { CodexLimitWatchApp } = require('../src/app');
const { item, makeAppWithQueue, tempDir } = require('./helpers');

async function archiveApp(queue = []) {
  const dir = await tempDir();
  const app = makeAppWithQueue(queue);
  app.queuePath = path.join(dir, 'queue.json');
  app.completedArchivePath = path.join(dir, 'completed.jsonl');
  app.completedArchiveMetaPath = path.join(dir, 'completed.meta.json');
  app.saveQueue = CodexLimitWatchApp.prototype.saveQueue.bind(app);
  await app.loadCompletedArchive();
  return { app, dir };
}

test('completed items move out of queue.json into append-only JSONL with cursor pagination', async () => {
  const first = item('first', 'completed', { finishedAt: '2026-01-01T10:00:00.000Z' });
  const second = item('second', 'completed', { finishedAt: '2026-01-01T11:00:00.000Z' });
  const pending = item('pending');
  const { app } = await archiveApp([first, pending, second]);

  await app.saveQueue();

  assert.deepEqual(app.queue.map((queueItem) => queueItem.id), ['pending']);
  assert.deepEqual(JSON.parse(await fsp.readFile(app.queuePath, 'utf8')).map((queueItem) => queueItem.id), ['pending']);
  const records = (await fsp.readFile(app.completedArchivePath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map((record) => record.op), ['insert', 'insert']);
  assert.deepEqual(records.map((record) => record.item.id), ['first', 'second']);
  assert.equal(app.completedArchiveTotal, 2);

  const newest = await app.loadCompletedArchivePage({ limit: 1 });
  assert.deepEqual(newest.items.map((queueItem) => queueItem.id), ['second']);
  assert.equal(newest.hasMore, true);

  const older = await app.loadCompletedArchivePage({ limit: 1, before: newest.cursor });
  assert.deepEqual(older.items.map((queueItem) => queueItem.id), ['first']);
  assert.equal(older.hasMore, false);
});

test('JSONL updates preserve insertion order while exposing the latest item data', async () => {
  const first = item('first', 'completed', { finishedAt: '2026-01-01T10:00:00.000Z' });
  const second = item('second', 'completed', { finishedAt: '2026-01-01T11:00:00.000Z' });
  const { app } = await archiveApp([]);

  await app.archiveCompletedItem(first);
  await app.archiveCompletedItem(second);
  first.usage = { totalTokens: 42 };
  await app.archiveCompletedItem(first);

  const page = await app.loadCompletedArchivePage({ limit: 10 });
  assert.deepEqual(page.items.map((queueItem) => queueItem.id), ['first', 'second']);
  assert.deepEqual(page.items[0].usage, { totalTokens: 42 });
  assert.equal(app.completedArchiveTotal, 2);

  const records = (await fsp.readFile(app.completedArchivePath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map((record) => record.op), ['insert', 'insert', 'update']);
});

test('clearCompletedArchive truncates JSONL and resets metadata', async () => {
  const { app } = await archiveApp([]);
  await app.archiveCompletedItem(item('done', 'completed'));

  const removed = await app.clearCompletedArchive();
  await app.persistence.drain();

  assert.equal(removed, 1);
  assert.equal(app.completedArchiveTotal, 0);
  assert.equal(await fsp.readFile(app.completedArchivePath, 'utf8'), '');
  const meta = JSON.parse(await fsp.readFile(app.completedArchiveMetaPath, 'utf8'));
  assert.equal(meta.totalCompleted, 0);
});
