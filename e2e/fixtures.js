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
      Promise.resolve(promise).then(() => true, () => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closeBrowserReliably(browser, context) {
  await settleWithin(context.close().catch(() => {}), 2500);
  const closedNormally = await settleWithin(browser.close().catch(() => {}), 2500);
  if (closedNormally) return;

  // A system Chromium can stop answering the close command after crash-heavy
  // scenarios. Playwright keeps the actual child process on the in-process
  // implementation; kill it only after graceful close has timed out, then close
  // the transport so the Playwright worker cannot remain alive on an IPC pipe.
  const implementation = browser?._connection?.toImpl?.(browser);
  const browserProcess = implementation?.options?.browserProcess;
  await settleWithin(Promise.resolve(browserProcess?.kill?.()).catch(() => {}), 2500);
  try { browser?._connection?.close?.(new Error('Forced Chromium shutdown after close timeout')); } catch (_) {}
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
  child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 250));
  if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
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

  testBrowser: [async ({}, use) => {
    const browserRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-web-browser-'));
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
        : {}),
      env: {
        ...process.env,
        XDG_CONFIG_HOME: path.join(browserRoot, 'config'),
        XDG_CACHE_HOME: path.join(browserRoot, 'cache'),
      },
      args: [
        '--no-sandbox',
        '--no-zygote',
        '--disable-gpu',
        '--disable-crash-reporter',
        '--disable-crashpad',
        '--disable-dev-shm-usage',
        '--disable-background-timer-throttling',
      ],
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    try {
      await use({ browser, context, page });
    } finally {
      if (process.env.E2E_TEARDOWN_DEBUG) console.error('[browser:close]');
      await closeBrowserReliably(browser, context);
      await fsp.rm(browserRoot, { recursive: true, force: true });
      if (process.env.E2E_TEARDOWN_DEBUG) console.error('[browser:closed]');
    }
  }, { scope: 'worker' }],

  app: async ({ mockConfig, appOptions, testBrowser }, use, testInfo) => {
    if (process.env.E2E_TEARDOWN_DEBUG) console.error(`[setup:start] ${testInfo.title}`);
    const { browser, page } = testBrowser;
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-web-e2e-'));
    const stateDir = path.join(root, 'state');
    let projectDir = path.join(root, 'project');
    const controlPath = path.join(root, 'mock-control.json');
    const rpcLogPath = path.join(root, 'mock-rpc.jsonl');
    await fsp.mkdir(projectDir, { recursive: true });
    projectDir = await fsp.realpath(projectDir);
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
        CODEX_APP_SERVER_DETACHED: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    const output = { stdout: '', stderr: '' };
    child.stdout.on('data', (chunk) => { output.stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { output.stderr += chunk.toString('utf8'); });

    let pageErrorListener;
    try {
      const url = await waitForUrl(child, output);
      if (process.env.E2E_TEARDOWN_DEBUG) console.error(`[setup:url] ${testInfo.title}`);
      if (process.env.E2E_TEARDOWN_DEBUG) console.error(`[setup:context] ${testInfo.title}`);
      if (process.env.E2E_TEARDOWN_DEBUG) console.error(`[setup:page] ${testInfo.title}`);
      const pageErrors = [];
      pageErrorListener = (error) => pageErrors.push(error);
      page.on('pageerror', pageErrorListener);
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
        async api(route, body = {}) {
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
            const text = await response.text();
            let payload = null;
            try { payload = text ? JSON.parse(text) : null; } catch (_) { payload = { raw: text }; }
            if (!response.ok) {
              const error = new Error(payload?.error || `HTTP ${response.status}`);
              error.status = response.status;
              throw error;
            }
            return payload;
          }, { route, body });
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
      if (pageErrorListener) page.off('pageerror', pageErrorListener);
      await settleWithin(page.goto('about:blank', { waitUntil: 'commit', timeout: 1500 }).catch(() => {}), 2000);
      if (process.env.E2E_TEARDOWN_DEBUG) console.error(`[teardown:context] ${testInfo.title}`);
      await stopProcess(child);
      if (process.env.E2E_TEARDOWN_DEBUG) console.error(`[teardown:process] ${testInfo.title}`);
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
