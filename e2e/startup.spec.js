'use strict';

const fsp = require('node:fs/promises');
const { test, expect, sendComposer } = require('./fixtures');

test('performs documented initialize handshake before other app-server requests', async ({ app }) => {
  await expect(app.page.locator('#stateBadge')).toHaveText('watching');
  await expect(app.page.locator('#limitBadge')).toHaveAttribute('title', 'limits available');
  await expect(app.page.locator('#modelSelect')).toContainText('GPT-5.4');

  const log = await app.rpcLog();
  const clientMessages = log.filter((entry) => entry.direction === 'client').map((entry) => entry.message);
  expect(clientMessages[0]?.method).toBe('initialize');
  expect(clientMessages[0]?.params?.capabilities?.experimentalApi).toBe(true);
  expect(clientMessages[1]?.method).toBe('initialized');
  const firstPostHandshakeRequest = clientMessages.findIndex((message, index) => index > 1 && message.id !== undefined);
  expect(firstPostHandshakeRequest).toBeGreaterThan(1);
});

test.describe('session picker', () => {
  test.use({ appOptions: { sessionId: null } });

  test('lists sessions and selects a different thread', async ({ app }) => {
    await expect(app.page.locator('#sessionPicker')).not.toHaveClass(/hidden/);
    const primary = app.page.locator('.session', { has: app.page.locator('[data-session="mock-thread"]') });
    const secondary = app.page.locator('.session', { has: app.page.locator('[data-session="mock-thread-2"]') });
    await expect(primary).toContainText('Mock primary session');
    await expect(secondary).toContainText('Mock secondary session');

    await secondary.locator('[data-session="mock-thread-2"]').click();
    await expect.poll(async () => (await app.snapshot()).app.sessionId).toBe('mock-thread-2');
    await expect(app.page.locator('#sessionPicker')).toHaveClass(/hidden/);
  });

  test('creates a new session through thread/start', async ({ app }) => {
    await app.page.locator('#createSessionBtn').click();
    await expect.poll(async () => (await app.snapshot()).app.sessionId).toMatch(/^mock-thread-\d+$/);
    const requests = await app.clientRequests('thread/start');
    expect(requests).toHaveLength(1);
    expect(await fsp.realpath(requests[0].params.cwd)).toBe(await fsp.realpath(app.projectDir));
  });

  test('concurrent create-session requests start only one thread', async ({ app }) => {
    const results = await Promise.allSettled([
      app.api('/api/session/create'),
      app.api('/api/session/create'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await expect.poll(async () => (await app.snapshot()).app.sessionId).toMatch(/^mock-thread-\d+$/);
    expect(await app.clientRequests('thread/start')).toHaveLength(1);
  });

});

test('runtime model, effort, sandbox and approval selections reach turn/start', async ({ app }) => {
  await app.page.locator('#modelSelect').selectOption('gpt-5.4-mini');
  await app.page.locator('#effortSelect').selectOption('medium');

  await app.page.locator('#composer').fill('/sandbox read-only');
  await app.page.locator('#composer').press('Enter');
  await expect(app.page.locator('#output')).toContainText('sandbox read-only');

  await app.page.locator('#composer').fill('/approval never');
  await app.page.locator('#composer').press('Enter');
  await expect(app.page.locator('#output')).toContainText('approval never');

  await sendComposer(app.page, 'configuration payload');
  await expect.poll(async () => (await app.snapshot()).app.queueCounts.completed).toBe(1);

  const requests = await app.clientRequests('turn/start');
  const request = requests.at(-1);
  expect(request.params.model).toBe('gpt-5.4-mini');
  expect(request.params.effort).toBe('medium');
  expect(request.params.approvalPolicy).toBe('never');
  expect(request.params.sandboxPolicy.type).toBe('readOnly');
});
