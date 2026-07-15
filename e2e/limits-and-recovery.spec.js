'use strict';

const { test, expect, sendComposer } = require('./fixtures');

async function waitCount(app, key, value) {
  await expect.poll(async () => (await app.snapshot()).app.queueCounts[key]).toBe(value);
}

test.describe('rate-limit recovery', () => {
  test.use({
    mockConfig: { control: { rateLimits: 'limited' } },
    appOptions: { watchInterval: 1 },
  });

  test('queued prompt waits without turn/start and resumes after limits recover', async ({ app }) => {
    await sendComposer(app.page, 'wait for limits');
    await waitCount(app, 'pending', 1);
    await expect(app.page.locator('#stateBadge')).toHaveAttribute('title', 'waiting-limits');
    expect(await app.clientRequests('turn/start')).toHaveLength(0);

    await app.setControl({ rateLimits: 'available' });
    await waitCount(app, 'completed', 1);
    const starts = await app.clientRequests('turn/start');
    expect(starts).toHaveLength(1);
    expect(starts[0].params.input[0].text).toBe('wait for limits');
  });

  test('reset authorization waits, consumes one credit and refreshes limits', async ({ app }) => {
    await expect(app.page.locator('#limitResetOpenBtn')).toBeVisible();
    await app.page.locator('#limitResetOpenBtn').click();
    await expect(app.page.locator('#limitResetBox')).not.toHaveClass(/hidden/);
    await expect(app.page.locator('#limitResetBox')).toContainText('Reset unlocks in');
    await expect(app.page.locator('#limitResetConfirmBtn')).toBeDisabled();

    await expect(app.page.locator('#limitResetConfirmBtn')).toBeEnabled({ timeout: 8000 });
    await app.page.locator('#limitResetConfirmBtn').click();
    await expect(app.page.locator('#limitResetBox')).toHaveClass(/hidden/);
    await expect(app.page.locator('#limitBadge')).toHaveAttribute('title', 'limits available');
    await expect(app.page.locator('#output')).toContainText('reset consumed');

    const consume = await app.clientRequests('account/rateLimitResetCredit/consume');
    expect(consume).toHaveLength(1);
    expect(consume[0].params.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

test.describe('unknown limits', () => {
  test.use({
    mockConfig: { control: { rateLimits: 'unknown' } },
    appOptions: { watchInterval: 1 },
  });

  test('does not send optimistically and recovers on a later valid poll', async ({ app }) => {
    await sendComposer(app.page, 'unknown limits prompt');
    await waitCount(app, 'pending', 1);
    await expect(app.page.locator('#stateBadge')).toHaveAttribute('title', 'waiting-limits');
    expect(await app.clientRequests('turn/start')).toHaveLength(0);

    await app.setControl({ rateLimits: 'available' });
    await waitCount(app, 'completed', 1);
    expect(await app.clientRequests('turn/start')).toHaveLength(1);
  });
});

test('app-server exit leaves HTTP UI alive and marks active outcome unknown', async ({ app }) => {
  await sendComposer(app.page, 'MOCK:EXIT');
  await expect(app.page.locator('#stateBadge')).toHaveText('error');
  await waitCount(app, 'unknown', 1);
  await expect(app.page.locator('#output')).toContainText('app-server exited');

  const snapshot = await app.snapshot();
  expect(snapshot.app.state).toBe('error');
  expect(snapshot.queue.find((item) => item.text === 'MOCK:EXIT')?.status).toBe('unknown');
  await app.page.reload({ waitUntil: 'domcontentloaded' });
  await expect(app.page.locator('#stateBadge')).toHaveText('error');
});
