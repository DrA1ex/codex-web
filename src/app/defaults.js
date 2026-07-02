'use strict';

const { DEFAULT_MODEL } = require('../shared/config');
const { makeFallbackCatalog } = require('../codex/models');
const { nowIso, shortId } = require('../shared/utils');

function createAppState(opts) {
  const modelCatalog = makeFallbackCatalog();

  return {
    state: 'initializing',
    message: '',
    url: '',
    projectDir: opts.projectDir,
    stateDir: opts.stateDir,
    sessionId: opts.sessionId,
    sessionTitle: opts.sessionId ? shortId(opts.sessionId) : 'not selected',
    model: opts.model || '',
    defaultModel: DEFAULT_MODEL,
    modelOptions: modelCatalog.modelOptions,
    effort: opts.effort || '',
    effortOptions: modelCatalog.effortOptions,
    modelCatalog: {
      source: modelCatalog.source,
      updatedAt: modelCatalog.updatedAt,
      error: modelCatalog.error,
    },
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
}

function createInitialRateLimits() {
  return {
    status: 'unknown',
    message: 'not checked yet',
    buckets: [],
    resetAt: null,
    resetCredits: null,
    raw: null,
    updatedAt: null,
    lastSuccessfulUpdatedAt: null,
    refreshFailedAt: null,
    refreshError: null,
    refreshing: false,
    stale: false,
  };
}

function createDebugState() {
  return {
    appServerStatus: 'not started',
    lastJsonRpcError: null,
    lastRateLimitPayload: null,
    lastTurnId: null,
    connectedBrowserClients: 0,
    stateDirForPair: null,
    queuePath: null,
  };
}

module.exports = {
  createAppState,
  createInitialRateLimits,
  createDebugState,
};
