'use strict';

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { CodexLimitWatchApp } = require('../src/app');
const { normalizeQueueItem, normalizeQueueOrder } = require('../src/queue');

function item(id, status = 'pending', extra = {}) {
  return normalizeQueueItem({ id, text: `Prompt ${id}`, status, ...extra });
}

async function tempDir() {
  return await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-web-test-'));
}

function makeAppWithQueue(queue = [], overrides = {}) {
  const app = new CodexLimitWatchApp({
    stateDir: path.join(os.tmpdir(), 'codex-web-test'),
    projectDir: process.cwd(),
    sessionId: 'session',
    model: '',
    effort: '',
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    approvalResponse: '',
    network: true,
    addDirs: [],
    allSessions: false,
    debug: false,
    watchInterval: 60,
    countdown: 0,
    codexBin: 'codex',
    host: '127.0.0.1',
    port: 0,
    noOpen: true,
    sessionPickerLimit: 50,
    force: true,
    logJsonrpc: false,
    modelProvided: false,
    effortProvided: false,
    ...overrides,
  });
  app.queue = queue;
  app.saveQueue = async () => { app.queue = normalizeQueueOrder(app.queue); };
  app.saveState = async () => {};
  app.saveSettings = async () => {};
  app.broadcastAll = () => {};
  app.broadcast = () => {};
  app.eventLog = () => {};
  app.debugLog = () => {};
  app.schedulePump = (delay = 0) => { app.lastScheduledDelay = delay; };
  app.clearPumpTimer = () => { app.pumpTimer = null; return true; };
  return app;
}

function mockResponse() {
  return {
    status: null,
    headers: null,
    body: '',
    chunks: [],
    ended: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    write(chunk) {
      this.chunks.push(String(chunk));
      this.body += String(chunk);
    },
    end(body) {
      if (body !== undefined) {
        this.body += String(body);
        this.chunks.push(String(body));
      }
      this.ended = true;
    },
  };
}

module.exports = {
  item,
  tempDir,
  makeAppWithQueue,
  mockResponse,
};
