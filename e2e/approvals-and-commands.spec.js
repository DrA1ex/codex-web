'use strict';

const { test, expect, sendComposer } = require('./fixtures');

async function waitCount(app, key, value) {
  await expect.poll(async () => (await app.snapshot()).app.queueCounts[key]).toBe(value);
}

function clientResponses(entries) {
  return entries
    .filter((entry) => entry.direction === 'client' && entry.message?.id !== undefined && entry.message?.method === undefined)
    .map((entry) => entry.message);
}

test('manual command approval can be accepted once from the UI', async ({ app }) => {
  await sendComposer(app.page, 'MOCK:APPROVAL_COMMAND');
  await expect(app.page.locator('#approvalBox')).not.toHaveClass(/hidden/);
  await expect(app.page.locator('#approvalBox')).toContainText('Run mock command');
  await app.page.locator('[data-approval="accept"]').click();

  await expect(app.page.locator('#approvalBox')).toHaveClass(/hidden/);
  await expect(app.page.locator('#output')).toContainText('Approval accepted (command).');
  await waitCount(app, 'completed', 1);

  const responses = clientResponses(await app.rpcLog());
  expect(responses.some((response) => response.result === 'accept')).toBe(true);
});

test('manual file approval can be declined without wedging the turn', async ({ app }) => {
  await sendComposer(app.page, 'MOCK:APPROVAL_FILE');
  await expect(app.page.locator('#approvalBox')).not.toHaveClass(/hidden/);
  await expect(app.page.locator('#approvalBox')).toContainText('Apply mock file change');
  await app.page.locator('[data-approval="decline"]').click();

  await expect(app.page.locator('#output')).toContainText('Approval declined (file).');
  await waitCount(app, 'completed', 1);
  const responses = clientResponses(await app.rpcLog());
  expect(responses.some((response) => response.result === 'decline')).toBe(true);
});

test('overlapping server approval is declined while the first remains actionable', async ({ app }) => {
  await sendComposer(app.page, 'MOCK:APPROVAL_OVERLAP');
  await expect(app.page.locator('#approvalBox')).not.toHaveClass(/hidden/);
  await expect(app.page.locator('#output')).toContainText('rejected overlapping request');
  await app.page.locator('[data-approval="accept"]').click();
  await waitCount(app, 'completed', 1);

  const results = clientResponses(await app.rpcLog()).map((response) => response.result);
  expect(results).toContain('decline');
  expect(results).toContain('accept');
});

test.describe('automatic approval mode', () => {
  test.use({ appOptions: { approvalResponse: 'accept-for-session' } });

  test('responds with the documented acceptForSession decision without opening UI', async ({ app }) => {
    await sendComposer(app.page, 'MOCK:APPROVAL_COMMAND');
    await waitCount(app, 'completed', 1);
    await expect(app.page.locator('#approvalBox')).toHaveClass(/hidden/);

    const responses = clientResponses(await app.rpcLog());
    expect(responses.some((response) => response.result === 'acceptForSession')).toBe(true);
  });
});

test('queued /compact completes from contextCompaction item lifecycle', async ({ app }) => {
  await sendComposer(app.page, '/compact');
  await waitCount(app, 'completed', 1);
  await expect(app.page.locator('#output')).toContainText('Compact');
  await expect(app.page.locator('#output')).toContainText('/compact completed');
  const snapshot = await app.snapshot();
  expect(snapshot.output.some((entry) => entry.text === '[compact] completed')).toBe(true);

  const log = await app.rpcLog();
  expect(log.some((entry) => entry.direction === 'client' && entry.message?.method === 'thread/compact/start')).toBe(true);
  expect(log.some((entry) => entry.direction === 'server' && entry.message?.method === 'item/completed' && entry.message?.params?.item?.type === 'contextCompaction')).toBe(true);
  expect(log.some((entry) => entry.message?.method === 'thread/compacted')).toBe(false);
});
