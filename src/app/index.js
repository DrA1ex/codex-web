'use strict';

const http = require('node:http');
const path = require('node:path');

const { JsonRpcClient } = require('../codex/json-rpc-client');
const {
  randomId,
  isLocalHost,
  ensureDirSync,
  friendlyStartError,
} = require('../shared/utils');
const { openBrowser } = require('../http/utils');
const { makeFallbackCatalog } = require('../codex/models');
const {
  createAppState,
  createInitialRateLimits,
  createDebugState,
} = require('./defaults');

const persistenceMethods = require('./modules/persistence');
const sessionMethods = require('./modules/sessions');
const rateLimitMethods = require('./modules/rate-limits');
const modelConfigMethods = require('./modules/model-config');
const runnerMethods = require('./runner');
const eventMethods = require('./modules/events');
const outputMethods = require('./modules/output');
const queueActionMethods = require('./modules/queue-actions');
const httpMethods = require('./modules/http');

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
    this.usageRefreshTimer = null;
    this.pendingUsageRefreshItemId = null;
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
    this.sessions = [];
    this.sessionPickerReturnState = null;

    this.modelCatalog = makeFallbackCatalog();
    this.app = createAppState(opts);
    this.queue = [];
    this.output = [];
    this.lastDiffOutputText = null;
    this.currentDiffOutputId = null;
    this.currentDiffFileKey = null;
    this.diffSnapshotByFileKey = new Map();
    this.commandOutputByItemId = new Map();
    this.rateLimits = createInitialRateLimits();
    this.limitResetRequest = null;
    this.approval = null;
    this.debug = createDebugState();
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
      this.server.listen(this.opts.port, this.opts.host, resolve);
    });

    const address = this.server.address();
    this.app.url = `http://${this.opts.host}:${address.port}/?token=${this.token}`;

    await this.rpc.start().catch((err) => {
      throw friendlyStartError(err, this.opts.codexBin);
    });

    this.debug.appServerStatus = 'started';
    await this.rpc.initialize();
    await this.refreshModelCatalog();

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
    console.log(`Model: ${this.opts.model || `${this.app.defaultModel} (default)`}`);
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
  modelConfigMethods,
  runnerMethods,
  eventMethods,
  outputMethods,
  queueActionMethods,
  httpMethods,
);

module.exports = { CodexLimitWatchApp };
