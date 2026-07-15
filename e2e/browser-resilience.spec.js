'use strict';

const { test, expect, sendComposer, addToQueue } = require('./fixtures');

async function waitCount(app, key, value) {
  await expect.poll(async () => (await app.snapshot()).app.queueCounts[key]).toBe(value);
}

test('multiple browser clients receive the same live state and disconnect cleanly', async ({ app }) => {
  const secondContext = await app.browser.newContext();
  const second = await secondContext.newPage();
  await second.goto(app.url, { waitUntil: 'domcontentloaded' });
  await expect(second.locator('#stateBadge')).not.toHaveText('loading');
  await expect.poll(async () => (await app.snapshot()).app.connectedClients).toBe(2);

  await sendComposer(app.page, 'two client update');
  await expect(second.locator('#output')).toContainText('Mock response: two client update');
  await waitCount(app, 'completed', 1);

  await secondContext.close();
  await expect.poll(async () => (await app.snapshot()).app.connectedClients).toBe(1);
});

test('page reload during an active turn reconnects SSE and keeps steering functional', async ({ app }) => {
  await sendComposer(app.page, 'MOCK:SLOW');
  await expect(app.page.locator('#output')).toContainText('Working slowly...');

  await app.page.reload({ waitUntil: 'domcontentloaded' });
  await expect(app.page.locator('#stateBadge')).toHaveText('streaming');
  await expect(app.page.locator('#output')).toContainText('Working slowly...');

  await app.page.locator('#composer').fill('/think continue after reload');
  await app.page.locator('#composer').press('Enter');
  await expect(app.page.locator('#output')).toContainText('Steered: continue after reload');
  await waitCount(app, 'completed', 1);
  expect(await app.clientRequests('turn/steer')).toHaveLength(1);
});

test('session switching is unavailable during a turn and returns after completion', async ({ app }) => {
  await expect(app.page.locator('#changeSessionBtn')).toBeVisible();
  await sendComposer(app.page, 'MOCK:SLOW');
  await expect(app.page.locator('#output')).toContainText('Working slowly...');
  await expect(app.page.locator('#changeSessionBtn')).toHaveCount(0);

  await app.page.locator('#composer').fill('/think finish active turn');
  await app.page.locator('#composer').press('Enter');
  await waitCount(app, 'completed', 1);
  await expect(app.page.locator('#changeSessionBtn')).toBeVisible();
});

test('schedule modal persists a future schedule and cancel returns queue to paused', async ({ app }) => {
  await app.page.locator('#pauseBtn').click();
  await addToQueue(app.page, 'scheduled pending item');
  await app.page.locator('#scheduleBtn').click();
  await expect(app.page.locator('#scheduleBox')).not.toHaveClass(/hidden/);

  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const date = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
  await app.page.locator('#scheduleDateInput').fill(date);
  await app.page.locator('#scheduleTimeInput').fill('12:34');
  await app.page.locator('#scheduleSaveBtn').click();

  await expect(app.page.locator('#stateBadge')).toHaveText('scheduled');
  await expect.poll(async () => Boolean((await app.snapshot()).app.scheduledRunAt)).toBe(true);

  await app.page.locator('#scheduleBtn').click();
  await app.page.locator('#scheduleCancelQueueBtn').click();
  await expect(app.page.locator('#stateBadge')).toHaveText('paused');
  const snapshot = await app.snapshot();
  expect(snapshot.app.scheduledRunAt).toBeNull();
  expect(snapshot.app.queueCounts.pending).toBe(1);
});

test('invalid token shows authorization error without exposing the application', async ({ app }) => {
  const badContext = await app.browser.newContext();
  const badPage = await badContext.newPage();
  const badUrl = new URL(app.url);
  badUrl.searchParams.set('token', 'invalid-token');
  const response = await badPage.goto(badUrl.toString(), { waitUntil: 'domcontentloaded' });
  expect(response.status()).toBe(403);
  await expect(badPage.getByRole('heading', { name: 'Authorization error' })).toBeVisible();
  await expect(badPage.locator('#composer')).toHaveCount(0);
  await badContext.close();
});

test('Stop server confirmation produces a shutdown overlay', async ({ app }) => {
  await app.page.locator('#stopBtn').click();
  await expect(app.page.locator('#confirmBox')).not.toHaveClass(/hidden/);
  await app.page.locator('#confirmYesBtn').click();
  await expect(app.page.locator('#shutdownOverlay')).not.toHaveClass(/hidden/);
  await expect(app.page.locator('#shutdownTitle')).toContainText('Codex Web has exited');
});
