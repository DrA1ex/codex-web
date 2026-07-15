'use strict';

const { test, expect, addToQueue } = require('./fixtures');

async function pause(app) {
  await app.page.locator('#pauseBtn').click();
  await expect(app.page.locator('#stateBadge')).toHaveText('paused');
}

async function queueCard(page, text) {
  return page.locator('.queue-item', { hasText: text }).first();
}

async function waitCount(app, key, value) {
  await expect.poll(async () => (await app.snapshot()).app.queueCounts[key]).toBe(value);
}

function allSnapshotItems(snapshot) {
  return [...(snapshot.queue || []), ...(snapshot.completedArchive?.items || [])];
}

test('paused queue processes multiple prompts sequentially after resume', async ({ app }) => {
  await pause(app);
  await addToQueue(app.page, 'queue first');
  await addToQueue(app.page, 'queue second');
  await waitCount(app, 'pending', 2);

  await app.page.locator('#resumeBtn').click();
  await waitCount(app, 'completed', 2);

  const starts = await app.clientRequests('turn/start');
  expect(starts.map((request) => request.params.input[0].text)).toEqual(['queue first', 'queue second']);
  await expect(app.page.locator('#stateBadge')).toHaveText('done');
});

test('pending item can be edited through the queue UI', async ({ app }) => {
  await pause(app);
  await addToQueue(app.page, 'original prompt');
  const card = await queueCard(app.page, 'original prompt');
  await card.locator('[data-act="edit"]').click();
  await card.locator('textarea.queue-edit').fill('edited prompt\nwith second line');
  await card.locator('[data-act="saveEdit"]').click();

  await expect(await queueCard(app.page, 'edited prompt')).toContainText('edited prompt');
  const snapshot = await app.snapshot();
  expect(snapshot.queue[0].text).toBe('edited prompt\nwith second line');
  expect(snapshot.queue[0].lineCount).toBe(2);
});

test('duplicate and confirmed remove mutate only the selected pending item', async ({ app }) => {
  await pause(app);
  await addToQueue(app.page, 'copy me');
  let card = await queueCard(app.page, 'copy me');
  await card.locator('[data-act="duplicate"]').click();
  await waitCount(app, 'pending', 2);

  const cards = app.page.locator('.queue-item[data-queue-status="pending"]', { hasText: 'copy me' });
  await expect(cards).toHaveCount(2);
  await cards.nth(1).locator('[data-act="remove"]').click();
  await expect(app.page.locator('#confirmBox')).not.toHaveClass(/hidden/);
  await app.page.locator('#confirmYesBtn').click();
  await waitCount(app, 'pending', 1);

  const snapshot = await app.snapshot();
  expect(snapshot.queue).toHaveLength(1);
  expect(snapshot.queue[0].text).toBe('copy me');
});


test('repeated duplicate actions create distinct items and survive reload', async ({ app }) => {
  await pause(app);
  await addToQueue(app.page, 'repeat duplicate');
  const original = (await app.snapshot()).queue.find((item) => item.text === 'repeat duplicate');
  expect(original).toBeTruthy();

  for (let index = 0; index < 3; index += 1) {
    await app.page.locator(`[data-queue-id="${original.id}"] [data-act="duplicate"]`).click();
    await waitCount(app, 'pending', index + 2);
    await expect(app.page.locator('.queue-item[data-queue-status="pending"]', { hasText: 'repeat duplicate' })).toHaveCount(index + 2);
  }

  let snapshot = await app.snapshot();
  const duplicates = snapshot.queue.filter((item) => item.text === 'repeat duplicate');
  expect(duplicates).toHaveLength(4);
  expect(new Set(duplicates.map((item) => item.id)).size).toBe(4);

  await app.page.reload({ waitUntil: 'domcontentloaded' });
  await expect(app.page.locator('.queue-item[data-queue-status="pending"]', { hasText: 'repeat duplicate' })).toHaveCount(4);
  snapshot = await app.snapshot();
  expect(new Set(snapshot.queue.filter((item) => item.text === 'repeat duplicate').map((item) => item.id)).size).toBe(4);
});

test('removing one of identical prompts targets its queue id only', async ({ app }) => {
  await pause(app);
  await addToQueue(app.page, 'same text');
  const originalId = (await app.snapshot()).queue[0].id;
  await app.page.locator(`[data-queue-id="${originalId}"] [data-act="duplicate"]`).click();
  await waitCount(app, 'pending', 2);

  const before = (await app.snapshot()).queue.filter((item) => item.text === 'same text');
  expect(before).toHaveLength(2);
  const removeId = before.find((item) => item.id !== originalId).id;

  await app.page.locator(`[data-queue-id="${removeId}"] [data-act="remove"]`).click();
  await expect(app.page.locator('#confirmBox')).not.toHaveClass(/hidden/);
  await app.page.locator('#confirmYesBtn').click();
  await waitCount(app, 'pending', 1);

  const after = (await app.snapshot()).queue.filter((item) => item.text === 'same text');
  expect(after.map((item) => item.id)).toEqual([originalId]);
  await expect(app.page.locator(`[data-queue-id="${originalId}"]`)).toHaveCount(1);
  await expect(app.page.locator(`[data-queue-id="${removeId}"]`)).toHaveCount(0);
});


test('concurrent duplicate requests create unique queue items without loss', async ({ app }) => {
  await pause(app);
  await addToQueue(app.page, 'concurrent duplicate');
  const original = (await app.snapshot()).queue[0];

  const results = await Promise.all([
    app.api('/api/queue/update', { id: original.id, action: 'duplicate' }),
    app.api('/api/queue/update', { id: original.id, action: 'duplicate' }),
  ]);
  expect(results.every((result) => result.ok)).toBe(true);
  await waitCount(app, 'pending', 3);

  const items = (await app.snapshot()).queue.filter((item) => item.text === 'concurrent duplicate');
  expect(items).toHaveLength(3);
  expect(new Set(items.map((item) => item.id)).size).toBe(3);
  await expect(app.page.locator('.queue-item[data-queue-status="pending"]', { hasText: 'concurrent duplicate' })).toHaveCount(3);
});

test('concurrent manual-send requests start a pending prompt only once', async ({ app }) => {
  await pause(app);
  await addToQueue(app.page, 'single concurrent send');
  const itemId = (await app.snapshot()).queue[0].id;

  const results = await Promise.allSettled([
    app.api('/api/queue/update', { id: itemId, action: 'sendNow' }),
    app.api('/api/queue/update', { id: itemId, action: 'sendNow' }),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  await waitCount(app, 'completed', 1);

  const starts = await app.clientRequests('turn/start');
  expect(starts).toHaveLength(1);
  expect(starts[0].params.input[0].text).toBe('single concurrent send');
});

test('manual Send button runs one paused item and leaves remaining queue paused', async ({ app }) => {
  await pause(app);
  await addToQueue(app.page, 'manual item');
  await addToQueue(app.page, 'keep pending');

  const card = await queueCard(app.page, 'manual item');
  await card.locator('[data-act="sendNow"]').click();
  await waitCount(app, 'completed', 1);
  await waitCount(app, 'pending', 1);
  await expect(app.page.locator('#stateBadge')).toHaveText('paused');

  const starts = await app.clientRequests('turn/start');
  expect(starts).toHaveLength(1);
  expect(starts[0].params.input[0].text).toBe('manual item');
});

test('undo removes the latest queued addition and restores it to composer', async ({ app }) => {
  await pause(app);
  await addToQueue(app.page, 'first item');
  await addToQueue(app.page, 'undo this item');
  await waitCount(app, 'pending', 2);

  await app.page.locator('#undoBtn').click();
  await waitCount(app, 'pending', 1);
  await expect(app.page.locator('#composer')).toHaveValue('undo this item');
  const snapshot = await app.snapshot();
  expect(snapshot.queue.map((item) => item.text)).toEqual(['first item']);
});

test('drag and drop changes the actual automatic send order', async ({ app }) => {
  await pause(app);
  await addToQueue(app.page, 'drag A');
  await addToQueue(app.page, 'drag B');
  await addToQueue(app.page, 'drag C');

  const first = app.page.locator('.queue-item[data-queue-status="pending"]', { hasText: 'drag A' });
  const third = app.page.locator('.queue-item[data-queue-status="pending"]', { hasText: 'drag C' });
  await third.dragTo(first);
  await expect.poll(async () => (await app.snapshot()).queue.map((item) => item.text).join(',')).toBe('drag C,drag A,drag B');

  await app.page.locator('#resumeBtn').click();
  await waitCount(app, 'completed', 3);
  const starts = await app.clientRequests('turn/start');
  expect(starts.map((request) => request.params.input[0].text)).toEqual(['drag C', 'drag A', 'drag B']);
});

test('pending and completed records survive browser reload with JSONL archive', async ({ app }) => {
  await pause(app);
  await addToQueue(app.page, 'complete before reload');
  await addToQueue(app.page, 'pending after reload');
  const first = await queueCard(app.page, 'complete before reload');
  await first.locator('[data-act="sendNow"]').click();
  await waitCount(app, 'completed', 1);
  await waitCount(app, 'pending', 1);

  await app.page.reload({ waitUntil: 'domcontentloaded' });
  await expect(app.page.locator('#stateBadge')).not.toHaveText('loading');
  await expect(await queueCard(app.page, 'complete before reload')).toContainText('completed');
  await expect(await queueCard(app.page, 'pending after reload')).toContainText('pending');

  const snapshot = await app.snapshot();
  expect(allSnapshotItems(snapshot).map((item) => item.text)).toEqual(expect.arrayContaining([
    'complete before reload',
    'pending after reload',
  ]));
});

test('editing a failed item resets it to pending and allows completion', async ({ app }) => {
  await app.page.locator('#composer').fill('MOCK:FAIL');
  await app.page.locator('#composer').press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
  await waitCount(app, 'failed', 1);

  let card = await queueCard(app.page, 'MOCK:FAIL');
  await card.locator('[data-act="edit"]').click();
  await card.locator('textarea.queue-edit').fill('recovered prompt');
  await card.locator('[data-act="saveEdit"]').click();
  card = await queueCard(app.page, 'recovered prompt');
  await expect(card).toContainText('pending');
  await waitCount(app, 'pending', 1);
  await app.page.locator('#resumeBtn').click();
  await waitCount(app, 'completed', 1);
  await waitCount(app, 'failed', 0);
  await expect(app.page.locator('#output')).toContainText('Mock response: recovered prompt');
});

test('concurrent removal of the same pending item succeeds exactly once', async ({ app }) => {
  await pause(app);
  await addToQueue(app.page, 'remove once');
  const itemId = (await app.snapshot()).queue.find((item) => item.text === 'remove once').id;

  const results = await Promise.allSettled([
    app.api('/api/queue/remove', { id: itemId }),
    app.api('/api/queue/remove', { id: itemId }),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  await waitCount(app, 'pending', 0);
  await expect(app.page.locator(`[data-queue-id="${itemId}"]`)).toHaveCount(0);
});

test('rapid duplicate and remove actions target queue ids rather than identical text', async ({ app }) => {
  await pause(app);
  await addToQueue(app.page, 'rapid identical prompt');
  const originalId = (await app.snapshot()).queue[0].id;

  await app.page.locator(`[data-queue-id="${originalId}"] [data-act="duplicate"]`).click();
  await waitCount(app, 'pending', 2);
  const duplicate = (await app.snapshot()).queue.find((item) => item.id !== originalId);
  expect(duplicate).toBeTruthy();

  await app.page.locator(`[data-queue-id="${duplicate.id}"] [data-act="remove"]`).click();
  await expect(app.page.locator('#confirmBox')).not.toHaveClass(/hidden/);
  await app.page.locator('#confirmYesBtn').click();
  await waitCount(app, 'pending', 1);

  const remaining = (await app.snapshot()).queue;
  expect(remaining.map((item) => item.id)).toEqual([originalId]);
  await expect(app.page.locator(`[data-queue-id="${originalId}"]`)).toHaveCount(1);
});
