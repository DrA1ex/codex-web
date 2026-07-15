'use strict';

const { test, expect, sendComposer, addToQueue } = require('./fixtures');

async function waitCount(app, key, value) {
  await expect.poll(async () => (await app.snapshot()).app.queueCounts[key]).toBe(value);
}

async function postFromPage(page, route, body = {}) {
  return await page.evaluate(async ({ route, body }) => {
    const token = window.CODEX_LIMIT_WATCH_TOKEN;
    const response = await fetch(`${route}?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-codex-limit-watch-token': token,
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, payload: await response.json() };
  }, { route, body });
}

test('many concurrent queue additions remain unique and survive reload', async ({ app }) => {
  await app.page.locator('#pauseBtn').click();
  const prompts = Array.from({ length: 20 }, (_, index) => `parallel add ${index}`);
  const results = await Promise.all(prompts.map((text) => app.api('/api/queue/add', { text })));
  expect(results.every((result) => result.ok)).toBe(true);
  await waitCount(app, 'pending', prompts.length);

  let snapshot = await app.snapshot();
  expect(snapshot.queue.map((item) => item.text).sort()).toEqual([...prompts].sort());
  expect(new Set(snapshot.queue.map((item) => item.id)).size).toBe(prompts.length);

  await app.page.reload({ waitUntil: 'domcontentloaded' });
  await expect(app.page.locator('.queue-item[data-queue-status="pending"]')).toHaveCount(prompts.length);
  snapshot = await app.snapshot();
  expect(new Set(snapshot.queue.map((item) => item.id)).size).toBe(prompts.length);
});

test('two browser clients can add concurrently and converge on the same queue', async ({ app }) => {
  await app.page.locator('#pauseBtn').click();
  const secondContext = await app.browser.newContext();
  const second = await secondContext.newPage();
  await second.goto(app.url, { waitUntil: 'domcontentloaded' });
  await expect(second.locator('#stateBadge')).not.toHaveText('loading');

  const [first, secondResult] = await Promise.all([
    postFromPage(app.page, '/api/queue/add', { text: 'from first browser' }),
    postFromPage(second, '/api/queue/add', { text: 'from second browser' }),
  ]);
  expect(first.status).toBe(200);
  expect(secondResult.status).toBe(200);
  await waitCount(app, 'pending', 2);
  await expect(app.page.locator('.queue-item[data-queue-status="pending"]')).toHaveCount(2);
  await expect(second.locator('.queue-item[data-queue-status="pending"]')).toHaveCount(2);

  const texts = (await app.snapshot()).queue.map((item) => item.text).sort();
  expect(texts).toEqual(['from first browser', 'from second browser']);
  await secondContext.close();
});

test('clearing pending queue during a slow turn preserves the active item', async ({ app }) => {
  await sendComposer(app.page, 'MOCK:SLOW');
  await expect(app.page.locator('#output')).toContainText('Working slowly...');
  await addToQueue(app.page, 'pending one');
  await addToQueue(app.page, 'pending two');
  await waitCount(app, 'pending', 2);

  await app.page.locator('#queueMenuBtn').click();
  await app.page.locator('#clearBtn').click();
  await expect(app.page.locator('#confirmBox')).not.toHaveClass(/hidden/);
  await app.page.locator('#confirmYesBtn').click();
  await waitCount(app, 'pending', 0);
  let snapshot = await app.snapshot();
  expect(snapshot.queue.some((item) => item.text === 'MOCK:SLOW' && ['sending', 'sent'].includes(item.status))).toBe(true);

  await app.page.locator('#composer').fill('/think finish after clearing pending');
  await app.page.locator('#composer').press('Enter');
  await waitCount(app, 'completed', 1);
  snapshot = await app.snapshot();
  expect(snapshot.app.queueCounts.total).toBe(1);
});

test('a near-future schedule starts the queue without another user action', async ({ app }) => {
  await app.page.locator('#pauseBtn').click();
  await addToQueue(app.page, 'scheduled auto start');
  const scheduledRunAt = new Date(Date.now() + 1200).toISOString();
  await app.api('/api/queue/schedule', { scheduledRunAt });
  await expect(app.page.locator('#stateBadge')).toHaveText('scheduled');

  await waitCount(app, 'completed', 1);
  const starts = await app.clientRequests('turn/start');
  expect(starts).toHaveLength(1);
  expect(starts[0].params.input[0].text).toBe('scheduled auto start');
});

test('theme and model settings remain selected after browser reload', async ({ app }) => {
  await app.page.locator('#themeBtn').click();
  await app.page.locator('#modelSelect').selectOption('gpt-5.4-mini');
  await app.page.locator('#effortSelect').selectOption('medium');
  await expect.poll(async () => (await app.snapshot()).app.model).toBe('gpt-5.4-mini');
  const before = await app.snapshot();

  await app.page.reload({ waitUntil: 'domcontentloaded' });
  await expect(app.page.locator('#modelSelect')).toHaveValue('gpt-5.4-mini');
  await expect(app.page.locator('#effortSelect')).toHaveValue('medium');
  const after = await app.snapshot();
  expect(after.app.theme).toBe(before.app.theme);
  expect(after.app.model).toBe('gpt-5.4-mini');
  expect(after.app.effort).toBe('medium');
});

test('clearing visible output does not remove completed queue history', async ({ app }) => {
  await sendComposer(app.page, 'keep completed history');
  await waitCount(app, 'completed', 1);
  await expect(app.page.locator('#output')).toContainText('Mock response: keep completed history');

  await app.page.locator('#clearOutputBtn').click();
  await expect(app.page.locator('#output')).not.toContainText('Mock response: keep completed history');
  expect((await app.snapshot()).app.queueCounts.completed).toBe(1);
  await expect(app.page.locator('.queue-item', { hasText: 'keep completed history' })).toHaveCount(1);
});

test('clearing completed archive removes records permanently after confirmation', async ({ app }) => {
  await sendComposer(app.page, 'clear archived record');
  await waitCount(app, 'completed', 1);

  await app.page.locator('#queueMenuBtn').click();
  await app.page.locator('#clearCompletedBtn').click();
  await expect(app.page.locator('#confirmBox')).not.toHaveClass(/hidden/);
  await app.page.locator('#confirmYesBtn').click();
  await waitCount(app, 'completed', 0);
  await expect(app.page.locator('.queue-item', { hasText: 'clear archived record' })).toHaveCount(0);

  await app.page.reload({ waitUntil: 'domcontentloaded' });
  await waitCount(app, 'completed', 0);
  expect((await app.snapshot()).completedArchive.items).toHaveLength(0);
});
