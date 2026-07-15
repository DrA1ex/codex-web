'use strict';

const { test, expect, sendComposer } = require('./fixtures');

async function waitCount(app, key, value) {
  await expect.poll(async () => (await app.snapshot()).app.queueCounts[key]).toBe(value);
}

async function itemByText(app, text) {
  const snapshot = await app.snapshot();
  return [...(snapshot.queue || []), ...(snapshot.completedArchive?.items || [])]
    .find((item) => item.text === text);
}

test('force-steer replacement start failure does not leave a running coordinator', async ({ app }) => {
  await sendComposer(app.page, 'MOCK:SLOW');
  await expect(app.page.locator('#output')).toContainText('Working slowly...');

  await app.page.locator('#composer').fill('/think! MOCK:START_REJECT');
  await app.page.locator('#composer').press('Enter');

  await waitCount(app, 'failed', 1);
  await expect(app.page.locator('#stateBadge')).toHaveText('paused');
  await expect(app.page.locator('#output')).toContainText('Follow-up turn/start failed');
  await expect(app.page.locator('#interruptBtn')).toBeHidden();
  const snapshot = await app.snapshot();
  expect(snapshot.app.canInterrupt).toBe(false);
  expect(snapshot.app.isManualSend).toBe(false);
  expect((await itemByText(app, 'MOCK:SLOW')).status).toBe('failed');
  expect(await app.clientRequests('turn/interrupt')).toHaveLength(1);
  expect(await app.clientRequests('turn/start')).toHaveLength(2);
});

test('not-steerable response exposes Force send and replacement completes', async ({ app }) => {
  await app.setControl({ steerRejectOnce: true });
  await sendComposer(app.page, 'MOCK:SLOW');
  await expect(app.page.locator('#output')).toContainText('Working slowly...');

  await app.page.locator('#composer').fill('/think use the fallback path');
  await app.page.locator('#composer').press('Enter');
  const force = app.page.locator('[data-force-steer]');
  await expect(force).toBeVisible();
  await force.click();

  await expect(app.page.locator('#output')).toContainText('Mock response: use the fallback path');
  await waitCount(app, 'completed', 1);
  expect(await app.clientRequests('turn/steer')).toHaveLength(1);
  expect(await app.clientRequests('turn/interrupt')).toHaveLength(1);
  expect(await app.clientRequests('turn/start')).toHaveLength(2);
});

test('interrupt RPC rejection leaves the original turn steerable', async ({ app }) => {
  await app.setControl({ interruptRejectOnce: true });
  await sendComposer(app.page, 'MOCK:SLOW');
  await expect(app.page.locator('#output')).toContainText('Working slowly...');

  await app.page.locator('#interruptBtn').click();
  await app.page.locator('#confirmYesBtn').click();
  await expect(app.page.locator('#output')).toContainText('Mock interrupt rejection');
  await expect(app.page.locator('#stateBadge')).toHaveText('streaming');

  await app.page.locator('#composer').fill('/think recover after rejected interrupt');
  await app.page.locator('#composer').press('Enter');
  await expect(app.page.locator('#output')).toContainText('Steered: recover after rejected interrupt');
  await waitCount(app, 'completed', 1);
  expect(await app.clientRequests('turn/interrupt')).toHaveLength(1);
  expect(await app.clientRequests('turn/steer')).toHaveLength(1);
});

test('late token usage updates an already archived completed item', async ({ app }) => {
  await sendComposer(app.page, 'MOCK:LATE_USAGE');
  await waitCount(app, 'completed', 1);
  await expect.poll(async () => (await itemByText(app, 'MOCK:LATE_USAGE'))?.usage?.tokenUsage?.totalTokens).toBe(777);

  await app.page.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(async () => (await itemByText(app, 'MOCK:LATE_USAGE'))?.usage?.tokenUsage?.totalTokens).toBe(777);
});

test('foreign token usage cannot overwrite the selected thread context', async ({ app }) => {
  await sendComposer(app.page, 'MOCK:FOREIGN_USAGE');
  await waitCount(app, 'completed', 1);
  const snapshot = await app.snapshot();
  expect(snapshot.app.contextTokens).not.toBe(999999);
  expect((await itemByText(app, 'MOCK:FOREIGN_USAGE')).usage.tokenUsage.totalTokens).toBe(91);
});

test('turn with no items still reaches a terminal completed queue state', async ({ app }) => {
  await sendComposer(app.page, 'MOCK:EMPTY_COMPLETION');
  await waitCount(app, 'completed', 1);
  await expect(app.page.locator('#stateBadge')).toHaveText('paused');
  expect((await itemByText(app, 'MOCK:EMPTY_COMPLETION')).status).toBe('completed');
  expect(app.pageErrors).toEqual([]);
});

test('duplicate item/completed notifications do not duplicate output or archive records', async ({ app }) => {
  await sendComposer(app.page, 'MOCK:DUPLICATE_ITEM_COMPLETION');
  await waitCount(app, 'completed', 1);
  const output = await app.page.locator('#output').innerText();
  expect((output.match(/One completed item\./g) || []).length).toBeLessThanOrEqual(1);
  const rpcLog = await app.rpcLog();
  const duplicateCompletions = rpcLog.filter((entry) => entry.message?.method === 'item/completed' && entry.message?.params?.item?.text === 'One completed item.');
  expect(duplicateCompletions).toHaveLength(2);
  const snapshot = await app.snapshot();
  const matches = [...(snapshot.queue || []), ...(snapshot.completedArchive?.items || [])]
    .filter((item) => item.text === 'MOCK:DUPLICATE_ITEM_COMPLETION');
  expect(matches).toHaveLength(1);
});

test('failed compaction remains retryable and succeeds on the next attempt', async ({ app }) => {
  await app.setControl({ compactRejectOnce: true });
  await sendComposer(app.page, '/compact');
  await waitCount(app, 'failed', 1);
  await expect(app.page.locator('#stateBadge')).toHaveText('paused');
  await expect(app.page.locator('#output')).toContainText('Mock compaction rejection');

  const card = app.page.locator('.queue-item', { hasText: '/compact' }).first();
  await card.locator('[data-act="retry"]').click();
  await waitCount(app, 'pending', 1);
  await card.locator('[data-act="sendNow"]').click();
  await waitCount(app, 'completed', 1);
  await waitCount(app, 'failed', 0);
  expect(await app.clientRequests('thread/compact/start')).toHaveLength(2);
});
