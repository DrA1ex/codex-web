'use strict';

function makeDeferred() {
  let resolvePromise;
  let rejectPromise;
  const deferred = {
    settled: false,
    value: undefined,
    error: null,
    promise: null,
    resolve(value) {
      if (deferred.settled) return false;
      deferred.settled = true;
      deferred.value = value;
      resolvePromise(value);
      return true;
    },
    reject(error) {
      if (deferred.settled) return false;
      deferred.settled = true;
      deferred.error = error;
      rejectPromise(error);
      return true;
    },
  };
  deferred.promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  // A coordinator can be rejected by process shutdown before sendPrompt starts
  // awaiting it. Keep Node from reporting an unhandled rejection in that gap.
  deferred.promise.catch(() => {});
  return deferred;
}

function eventThreadId(params) {
  const turn = params?.turn || params || {};
  return params?.threadId
    || params?.thread_id
    || turn?.threadId
    || turn?.thread_id
    || null;
}

function eventTurnId(params) {
  const turn = params?.turn || params || {};
  return turn?.id
    || turn?.turnId
    || turn?.turn_id
    || params?.turnId
    || params?.turn_id
    || params?.item?.turnId
    || params?.item?.turn_id
    || null;
}

class TurnCoordinator {
  constructor(app) {
    this.app = app;
    this.operation = null;
    this.legacy = {
      itemId: null,
      turnId: null,
      resolve: null,
      reject: null,
      started: false,
      completionSeen: false,
      completionStatus: null,
    };
    this.forceSteer = null;
    this.intentionalInterrupts = new Map();
  }

  get itemId() {
    return this.operation?.itemId || this.legacy.itemId || null;
  }

  set itemId(value) {
    const normalized = value || null;
    if (this.operation) this.operation.itemId = normalized;
    this.legacy.itemId = normalized;
  }

  get currentTurnId() {
    return this.operation?.currentTurnId || this.legacy.turnId || null;
  }

  set currentTurnId(value) {
    const normalized = value || null;
    if (this.operation) {
      this.operation.currentTurnId = normalized;
      if (normalized) this.operation.acceptedTurnIds.add(normalized);
    }
    this.legacy.turnId = normalized;
  }

  get started() {
    return Boolean(this.operation?.started || this.legacy.started);
  }

  set started(value) {
    if (this.operation) this.operation.started = Boolean(value);
    this.legacy.started = Boolean(value);
  }

  get completionSeen() {
    return Boolean(this.operation?.terminal || this.legacy.completionSeen);
  }

  set completionSeen(value) {
    this.legacy.completionSeen = Boolean(value);
    if (!value && this.operation) this.operation.terminal = null;
  }

  get completionStatus() {
    return this.operation?.terminal?.status || this.legacy.completionStatus || null;
  }

  set completionStatus(value) {
    this.legacy.completionStatus = value || null;
  }

  begin({ threadId, itemId, outputGroupId = null }) {
    if (this.operation && !this.operation.deferred.settled) {
      throw new Error('A turn operation is already active');
    }
    this.forceSteer = null;
    this.intentionalInterrupts.clear();
    const deferred = makeDeferred();
    this.operation = {
      threadId: threadId || null,
      itemId: itemId || null,
      outputGroupId,
      phase: 'starting',
      currentTurnId: null,
      acceptedTurnIds: new Set(),
      interruptedTurnIds: new Set(),
      started: false,
      terminal: null,
      deferred,
      createdAt: Date.now(),
    };
    this.legacy.itemId = itemId || null;
    this.legacy.turnId = null;
    this.legacy.started = false;
    this.legacy.completionSeen = false;
    this.legacy.completionStatus = null;
    return this.operation;
  }

  ensureLegacyOperation() {
    if (this.operation) return this.operation;
    if (!this.legacy.itemId && !this.legacy.turnId) return null;
    const deferred = makeDeferred();
    const acceptedTurnIds = new Set();
    if (this.legacy.turnId) acceptedTurnIds.add(this.legacy.turnId);
    this.operation = {
      threadId: this.app?.app?.sessionId || null,
      itemId: this.legacy.itemId || null,
      outputGroupId: this.app?.currentOutputGroupId || null,
      phase: this.legacy.turnId ? 'streaming' : 'starting',
      currentTurnId: this.legacy.turnId || null,
      acceptedTurnIds,
      interruptedTurnIds: new Set(),
      started: Boolean(this.legacy.started || this.legacy.turnId),
      terminal: null,
      deferred,
      createdAt: Date.now(),
    };
    return this.operation;
  }

  matchesThread(params, operation = this.operation) {
    const threadId = eventThreadId(params);
    if (!threadId) return true;
    const expected = operation?.threadId || this.app?.app?.sessionId || null;
    return !expected || threadId === expected;
  }

  matchesScopedEvent(params, { allowUnscoped = true } = {}) {
    const operation = this.operation || this.ensureLegacyOperation();
    if (!operation) return allowUnscoped;
    if (!this.matchesThread(params, operation)) return false;
    const turnId = eventTurnId(params);
    if (!turnId) return allowUnscoped;
    if (operation.acceptedTurnIds.has(turnId)) return true;
    if (this.forceSteer?.replacementTurnId === turnId) return true;
    return false;
  }

  acceptTurn(turnId, { replacement = false } = {}) {
    if (!turnId) return null;
    const operation = this.operation || this.ensureLegacyOperation();
    if (!operation) return null;
    operation.acceptedTurnIds.add(turnId);
    operation.currentTurnId = turnId;
    operation.phase = 'streaming';
    operation.started = true;
    this.legacy.turnId = turnId;
    this.legacy.started = true;
    if (replacement && this.forceSteer) {
      this.forceSteer.replacementTurnId = turnId;
      this.forceSteer.awaitingReplacementTurn = false;
    }
    return operation;
  }

  correlateStarted(params) {
    const operation = this.operation || this.ensureLegacyOperation();
    if (!operation || !this.matchesThread(params, operation)) return { matched: false };
    if (operation.terminal) return { matched: false, ignored: true, reason: 'terminal-already-seen' };
    const turnId = eventTurnId(params) || operation.currentTurnId;
    if (!turnId) return { matched: false };

    const force = this.forceSteer;
    if (force) {
      if (force.interruptedTurnIds?.includes(turnId) || turnId === force.originalTurnId) {
        return { matched: false, ignored: true, turnId, reason: 'interrupted-turn' };
      }
      if (force.awaitingReplacementTurn || force.replacementTurnId === turnId) {
        this.acceptTurn(turnId, { replacement: true });
        return { matched: true, replacement: true, turnId, operation };
      }
    }

    if (operation.acceptedTurnIds.size > 0 && !operation.acceptedTurnIds.has(turnId)) {
      return { matched: false, turnId, reason: 'unknown-turn' };
    }
    this.acceptTurn(turnId);
    return { matched: true, replacement: false, turnId, operation };
  }

  isIntentionalInterrupt(turnId, method, status, errorMessage) {
    if (turnId && this.intentionalInterrupts.has(turnId)) {
      return { turnId, record: this.intentionalInterrupts.get(turnId) };
    }
    if (!turnId && method === 'turn/failed' && /interrupt|cancel/i.test(errorMessage || status || '')) {
      if (this.forceSteer) {
        return {
          turnId: null,
          record: {
            queueItemId: this.forceSteer.queueItemId || null,
            outputGroupId: this.forceSteer.outputGroupId || null,
            handled: false,
          },
        };
      }
      const latest = [...this.intentionalInterrupts.values()].at(-1);
      if (latest) return { turnId: null, record: latest };
    }
    return null;
  }

  correlateTerminal(method, params, status, errorMessage) {
    const operation = this.operation || this.ensureLegacyOperation();
    if (!operation || !this.matchesThread(params, operation)) return { matched: false };
    if (operation.terminal) return { matched: false, ignored: true, reason: 'terminal-already-seen' };
    const turnId = eventTurnId(params);
    const interrupted = this.isIntentionalInterrupt(turnId, method, status, errorMessage);
    if (interrupted) return { matched: true, ignored: true, interrupted, turnId };

    let matchedTurnId = turnId;
    if (matchedTurnId) {
      if (!operation.acceptedTurnIds.has(matchedTurnId)) {
        if (operation.acceptedTurnIds.size === 0 && operation.phase === 'starting') {
          this.acceptTurn(matchedTurnId);
        } else if (this.forceSteer?.replacementTurnId === matchedTurnId) {
          this.acceptTurn(matchedTurnId, { replacement: true });
        } else {
          return { matched: false, turnId: matchedTurnId, reason: 'unknown-turn' };
        }
      }
    } else {
      matchedTurnId = operation.currentTurnId;
      if (!matchedTurnId) return { matched: false, reason: 'missing-turn-id' };
    }

    const terminal = {
      method,
      status,
      errorMessage: errorMessage || null,
      turnId: matchedTurnId,
      threadId: operation.threadId,
    };
    operation.terminal = terminal;
    operation.phase = 'terminal';
    this.legacy.completionSeen = true;
    this.legacy.completionStatus = status;
    operation.deferred.resolve(terminal);
    if (typeof this.legacy.resolve === 'function') this.legacy.resolve(terminal);
    return { matched: true, ignored: false, turnId: matchedTurnId, terminal, operation };
  }

  waitForCompletion() {
    const operation = this.operation || this.ensureLegacyOperation();
    if (!operation) return Promise.reject(new Error('No active turn operation'));
    return operation.deferred.promise;
  }

  fail(error) {
    const operation = this.operation || this.ensureLegacyOperation();
    if (!operation) {
      if (typeof this.legacy.reject === 'function') this.legacy.reject(error);
      return false;
    }
    operation.phase = 'failed';
    operation.deferred.reject(error);
    if (typeof this.legacy.reject === 'function') this.legacy.reject(error);
    return true;
  }

  resolveSynthetic(status = 'interrupted', extra = {}) {
    const operation = this.operation || this.ensureLegacyOperation();
    if (!operation) return false;
    const terminal = {
      method: 'synthetic',
      status,
      errorMessage: extra.errorMessage || null,
      turnId: operation.currentTurnId || null,
      threadId: operation.threadId,
      ...extra,
    };
    operation.terminal = terminal;
    operation.phase = 'terminal';
    this.legacy.completionSeen = true;
    this.legacy.completionStatus = status;
    operation.deferred.resolve(terminal);
    if (typeof this.legacy.resolve === 'function') this.legacy.resolve(terminal);
    return true;
  }

  beginForceSteer(data) {
    const operation = this.operation || this.ensureLegacyOperation();
    if (!operation) throw new Error('No active turn operation');
    const originalTurnId = data.originalTurnId || operation.currentTurnId;
    const previousIds = this.forceSteer?.interruptedTurnIds || [];
    const interruptedTurnIds = [...new Set([...previousIds, originalTurnId].filter(Boolean))];
    for (const turnId of interruptedTurnIds) operation.interruptedTurnIds.add(turnId);
    if (originalTurnId) {
      this.intentionalInterrupts.set(originalTurnId, {
        queueItemId: data.queueItemId || operation.itemId || null,
        outputGroupId: data.outputGroupId || operation.outputGroupId || null,
        createdAt: data.createdAt || new Date().toISOString(),
        handled: false,
      });
    }
    this.forceSteer = {
      ...data,
      originalTurnId,
      replacementTurnId: null,
      interruptedTurnIds,
      awaitingReplacementTurn: Boolean(data.awaitingReplacementTurn),
    };
    return this.forceSteer;
  }

  rollbackForceSteer({ removeInterrupt = true } = {}) {
    const force = this.forceSteer;
    if (force && removeInterrupt) {
      for (const turnId of force.interruptedTurnIds || []) this.intentionalInterrupts.delete(turnId);
    }
    this.forceSteer = null;
  }

  finishForceSteer() {
    this.forceSteer = null;
  }

  reset() {
    this.operation = null;
    this.forceSteer = null;
    this.intentionalInterrupts.clear();
    this.legacy.itemId = null;
    this.legacy.turnId = null;
    this.legacy.resolve = null;
    this.legacy.reject = null;
    this.legacy.started = false;
    this.legacy.completionSeen = false;
    this.legacy.completionStatus = null;
  }
}

function installTurnCompatibilityAliases(app, coordinator) {
  const aliases = {
    currentItemId: {
      get: () => coordinator.itemId,
      set: (value) => { coordinator.itemId = value; },
    },
    currentTurnId: {
      get: () => coordinator.currentTurnId,
      set: (value) => { coordinator.currentTurnId = value; },
    },
    currentTurnResolve: {
      get: () => coordinator.legacy.resolve,
      set: (value) => { coordinator.legacy.resolve = typeof value === 'function' ? value : null; },
    },
    currentTurnReject: {
      get: () => coordinator.legacy.reject,
      set: (value) => { coordinator.legacy.reject = typeof value === 'function' ? value : null; },
    },
    turnStarted: {
      get: () => coordinator.started,
      set: (value) => { coordinator.started = value; },
    },
    turnCompletionSeen: {
      get: () => coordinator.completionSeen,
      set: (value) => { coordinator.completionSeen = value; },
    },
    turnCompletionStatus: {
      get: () => coordinator.completionStatus,
      set: (value) => { coordinator.completionStatus = value; },
    },
    forceSteer: {
      get: () => coordinator.forceSteer,
      set: (value) => { coordinator.forceSteer = value || null; },
    },
    intentionalInterrupts: {
      get: () => coordinator.intentionalInterrupts,
      set: (value) => { coordinator.intentionalInterrupts = value instanceof Map ? value : new Map(); },
    },
  };
  for (const [name, descriptor] of Object.entries(aliases)) {
    Object.defineProperty(app, name, { configurable: true, enumerable: true, ...descriptor });
  }
}

module.exports = {
  TurnCoordinator,
  installTurnCompatibilityAliases,
  eventThreadId,
  eventTurnId,
};
