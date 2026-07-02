'use strict';

const http = require('node:http');
const path = require('node:path');

const { DEFAULT_MODEL, MODEL_OPTIONS, EFFORT_OPTIONS } = require('./config');
const { JsonRpcClient } = require('./json-rpc-client');
const {
  nowIso,
  randomId,
  isLocalHost,
  ensureDirSync,
  friendlyStartError,
  shortId,
} = require('./utils');
const { openBrowser } = require('./http-utils');

const persistenceMethods = require('./app-persistence');
const sessionMethods = require('./app-sessions');
const rateLimitMethods = require('./app-rate-limits');
const runnerMethods = require('./app-runner');
const eventMethods = require('./app-events');
const outputMethods = require('./app-output');
const queueActionMethods = require('./app-queue-actions');
const httpMethods = require('./app-http');

class CodexLimitWatchApp {
  constructor(opts) {
    this.opts = opts;
    this.token = randomId(18);
    this.server = null;
    this.rpc = new JsonRpcClient(this);
    this.clients = new Set();
    this.shuttingDown = false;
    this.stateDirForPair = null;
    this.settingsPath = path.join(opts.stateDir, 'settings.json');
    this.queuePath = null;
    this.statePath = null;
    this.eventsLogPath = null;
    this.jsonRpcLogPath = null;
    this.lockPath = null;
    this.lockAcquired = false;
    this.pumpTimer = null;
    this.limitTimer = null;
    this.approvalTimer = null;
    this.countdownCancel = false;
    this.currentTurnResolve = null;
    this.currentTurnReject = null;
    this.currentItemId = null;
    this.currentTurnId = null;
    this.currentManualSend = false;
    this.manualSendContinueQueue = false;
    this.turnStarted = false;
    this.turnCompletionSeen = false;
    this.turnCompletionStatus = null;
    this.lastComposerText = '';
    this.sessionsLoaded = false;
    this.app = {
      state: 'initializing',
      message: '',
      url: '',
      projectDir: opts.projectDir,
      stateDir: opts.stateDir,
      sessionId: opts.sessionId,
      sessionTitle: opts.sessionId ? shortId(opts.sessionId) : 'not selected',
      model: opts.model || '',
      defaultModel: DEFAULT_MODEL,
      modelOptions: MODEL_OPTIONS,
      effort: opts.effort || '',
      effortOptions: EFFORT_OPTIONS,
      sandbox: opts.sandbox,
      approvalPolicy: opts.approvalPolicy,
      approvalResponse: opts.approvalResponse,
      network: opts.network,
      writableRoots: [opts.projectDir, ...opts.addDirs],
      allSessions: opts.allSessions,
      theme: 'dark',
      sessionError: null,
      scheduledRunAt: null,
      connectedClients: 0,
      startedAt: nowIso(),
    };
    this.queue = [];
    this.output = [];
    this.lastDiffOutputText = null;
    this.commandOutputByItemId = new Map();
    this.sessions = [];
    this.sessionPickerReturnState = null;
    this.rateLimits = { status: 'unknown', message: 'not checked yet', buckets: [], resetAt: null, raw: null, updatedAt: null };
    this.approval = null;
    this.debug = {
      appServerStatus: 'not started',
      lastJsonRpcError: null,
      lastRateLimitPayload: null,
      lastTurnId: null,
      connectedBrowserClients: 0,
      stateDirForPair: null,
      queuePath: null,
    };
  }

  async start() {
    ensureDirSync(this.opts.stateDir);
    await this.loadSettings();
    if (!isLocalHost(this.opts.host)) {
      console.warn(`Warning: host ${this.opts.host} is not localhost. The UI is token-protected, but localhost is safer.`);
    }
    this.server = http.createServer((req, res) => this.handleHttp(req, res));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.opts.port, this.opts.host, () => resolve());
    });
    const address = this.server.address();
    this.app.url = `http://${this.opts.host}:${address.port}/?token=${this.token}`;

    await this.rpc.start().catch((err) => {
      throw friendlyStartError(err, this.opts.codexBin);
    });
    this.debug.appServerStatus = 'started';
    await this.rpc.initialize();

    if (this.opts.sessionId) {
      await this.selectSession(this.opts.sessionId, true);
    } else {
      this.app.state = 'selecting-session';
      await this.loadSessions();
    }

    await this.pollRateLimits();
    this.scheduleLimitPolling();
    this.printStartup();
    if (!this.opts.noOpen) openBrowser(this.app.url);
    this.broadcastAll();
    this.schedulePump(500);
  }

  printStartup() {
    console.log('Codex Limit Watch Web');
    console.log(`Project: ${this.opts.projectDir}`);
    console.log(`Session: ${this.app.sessionId || 'not selected'}`);
    console.log(`Model: ${this.opts.model || DEFAULT_MODEL + ' (default)'}`);
    console.log(`Sandbox: ${this.opts.sandbox}`);
    console.log(`Approval policy: ${this.opts.approvalPolicy}`);
    console.log(`Approval response: ${this.opts.approvalResponse}`);
    console.log(`URL: ${this.app.url}`);
    if (this.opts.sandbox === 'danger-full-access') {
      console.log('Warning: danger-full-access disables normal sandbox isolation. Use only in a trusted local environment.');
    }
  }

}

Object.assign(
  CodexLimitWatchApp.prototype,
  persistenceMethods,
  sessionMethods,
  rateLimitMethods,
  runnerMethods,
  eventMethods,
  outputMethods,
  queueActionMethods,
  httpMethods,
);

module.exports = { CodexLimitWatchApp };
