'use strict';

const { test, expect, sendComposer, addToQueue } = require('./fixtures');

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

  test('concurrent reset confirmations share one app-server consume request', async ({ app }) => {
    await app.page.locator('#limitResetOpenBtn').click();
    await expect(app.page.locator('#limitResetConfirmBtn')).toBeEnabled({ timeout: 8000 });
    const requestId = (await app.snapshot()).limitResetRequest?.requestId;
    expect(requestId).toBeTruthy();

    const results = await Promise.all([
      app.api('/api/limits/reset', { requestId }),
      app.api('/api/limits/reset', { requestId }),
    ]);
    expect(results).toEqual([
      { ok: true, outcome: 'reset' },
      { ok: true, outcome: 'reset' },
    ]);

    const consume = await app.clientRequests('account/rateLimitResetCredit/consume');
    expect(consume).toHaveLength(1);
    await expect(app.page.locator('#limitBadge')).toHaveAttribute('title', 'limits available');
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
  await waitCount(app, 'unknown', 1);
  await expect(app.page.locator('#stateBadge')).toHaveText('error');
  await expect(app.page.locator('#output')).toContainText('app-server exited');

  const snapshot = await app.snapshot();
  expect(snapshot.app.state).toBe('error');
  expect(snapshot.queue.find((item) => item.text === 'MOCK:EXIT')?.status).toBe('unknown');
  await app.page.reload({ waitUntil: 'domcontentloaded' });
  await expect(app.page.locator('#stateBadge')).toHaveText('error');
});

test('app-server exit before turn/start response is terminal and reload-safe', async ({ app }) => {
  await sendComposer(app.page, 'MOCK:EXIT_BEFORE_RESPONSE');
  await waitCount(app, 'unknown', 1);
  await expect(app.page.locator('#stateBadge')).toHaveText('error');
  await expect(app.page.locator('#output')).toContainText('app-server exited');

  const starts = await app.clientRequests('turn/start');
  expect(starts).toHaveLength(1);
  const snapshot = await app.snapshot();
  expect(snapshot.queue.find((item) => item.text === 'MOCK:EXIT_BEFORE_RESPONSE')?.status).toBe('unknown');

  await app.page.reload({ waitUntil: 'domcontentloaded' });
  await expect(app.page.locator('#stateBadge')).toHaveText('error');
  await waitCount(app, 'unknown', 1);
});

test('app-server exit stops automatic queue progression and preserves later prompts', async ({ app }) => {
  await app.page.locator('#pauseBtn').click();
  await expect(app.page.locator('#stateBadge')).toHaveText('paused');

  await addToQueue(app.page, 'MOCK:EXIT');
  await addToQueue(app.page, 'must remain pending');
  await waitCount(app, 'pending', 2);

  await app.page.locator('#resumeBtn').click();
  await waitCount(app, 'unknown', 1);
  await waitCount(app, 'pending', 1);
  await expect(app.page.locator('#stateBadge')).toHaveText('error');

  const starts = await app.clientRequests('turn/start');
  expect(starts).toHaveLength(1);
  expect(starts[0].params.input[0].text).toBe('MOCK:EXIT');
  const snapshot = await app.snapshot();
  expect(snapshot.queue.find((item) => item.text === 'must remain pending')?.status).toBe('pending');
});

test('app-server exit after turn/start response but before turn/started is unknown', async ({ app }) => {
  await sendComposer(app.page, 'MOCK:EXIT_BEFORE_STARTED');
  await waitCount(app, 'unknown', 1);
  await expect(app.page.locator('#stateBadge')).toHaveText('error');
  const snapshot = await app.snapshot();
  expect(snapshot.queue.find((item) => item.text === 'MOCK:EXIT_BEFORE_STARTED')?.status).toBe('unknown');
  expect(await app.clientRequests('turn/start')).toHaveLength(1);
});

test('completed outcome is not downgraded when app-server exits immediately afterward', async ({ app }) => {
  await sendComposer(app.page, 'MOCK:COMPLETE_THEN_EXIT');
  await waitCount(app, 'completed', 1);
  await expect(app.page.locator('#output')).toContainText('Completed immediately before app-server exit.');
  await expect(app.page.locator('#stateBadge')).toHaveText('error');

  const snapshot = await app.snapshot();
  const allItems = [...(snapshot.queue || []), ...(snapshot.completedArchive?.items || [])];
  const matches = allItems.filter((item) => item.text === 'MOCK:COMPLETE_THEN_EXIT');
  expect(matches).toHaveLength(1);
  expect(matches[0].status).toBe('completed');
  expect(snapshot.app.queueCounts.unknown).toBe(0);
});


test('fatal app-server exit remains latched after Resume and later queue additions', async ({ app }) => {
  await sendComposer(app.page, 'MOCK:EXIT');
  await waitCount(app, 'unknown', 1);
  await expect(app.page.locator('#stateBadge')).toHaveText('error');

  await app.api('/api/control/resume');
  await expect(app.page.locator('#stateBadge')).toHaveText('error');

  await addToQueue(app.page, 'preserve after fatal exit');
  await waitCount(app, 'pending', 1);
  await app.page.waitForTimeout(400);
  await expect(app.page.locator('#stateBadge')).toHaveText('error');

  const starts = await app.clientRequests('turn/start');
  expect(starts).toHaveLength(1);
  const snapshot = await app.snapshot();
  expect(snapshot.queue.find((item) => item.text === 'preserve after fatal exit')?.status).toBe('pending');
});

test('fatal exit emits one terminal error and never downgrades unknown to failed', async ({ app }) => {
  await sendComposer(app.page, 'MOCK:EXIT');
  await waitCount(app, 'unknown', 1);
  await expect(app.page.locator('#stateBadge')).toHaveText('error');

  const snapshot = await app.snapshot();
  expect(snapshot.app.queueCounts.unknown).toBe(1);
  expect(snapshot.app.queueCounts.failed).toBe(0);
  const errors = snapshot.output.filter((entry) => entry.type === 'error' && entry.text.includes('app-server exited'));
  expect(errors).toHaveLength(1);
});
