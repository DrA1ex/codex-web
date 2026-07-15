'use strict';

const { test, expect, sendComposer } = require('./fixtures');

async function waitForCount(app, key, value) {
  await expect.poll(async () => (await app.snapshot()).app.queueCounts[key]).toBe(value);
}

async function queueItemByText(app, text) {
  const snap = await app.snapshot();
  return [...snap.queue, ...(snap.completedArchive?.items || [])].find((item) => item.text === text);
}

test('streams reasoning and final output through the real browser UI', async ({ app }) => {
  await sendComposer(app.page, 'basic turn');
  await expect.poll(async () => (await app.rpcLog()).some((entry) => entry.message?.method === 'item/reasoning/summaryTextDelta')).toBe(true);
  await expect(app.page.locator('#output')).toContainText('Mock response: basic turn');
  await waitForCount(app, 'completed', 1);

  const item = await queueItemByText(app, 'basic turn');
  expect(item.status).toBe('completed');
  expect(item.usage.tokenUsage.totalTokens).toBe(120);
});

test('preserves unicode across JSONL RPC, SSE patches, DOM and completed archive', async ({ app }) => {
  await sendComposer(app.page, 'MOCK:UNICODE');
  await expect(app.page.locator('#output')).toContainText('Привет 🌲 — café — こんにちは');
  await waitForCount(app, 'completed', 1);

  await app.page.reload({ waitUntil: 'domcontentloaded' });
  await expect(app.page.locator('#output')).toContainText('Привет 🌲 — café — こんにちは');
  const item = await queueItemByText(app, 'MOCK:UNICODE');
  expect(item.status).toBe('completed');
});

test('does not lose a terminal event emitted before turn/start response', async ({ app }) => {
  await sendComposer(app.page, 'MOCK:COMPLETION_BEFORE_RESPONSE');
  await expect(app.page.locator('#output')).toContainText('Completed before response.');
  await waitForCount(app, 'completed', 1);
  await expect(app.page.locator('#stateBadge')).toHaveText('paused');
});

test('ignores foreign-thread lifecycle and output events', async ({ app }) => {
  await sendComposer(app.page, 'MOCK:FOREIGN_EVENTS');
  await expect(app.page.locator('#output')).toContainText('Local turn survived foreign events.');
  await waitForCount(app, 'completed', 1);
  await expect(app.page.locator('#output')).not.toContainText('FOREIGN OUTPUT MUST NOT APPEAR');
});

test('ignores duplicate terminal notifications and archives once', async ({ app }) => {
  await sendComposer(app.page, 'MOCK:DUPLICATE_COMPLETION');
  await waitForCount(app, 'completed', 1);
  await app.page.waitForTimeout(150);
  const snap = await app.snapshot();
  expect(snap.app.queueCounts.completed).toBe(1);
  expect([...(snap.queue || []), ...(snap.completedArchive?.items || [])].filter((item) => item.text === 'MOCK:DUPLICATE_COMPLETION')).toHaveLength(1);
});

test('handles many small deltas without losing the first or final chunk', async ({ app }) => {
  await sendComposer(app.page, 'MOCK:LONG_OUTPUT');
  await expect(app.page.locator('#output')).toContainText('chunk-000');
  await expect(app.page.locator('#output')).toContainText('chunk-119');
  await waitForCount(app, 'completed', 1);
  expect(app.pageErrors).toEqual([]);
});

test('failed turn pauses queue and retains a retryable failed item', async ({ app }) => {
  await sendComposer(app.page, 'MOCK:FAIL');
  await waitForCount(app, 'failed', 1);
  await expect(app.page.locator('#stateBadge')).toHaveText('paused');
  await expect(app.page.locator('#output')).toContainText('Mock upstream failure');

  const item = await queueItemByText(app, 'MOCK:FAIL');
  expect(item.status).toBe('failed');
});

test('interrupt button records an interrupted item instead of a generic failure', async ({ app }) => {
  await sendComposer(app.page, 'MOCK:SLOW');
  await expect(app.page.locator('#output')).toContainText('Working slowly...');
  await app.page.locator('#interruptBtn').click();
  await expect(app.page.locator('#confirmBox')).not.toHaveClass(/hidden/);
  await app.page.locator('#confirmYesBtn').click();

  await expect.poll(async () => (await app.clientRequests('turn/interrupt')).length).toBe(1);
  await expect.poll(async () => (await queueItemByText(app, 'MOCK:SLOW'))?.status).toBe('interrupted');
  await expect(app.page.locator('#stateBadge')).toHaveText('paused');
});

test('/think steers the active turn and completes the same queue item', async ({ app }) => {
  await sendComposer(app.page, 'MOCK:SLOW');
  await expect(app.page.locator('#output')).toContainText('Working slowly...');
  await app.page.locator('#composer').fill('/think focus on the edge case');
  await app.page.locator('#composer').press('Enter');

  await expect(app.page.locator('#output')).toContainText('Steered: focus on the edge case');
  await waitForCount(app, 'completed', 1);
  const requests = await app.clientRequests('turn/steer');
  expect(requests).toHaveLength(1);
  expect(requests[0].params.expectedTurnId).toMatch(/^turn-/);
});

test('/think! interrupts and starts a replacement turn', async ({ app }) => {
  await sendComposer(app.page, 'MOCK:SLOW');
  await expect(app.page.locator('#output')).toContainText('Working slowly...');
  await app.page.locator('#composer').fill('/think! replace the approach');
  await app.page.locator('#composer').press('Enter');

  await expect(app.page.locator('#output')).toContainText('Mock response: replace the approach');
  await waitForCount(app, 'completed', 1);
  const starts = await app.clientRequests('turn/start');
  const interrupts = await app.clientRequests('turn/interrupt');
  expect(starts).toHaveLength(2);
  expect(interrupts).toHaveLength(1);
});
