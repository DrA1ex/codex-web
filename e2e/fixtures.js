'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test: base, expect, chromium } = require('playwright/test');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const MOCK_BIN = path.join(__dirname, 'mock-app-server.js');

async function settleWithin(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function signalProcessTree(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function waitForUrl(child, output, timeoutMs = 12_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`codex-web did not print its URL\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`));
    }, timeoutMs);

    const inspect = () => {
      const match = output.stdout.match(/URL:\s+(http:\/\/[^\s]+)/);
      if (!match || settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(match[1]);
    };

    child.stdout.on('data', inspect);
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`codex-web exited before startup: code=${code} signal=${signal || 'none'}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`));
    });
  });
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  signalProcessTree(child, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (child.exitCode === null && !child.signalCode) signalProcessTree(child, 'SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (child.exitCode === null && !child.signalCode) signalProcessTree(child, 'SIGKILL');
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode) return resolve();
    child.once('exit', resolve);
    setTimeout(resolve, 1000);
  });
}


async function readJsonLines(filePath) {
  let text = '';
  try { text = await fsp.readFile(filePath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const test = base.extend({
  mockConfig: [{}, { option: true }],
  appOptions: [{}, { option: true }],

  app: async ({ mockConfig, appOptions }, use, testInfo) => {
    if (process.env.E2E_TEARDOWN_DEBUG) console.error(`[setup:start] ${testInfo.title}`);
    const browserServer = await chromium.launchServer({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
        : {}),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-timer-throttling'],
    });
    const browser = await chromium.connect(browserServer.wsEndpoint());
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-web-e2e-'));
    const stateDir = path.join(root, 'state');
    const projectDir = path.join(root, 'project');
    const controlPath = path.join(root, 'mock-control.json');
    const rpcLogPath = path.join(root, 'mock-rpc.jsonl');
    await fsp.mkdir(projectDir, { recursive: true });
    await fsp.writeFile(controlPath, JSON.stringify(mockConfig.control || {}, null, 2));

    const args = [
      path.join(PROJECT_ROOT, 'codex-web'),
      ...(appOptions.sessionId === null ? [] : [String(appOptions.sessionId || 'mock-thread')]),
      '--no-open',
      '--host', '127.0.0.1',
      '--port', '0',
      '--state-dir', stateDir,
      '--project-dir', projectDir,
      '--codex-bin', MOCK_BIN,
      '--countdown', String(appOptions.countdown ?? 0),
      '--watch-interval', String(appOptions.watchInterval ?? 5),
      '--approval-response', String(appOptions.approvalResponse || 'manual'),
      '--sandbox', String(appOptions.sandbox || 'workspace-write'),
      '--approval-policy', String(appOptions.approvalPolicy || 'on-request'),
      ...(appOptions.debug ? ['--debug'] : []),
    ];

    const child = spawn(process.execPath, args, {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        MOCK_APP_SERVER_CONTROL: controlPath,
        MOCK_APP_SERVER_LOG: rpcLogPath,
        MOCK_APP_SERVER_PROJECT_DIR: projectDir,
        MOCK_APP_SERVER_CONFIG: JSON.stringify(mockConfig.server || {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    const output = { stdout: '', stderr: '' };
    child.stdout.on('data', (chunk) => { output.stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { output.stderr += chunk.toString('utf8'); });

    let context;
    let page;
    try {
      const url = await waitForUrl(child, output);
      if (process.env.E2E_TEARDOWN_DEBUG) console.error(`[setup:url] ${testInfo.title}`);
      context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      if (process.env.E2E_TEARDOWN_DEBUG) console.error(`[setup:context] ${testInfo.title}`);
      page = await context.newPage();
      if (process.env.E2E_TEARDOWN_DEBUG) console.error(`[setup:page] ${testInfo.title}`);
      const pageErrors = [];
      page.on('pageerror', (error) => pageErrors.push(error));
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12_000 });
      await expect(page.locator('#stateBadge')).not.toHaveText('loading');
      if (process.env.E2E_TEARDOWN_DEBUG) console.error(`[setup:ready] ${testInfo.title}`);

      const app = {
        browser,
        page,
        url,
        root,
        stateDir,
        projectDir,
        controlPath,
        rpcLogPath,
        process: child,
        output,
        pageErrors,
        async setControl(patch) {
          let current = {};
          try { current = JSON.parse(await fsp.readFile(controlPath, 'utf8')); } catch (_) {}
          await fsp.writeFile(controlPath, JSON.stringify({ ...current, ...patch }, null, 2));
        },
        async rpcLog() {
          return await readJsonLines(rpcLogPath);
        },
        async clientRequests(method) {
          const entries = await readJsonLines(rpcLogPath);
          return entries
            .filter((entry) => entry.direction === 'client' && entry.message?.method === method)
            .map((entry) => entry.message);
        },
        async snapshot() {
          return await page.evaluate(async () => {
            const token = window.CODEX_LIMIT_WATCH_TOKEN;
            const response = await fetch(`/api/state?token=${encodeURIComponent(token)}`, {
              headers: { 'x-codex-limit-watch-token': token },
            });
            return await response.json();
          });
        },
      };

      await use(app);

      if (pageErrors.length) {
        throw new Error(`Browser page errors:\n${pageErrors.map((error) => error.stack || error.message).join('\n\n')}`);
      }
    } catch (error) {
      await testInfo.attach('codex-web-stdout', { body: output.stdout, contentType: 'text/plain' });
      await testInfo.attach('codex-web-stderr', { body: output.stderr, contentType: 'text/plain' });
      if (fs.existsSync(rpcLogPath)) {
        await testInfo.attach('mock-rpc-log', { path: rpcLogPath, contentType: 'application/x-ndjson' });
      }
      throw error;
    } finally {
      if (process.env.E2E_TEARDOWN_DEBUG) console.error(`[teardown:start] ${testInfo.title}`);
      if (context) await settleWithin(context.close().catch(() => {}), 2000);
      else if (page) await settleWithin(page.close().catch(() => {}), 2000);
      if (process.env.E2E_TEARDOWN_DEBUG) console.error(`[teardown:context] ${testInfo.title}`);
      await stopProcess(child);
      if (process.env.E2E_TEARDOWN_DEBUG) console.error(`[teardown:process] ${testInfo.title}`);
      await settleWithin(browser.close().catch(() => {}), 2000);
      await settleWithin(browserServer.kill().catch(() => {}), 2000);
      if (process.env.E2E_TEARDOWN_DEBUG) console.error(`[teardown:browser] ${testInfo.title}`);
      await fsp.rm(root, { recursive: true, force: true });
      if (process.env.E2E_TEARDOWN_DEBUG) console.error(`[teardown:done] ${testInfo.title}`);
    }
  },
});

async function sendComposer(page, text) {
  const composer = page.locator('#composer');
  await composer.fill(text);
  await composer.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
}

async function addToQueue(page, text) {
  const composer = page.locator('#composer');
  const addButton = page.locator('#addBtn');
  await composer.fill(text);
  await expect(addButton).toBeEnabled();
  await addButton.click();
  await expect(composer).toHaveValue('');
}

async function waitForQueueStatus(page, text, status) {
  const card = page.locator('.queue-item', { hasText: text }).first();
  await expect(card).toContainText(status);
  return card;
}

module.exports = {
  test,
  expect,
  sendComposer,
  addToQueue,
  waitForQueueStatus,
};
