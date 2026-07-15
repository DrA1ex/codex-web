#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const argv = process.argv.slice(2);
if (argv[0] !== 'app-server') {
  console.error(`mock-app-server only supports: app-server (received: ${argv.join(' ')})`);
  process.exit(2);
}

const CONTROL_PATH = process.env.MOCK_APP_SERVER_CONTROL || '';
const LOG_PATH = process.env.MOCK_APP_SERVER_LOG || '';
const PROJECT_DIR = process.env.MOCK_APP_SERVER_PROJECT_DIR || process.cwd();
const DEFAULT_THREAD_ID = process.env.MOCK_APP_SERVER_THREAD_ID || 'mock-thread';
const SECOND_THREAD_ID = process.env.MOCK_APP_SERVER_SECOND_THREAD_ID || 'mock-thread-2';
const STARTUP_CONFIG = parseJson(process.env.MOCK_APP_SERVER_CONFIG || '{}', {});

process.stdout.on('error', (error) => {
  if (error?.code === 'EPIPE') process.exit(0);
  else throw error;
});

function parseJson(text, fallback) {
  try { return JSON.parse(text); } catch (_) { return fallback; }
}

function readControl() {
  if (!CONTROL_PATH) return {};
  try { return JSON.parse(fs.readFileSync(CONTROL_PATH, 'utf8')); }
  catch (_) { return {}; }
}

function writeControl(control) {
  if (!CONTROL_PATH) return;
  fs.writeFileSync(CONTROL_PATH, JSON.stringify(control || {}, null, 2));
}

function consumeControlFlag(name) {
  const control = readControl();
  if (!control[name]) return false;
  writeControl({ ...control, [name]: false });
  return true;
}

function appendLog(entry) {
  if (!LOG_PATH) return;
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, JSON.stringify({ ts: Date.now(), ...entry }) + '\n');
  } catch (_) {}
}

function send(message) {
  appendLog({ direction: 'server', message });
  process.stdout.write(JSON.stringify(message) + '\n');
}

function sendRaw(line) {
  appendLog({ direction: 'server-raw', line: String(line) });
  process.stdout.write(String(line) + '\n');
}

function respond(id, result) {
  send({ id, result });
}

function fail(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  send({ id, error });
}

function notify(method, params = {}) {
  send({ method, params });
}

function later(delayMs, fn) {
  const timer = setTimeout(() => {
    try { fn(); }
    catch (error) {
      appendLog({ direction: 'internal', error: error.stack || error.message || String(error) });
    }
  }, delayMs);
  timer.unref?.();
  return timer;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function threadSummary(id, overrides = {}) {
  return {
    id,
    sessionId: id,
    name: overrides.name || (id === DEFAULT_THREAD_ID ? 'Mock primary session' : 'Mock secondary session'),
    preview: overrides.preview || (id === DEFAULT_THREAD_ID ? 'Primary mock conversation' : 'Secondary mock conversation'),
    cwd: overrides.cwd || PROJECT_DIR,
    path: `/tmp/${id}.jsonl`,
    ephemeral: false,
    modelProvider: 'openai',
    createdAt: overrides.createdAt || nowSec() - (id === DEFAULT_THREAD_ID ? 120 : 60),
    updatedAt: overrides.updatedAt || nowSec(),
    status: overrides.status || { type: 'idle' },
    turns: overrides.turns || undefined,
  };
}

const threads = new Map();
threads.set(DEFAULT_THREAD_ID, {
  thread: threadSummary(DEFAULT_THREAD_ID),
  turns: [],
});
threads.set(SECOND_THREAD_ID, {
  thread: threadSummary(SECOND_THREAD_ID),
  turns: [],
});

for (const configured of STARTUP_CONFIG.threads || []) {
  const id = String(configured.id || configured.threadId || '');
  if (!id) continue;
  threads.set(id, {
    thread: threadSummary(id, configured),
    turns: Array.isArray(configured.turns) ? configured.turns : [],
  });
}

let initializedRequestSeen = false;
let initializedNotificationSeen = false;
let nextThread = 3;
let nextTurn = 1;
let nextItem = 1;
let nextServerRequest = 9000;
const activeTurns = new Map();
const pendingServerRequests = new Map();

function effectiveConfig() {
  return { ...STARTUP_CONFIG, ...readControl() };
}

function rateLimitsPayload() {
  const control = effectiveConfig();
  if (control.rateLimits === 'limited') {
    return {
      rateLimits: {
        limitId: 'codex',
        limitName: 'Codex',
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: nowSec() + 600 },
        secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: nowSec() + 3600 },
        rateLimitReachedType: 'primary',
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          limitName: 'Codex',
          primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: nowSec() + 600 },
          secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: nowSec() + 3600 },
          rateLimitReachedType: 'primary',
        },
      },
      rateLimitResetCredits: {
        availableCount: 1,
        credits: [{
          id: 'mock-reset-credit',
          resetType: 'codexRateLimits',
          status: 'available',
          grantedAt: nowSec() - 60,
          expiresAt: nowSec() + 86400,
          title: 'Mock rate-limit reset',
          description: 'Reset the mock Codex window.',
        }],
      },
    };
  }
  if (control.rateLimits === 'unknown') return {};
  return {
    rateLimits: {
      limitId: 'codex',
      limitName: 'Codex',
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: nowSec() + 600 },
      secondary: { usedPercent: 22, windowDurationMins: 10080, resetsAt: nowSec() + 3600 },
      rateLimitReachedType: null,
    },
    rateLimitsByLimitId: {
      codex: {
        limitId: 'codex',
        limitName: 'Codex',
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: nowSec() + 600 },
        secondary: { usedPercent: 22, windowDurationMins: 10080, resetsAt: nowSec() + 3600 },
        rateLimitReachedType: null,
      },
    },
    rateLimitResetCredits: { availableCount: 0, credits: [] },
  };
}

function modelList() {
  return {
    data: [
      {
        id: 'gpt-5.4',
        model: 'gpt-5.4',
        displayName: 'GPT-5.4',
        hidden: false,
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'Lower latency' },
          { reasoningEffort: 'medium', description: 'Balanced' },
          { reasoningEffort: 'high', description: 'More reasoning' },
        ],
        inputModalities: ['text', 'image'],
        supportsPersonality: true,
        isDefault: true,
      },
      {
        id: 'gpt-5.4-mini',
        model: 'gpt-5.4-mini',
        displayName: 'GPT-5.4 mini',
        hidden: false,
        defaultReasoningEffort: 'low',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'Lower latency' },
          { reasoningEffort: 'medium', description: 'Balanced' },
        ],
        inputModalities: ['text'],
        supportsPersonality: false,
        isDefault: false,
      },
    ],
    nextCursor: null,
  };
}

function ensureReady(id, method) {
  if (method === 'initialize') return true;
  if (!initializedRequestSeen || !initializedNotificationSeen) {
    if (id !== undefined) fail(id, -32002, 'Not initialized');
    return false;
  }
  return true;
}

function inputText(params) {
  return (params?.input || [])
    .filter((item) => item?.type === 'text')
    .map((item) => String(item.text || ''))
    .join('\n');
}

function createTurn(threadId, prompt) {
  const id = `turn-${nextTurn++}`;
  const turn = {
    id,
    threadId,
    status: 'inProgress',
    items: [],
    error: null,
  };
  const active = {
    id,
    threadId,
    prompt,
    turn,
    timers: new Set(),
    completed: false,
    held: false,
    responseText: '',
  };
  activeTurns.set(threadId, active);
  return active;
}

function schedule(active, delayMs, fn) {
  const timer = later(delayMs, () => {
    active.timers.delete(timer);
    if (!active.completed) fn();
  });
  active.timers.add(timer);
  return timer;
}

function emitTurnStarted(active) {
  notify('turn/started', {
    threadId: active.threadId,
    turn: { ...active.turn },
  });
}

function emitItemStarted(active, item) {
  active.turn.items.push(item);
  notify('item/started', {
    threadId: active.threadId,
    turnId: active.id,
    item,
  });
}

function emitAgentDelta(active, itemId, delta) {
  notify('item/agentMessage/delta', {
    threadId: active.threadId,
    turnId: active.id,
    itemId,
    delta,
  });
}

function emitReasoningDelta(active, itemId, delta) {
  notify('item/reasoning/summaryTextDelta', {
    threadId: active.threadId,
    turnId: active.id,
    itemId,
    summaryIndex: 0,
    delta,
  });
}

function emitTokenUsage(active, totalTokens = 120) {
  notify('thread/tokenUsage/updated', {
    threadId: active.threadId,
    turnId: active.id,
    tokenUsage: {
      total: {
        totalTokens,
        inputTokens: Math.max(1, totalTokens - 40),
        cachedInputTokens: 8,
        outputTokens: 40,
        reasoningOutputTokens: 12,
      },
      last: {
        totalTokens,
        inputTokens: Math.max(1, totalTokens - 40),
        cachedInputTokens: 8,
        outputTokens: 40,
        reasoningOutputTokens: 12,
      },
      modelContextWindow: 200000,
    },
  });
}

function finishTurn(active, status = 'completed', options = {}) {
  if (!active || active.completed) return;
  active.completed = true;
  for (const timer of active.timers) clearTimeout(timer);
  active.timers.clear();

  const finalTurn = {
    ...active.turn,
    status,
    error: options.error ? { message: options.error } : null,
  };
  const record = threads.get(active.threadId);
  if (record) {
    record.turns.push(finalTurn);
    record.thread.updatedAt = nowSec();
    record.thread.preview = active.prompt.slice(0, 100);
    record.thread.status = { type: 'idle' };
  }
  activeTurns.delete(active.threadId);
  notify('turn/completed', {
    threadId: active.threadId,
    turn: finalTurn,
  });
}

function emitAgentCompletion(active, text, options = {}) {
  const itemId = options.itemId || `item-${nextItem++}`;
  const item = { id: itemId, type: 'agentMessage', text: '', phase: 'final_answer' };
  emitItemStarted(active, item);
  const chunks = options.chunks || [text];
  let accumulated = '';
  chunks.forEach((chunk, index) => {
    schedule(active, (options.startDelay || 5) + index * (options.chunkDelay || 5), () => {
      accumulated += chunk;
      emitAgentDelta(active, itemId, chunk);
      if (index === chunks.length - 1) {
        const finalItem = { ...item, text: accumulated };
        notify('item/completed', {
          threadId: active.threadId,
          turnId: active.id,
          item: finalItem,
        });
        emitTokenUsage(active, options.totalTokens || 120);
        finishTurn(active, options.status || 'completed', { error: options.error });
      }
    });
  });
}

function emitDefaultScenario(active, prompt) {
  const reasoningId = `item-${nextItem++}`;
  emitItemStarted(active, { id: reasoningId, type: 'reasoning', summary: [], content: [] });
  schedule(active, 5, () => emitReasoningDelta(active, reasoningId, 'Mock reasoning summary.'));
  schedule(active, 10, () => notify('item/completed', {
    threadId: active.threadId,
    turnId: active.id,
    item: { id: reasoningId, type: 'reasoning', summary: ['Mock reasoning summary.'], content: [] },
  }));
  emitAgentCompletion(active, `Mock response: ${prompt}`, { startDelay: 15 });
}

function emitApprovalScenario(active, kind) {
  const itemId = `item-${nextItem++}`;
  const isFile = kind === 'file';
  const item = isFile
    ? {
        id: itemId,
        type: 'fileChange',
        status: 'inProgress',
        changes: [{ path: path.join(PROJECT_DIR, 'mock.txt'), kind: 'update', diff: '@@ -0,0 +1 @@\n+mock\n' }],
      }
    : {
        id: itemId,
        type: 'commandExecution',
        command: ['printf', 'mock'],
        cwd: PROJECT_DIR,
        status: 'inProgress',
        commandActions: [],
        aggregatedOutput: '',
      };
  emitItemStarted(active, item);
  const requestId = `approval-${itemId}`;
  const rpcId = nextServerRequest++;
  pendingServerRequests.set(String(rpcId), {
    kind: 'approval',
    active,
    item,
    requestId,
    onResponse(message) {
      const decision = message.result;
      notify('serverRequest/resolved', { threadId: active.threadId, requestId });
      const accepted = decision === 'accept' || decision === 'acceptForSession' || (decision && typeof decision === 'object');
      const status = accepted ? 'completed' : 'declined';
      const completed = isFile
        ? { ...item, status }
        : { ...item, status, aggregatedOutput: accepted ? 'mock\n' : '', exitCode: accepted ? 0 : null, durationMs: 5 };
      notify('item/completed', { threadId: active.threadId, turnId: active.id, item: completed });
      const decisionLabel = decision === 'decline' ? 'declined' : (decision === 'cancel' ? 'cancelled' : (decision || 'declined'));
      emitAgentCompletion(active, accepted ? `Approval accepted (${kind}).` : `Approval ${decisionLabel} (${kind}).`, { startDelay: 5 });
    },
  });
  const method = isFile ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval';
  const params = {
    requestId,
    itemId,
    threadId: active.threadId,
    turnId: active.id,
    reason: isFile ? 'Apply mock file change' : 'Run mock command',
  };
  if (isFile) params.grantRoot = PROJECT_DIR;
  else {
    params.command = ['printf', 'mock'];
    params.cwd = PROJECT_DIR;
    params.commandActions = [];
    params.availableDecisions = ['accept', 'acceptForSession', 'decline', 'cancel'];
  }
  send({ id: rpcId, method, params });
}

function startScenario(active) {
  const prompt = active.prompt;
  const scenario = /^MOCK:([A-Z_]+)/.exec(prompt)?.[1] || 'DEFAULT';

  if (scenario === 'TERMINAL_WITHOUT_STARTED') {
    const itemId = `item-${nextItem++}`;
    notify('item/started', {
      threadId: active.threadId,
      turnId: active.id,
      item: { id: itemId, type: 'agentMessage', text: '', phase: 'final_answer' },
    });
    notify('item/agentMessage/delta', {
      threadId: active.threadId,
      turnId: active.id,
      itemId,
      delta: 'Terminal event without turn/started.',
    });
    notify('item/completed', {
      threadId: active.threadId,
      turnId: active.id,
      item: { id: itemId, type: 'agentMessage', text: 'Terminal event without turn/started.', phase: 'final_answer' },
    });
    emitTokenUsage(active, 60);
    finishTurn(active, 'completed');
    return;
  }

  if (scenario === 'COMPLETION_BEFORE_RESPONSE') {
    emitTurnStarted(active);
    const itemId = `item-${nextItem++}`;
    emitItemStarted(active, { id: itemId, type: 'agentMessage', text: '', phase: 'final_answer' });
    emitAgentDelta(active, itemId, 'Completed before response.');
    notify('item/completed', {
      threadId: active.threadId,
      turnId: active.id,
      item: { id: itemId, type: 'agentMessage', text: 'Completed before response.', phase: 'final_answer' },
    });
    emitTokenUsage(active, 50);
    finishTurn(active, 'completed');
    return;
  }

  emitTurnStarted(active);

  switch (scenario) {
    case 'SLOW': {
      active.held = true;
      const itemId = `item-${nextItem++}`;
      active.slowItemId = itemId;
      emitItemStarted(active, { id: itemId, type: 'agentMessage', text: '', phase: 'final_answer' });
      emitAgentDelta(active, itemId, 'Working slowly...');
      active.responseText = 'Working slowly...';
      return;
    }
    case 'APPROVAL_COMMAND':
      emitApprovalScenario(active, 'command');
      return;
    case 'APPROVAL_FILE':
      emitApprovalScenario(active, 'file');
      return;
    case 'APPROVAL_OVERLAP':
      emitApprovalScenario(active, 'command');
      schedule(active, 10, () => {
        const itemId = `item-${nextItem++}`;
        const rpcId = nextServerRequest++;
        pendingServerRequests.set(String(rpcId), {
          kind: 'overlap',
          active,
          item: { id: itemId, type: 'fileChange', status: 'inProgress', changes: [] },
          requestId: `approval-${itemId}`,
          onResponse(message) {
            appendLog({ direction: 'internal', overlapDecision: message.result });
          },
        });
        send({
          id: rpcId,
          method: 'item/fileChange/requestApproval',
          params: {
            requestId: `approval-${itemId}`,
            itemId,
            threadId: active.threadId,
            turnId: active.id,
            reason: 'Overlapping approval',
          },
        });
      });
      return;
    case 'MALFORMED_PROTOCOL':
      sendRaw('{not-json');
      send({ id: 999999, result: { orphan: true } });
      notify('mock/unknownNotification', { threadId: active.threadId, turnId: active.id });
      emitAgentCompletion(active, 'Recovered after malformed protocol input.', { startDelay: 10 });
      return;
    case 'DELTA_BEFORE_ITEM':
      notify('item/agentMessage/delta', {
        threadId: active.threadId,
        turnId: active.id,
        itemId: 'not-started-yet',
        delta: 'orphan delta',
      });
      emitAgentCompletion(active, 'Recovered after out-of-order item delta.', { startDelay: 10 });
      return;
    case 'UNKNOWN_ITEM_TYPE': {
      const item = { id: `item-${nextItem++}`, type: 'futureUnknownItem', payload: { value: 1 } };
      emitItemStarted(active, item);
      notify('item/completed', { threadId: active.threadId, turnId: active.id, item });
      emitAgentCompletion(active, 'Unknown item type did not break the turn.', { startDelay: 10 });
      return;
    }
    case 'REMOTE_INTERRUPTED':
      schedule(active, 10, () => finishTurn(active, 'interrupted'));
      return;
    case 'FAIL':
      schedule(active, 5, () => notify('error', {
        threadId: active.threadId,
        turnId: active.id,
        error: { message: 'Mock upstream failure', codexErrorInfo: { type: 'InternalServerError' } },
      }));
      schedule(active, 10, () => finishTurn(active, 'failed', { error: 'Mock upstream failure' }));
      return;
    case 'EXIT':
      schedule(active, 10, () => process.exit(42));
      return;
    case 'COMPLETE_THEN_EXIT':
      emitAgentCompletion(active, 'Completed immediately before app-server exit.', { startDelay: 5 });
      later(30, () => process.exit(44));
      return;
    case 'APPROVAL_THEN_EXIT':
      emitApprovalScenario(active, 'command');
      schedule(active, 500, () => process.exit(45));
      return;
    case 'FOREIGN_EVENTS':
      notify('turn/started', { threadId: SECOND_THREAD_ID, turn: { id: 'foreign-turn', threadId: SECOND_THREAD_ID, status: 'inProgress', items: [] } });
      notify('item/agentMessage/delta', { threadId: SECOND_THREAD_ID, turnId: 'foreign-turn', itemId: 'foreign-item', delta: 'FOREIGN OUTPUT MUST NOT APPEAR' });
      notify('turn/completed', { threadId: SECOND_THREAD_ID, turn: { id: 'foreign-turn', threadId: SECOND_THREAD_ID, status: 'completed', items: [] } });
      emitAgentCompletion(active, 'Local turn survived foreign events.', { startDelay: 10 });
      return;
    case 'DUPLICATE_COMPLETION':
      emitAgentCompletion(active, 'Duplicate terminal notification test.', { startDelay: 5 });
      later(80, () => notify('turn/completed', {
        threadId: active.threadId,
        turn: { ...active.turn, status: 'completed' },
      }));
      return;
    case 'UNICODE':
      emitAgentCompletion(active, 'Привет 🌲 — café — こんにちは', {
        chunks: ['Пр', 'ивет ', '🌲', ' — café — ', 'こんにちは'],
        chunkDelay: 3,
      });
      return;
    case 'LONG_OUTPUT': {
      const chunks = Array.from({ length: 120 }, (_, index) => `chunk-${String(index).padStart(3, '0')} `);
      emitAgentCompletion(active, chunks.join(''), { chunks, chunkDelay: 1, totalTokens: 5000 });
      return;
    }
    case 'LATE_USAGE': {
      const itemId = `item-${nextItem++}`;
      const text = 'Usage arrives after terminal completion.';
      emitItemStarted(active, { id: itemId, type: 'agentMessage', text: '', phase: 'final_answer' });
      emitAgentDelta(active, itemId, text);
      notify('item/completed', {
        threadId: active.threadId,
        turnId: active.id,
        item: { id: itemId, type: 'agentMessage', text, phase: 'final_answer' },
      });
      finishTurn(active, 'completed');
      later(80, () => emitTokenUsage(active, 777));
      return;
    }
    case 'FOREIGN_USAGE':
      notify('thread/tokenUsage/updated', {
        threadId: SECOND_THREAD_ID,
        turnId: 'foreign-turn',
        tokenUsage: {
          total: { totalTokens: 999999, inputTokens: 999990, outputTokens: 9 },
          last: { totalTokens: 999999, inputTokens: 999990, outputTokens: 9 },
          modelContextWindow: 1000000,
        },
      });
      emitAgentCompletion(active, 'Foreign usage was ignored.', { startDelay: 10, totalTokens: 91 });
      return;
    case 'EMPTY_COMPLETION':
      schedule(active, 5, () => finishTurn(active, 'completed'));
      return;
    case 'DUPLICATE_ITEM_COMPLETION': {
      const itemId = `item-${nextItem++}`;
      const item = { id: itemId, type: 'agentMessage', text: 'One completed item.', phase: 'final_answer' };
      emitItemStarted(active, { ...item, text: '' });
      emitAgentDelta(active, itemId, item.text);
      notify('item/completed', { threadId: active.threadId, turnId: active.id, item });
      notify('item/completed', { threadId: active.threadId, turnId: active.id, item });
      emitTokenUsage(active, 44);
      finishTurn(active, 'completed');
      return;
    }
    default:
      emitDefaultScenario(active, prompt);
  }
}

function handleRequest(message) {
  const { id, method, params } = message;
  if (!ensureReady(id, method)) return;

  switch (method) {
    case 'initialize': {
      if (initializedRequestSeen) {
        fail(id, -32600, 'Already initialized');
        return;
      }
      initializedRequestSeen = true;
      respond(id, {
        userAgent: 'mock-codex-app-server/1.0',
        codexHome: '/tmp/mock-codex-home',
        platformFamily: 'unix',
        platformOs: process.platform,
      });
      return;
    }
    case 'model/list':
      respond(id, modelList());
      return;
    case 'account/rateLimits/read':
      respond(id, rateLimitsPayload());
      return;
    case 'account/rateLimitResetCredit/consume': {
      if (consumeControlFlag('resetConsumeFailureOnce')) {
        fail(id, -32020, 'Mock reset consume failure');
        return;
      }
      const control = readControl();
      writeControl({ ...control, rateLimits: 'available' });
      respond(id, { outcome: 'reset' });
      return;
    }
    case 'thread/list': {
      const data = [...threads.values()].map((entry) => ({ ...entry.thread, turns: undefined }));
      respond(id, { data, nextCursor: null });
      return;
    }
    case 'thread/loaded/list': {
      const data = [...threads.values()].map((entry) => ({ ...entry.thread, turns: undefined }));
      respond(id, { data, nextCursor: null });
      return;
    }
    case 'thread/resume': {
      const threadId = String(params?.threadId || '');
      const entry = threads.get(threadId);
      if (!entry) {
        fail(id, -32602, `Thread not found: ${threadId}`);
        return;
      }
      respond(id, { thread: { ...entry.thread, turns: undefined }, instructionSources: [] });
      return;
    }
    case 'thread/start': {
      const threadId = `mock-thread-${nextThread++}`;
      const entry = { thread: threadSummary(threadId, { cwd: params?.cwd || PROJECT_DIR, name: `Mock session ${threadId}` }), turns: [] };
      threads.set(threadId, entry);
      respond(id, { thread: { ...entry.thread, turns: undefined }, instructionSources: [] });
      later(0, () => notify('thread/started', { thread: { ...entry.thread, turns: undefined } }));
      return;
    }
    case 'thread/read': {
      const threadId = String(params?.threadId || '');
      const entry = threads.get(threadId);
      if (!entry) {
        fail(id, -32602, `Thread not found: ${threadId}`);
        return;
      }
      respond(id, {
        thread: {
          ...entry.thread,
          status: activeTurns.has(threadId) ? { type: 'active', activeFlags: ['turn'] } : { type: 'idle' },
          turns: params?.includeTurns ? entry.turns : undefined,
        },
      });
      return;
    }
    case 'turn/start': {
      const threadId = String(params?.threadId || '');
      const prompt = inputText(params);
      if (/^MOCK:START_REJECT/.test(prompt)) {
        fail(id, -32031, 'Mock turn/start rejection');
        return;
      }
      if (!threads.has(threadId)) {
        fail(id, -32602, `Thread not found: ${threadId}`);
        return;
      }
      if (activeTurns.has(threadId)) {
        fail(id, -32000, 'A turn is already active', { codexErrorInfo: 'TurnAlreadyActive' });
        return;
      }
      const active = createTurn(threadId, prompt);
      if (/^MOCK:EXIT_BEFORE_RESPONSE/.test(prompt)) {
        later(0, () => process.exit(43));
        return;
      }
      if (/^MOCK:EXIT_BEFORE_STARTED/.test(prompt)) {
        respond(id, { turn: { ...active.turn } });
        later(0, () => process.exit(46));
        return;
      }
      if (/^MOCK:COMPLETION_BEFORE_RESPONSE/.test(prompt)) {
        startScenario(active);
        respond(id, { turn: { ...active.turn } });
      } else {
        respond(id, { turn: { ...active.turn } });
        later(0, () => startScenario(active));
      }
      return;
    }
    case 'turn/interrupt': {
      const threadId = String(params?.threadId || '');
      const active = activeTurns.get(threadId);
      if (consumeControlFlag('interruptRejectOnce')) {
        fail(id, -32032, 'Mock interrupt rejection');
        return;
      }
      if (!active || (params?.turnId && params.turnId !== active.id)) {
        fail(id, -32602, 'No matching active turn');
        return;
      }
      respond(id, {});
      finishTurn(active, 'interrupted');
      return;
    }
    case 'turn/steer': {
      const threadId = String(params?.threadId || '');
      const active = activeTurns.get(threadId);
      if (consumeControlFlag('steerRejectOnce')) {
        fail(id, -32000, 'activeTurnNotSteerable', { reason: 'activeTurnNotSteerable' });
        return;
      }
      if (!active || (params?.expectedTurnId && params.expectedTurnId !== active.id)) {
        fail(id, -32000, 'activeTurnNotSteerable', { reason: 'activeTurnNotSteerable' });
        return;
      }
      const steerText = inputText(params);
      respond(id, { turnId: active.id });
      const itemId = `item-${nextItem++}`;
      notify('item/started', {
        threadId,
        turnId: active.id,
        item: { id: itemId, type: 'userMessage', content: [{ type: 'text', text: steerText }] },
      });
      if (active.held) {
        const chunk = ` Steered: ${steerText}`;
        active.responseText += chunk;
        emitAgentDelta(active, active.slowItemId, chunk);
        later(20, () => {
          notify('item/completed', {
            threadId,
            turnId: active.id,
            item: { id: active.slowItemId, type: 'agentMessage', text: active.responseText, phase: 'final_answer' },
          });
          emitTokenUsage(active, 160);
          finishTurn(active, 'completed');
        });
      }
      return;
    }
    case 'thread/compact/start': {
      const threadId = String(params?.threadId || '');
      if (consumeControlFlag('compactRejectOnce')) {
        fail(id, -32033, 'Mock compaction rejection');
        return;
      }
      if (!threads.has(threadId)) {
        fail(id, -32602, `Thread not found: ${threadId}`);
        return;
      }
      if (activeTurns.has(threadId)) {
        fail(id, -32000, 'A turn is already active');
        return;
      }
      respond(id, {});
      const active = createTurn(threadId, '/compact');
      later(0, () => {
        emitTurnStarted(active);
        const item = { id: `item-${nextItem++}`, type: 'contextCompaction' };
        emitItemStarted(active, item);
        later(10, () => {
          notify('item/completed', { threadId, turnId: active.id, item });
          emitTokenUsage(active, 30);
          finishTurn(active, 'completed');
        });
      });
      return;
    }
    default:
      fail(id, -32601, `Method not found: ${method}`);
  }
}

function handleResponse(message) {
  const pending = pendingServerRequests.get(String(message.id));
  if (!pending) {
    appendLog({ direction: 'internal', orphanClientResponse: message });
    return;
  }
  pendingServerRequests.delete(String(message.id));
  pending.onResponse(message);
}

function handleMessage(message) {
  appendLog({ direction: 'client', message });
  if (Object.prototype.hasOwnProperty.call(message, 'id') && message.method) {
    handleRequest(message);
    return;
  }
  if (Object.prototype.hasOwnProperty.call(message, 'id') && !message.method) {
    handleResponse(message);
    return;
  }
  if (message.method === 'initialized') {
    if (!initializedRequestSeen) return;
    initializedNotificationSeen = true;
    return;
  }
  if (!ensureReady(undefined, message.method)) return;
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const message = parseJson(trimmed, null);
  if (!message || typeof message !== 'object') {
    appendLog({ direction: 'internal', invalidJson: trimmed.slice(0, 500) });
    return;
  }
  handleMessage(message);
});
rl.on('close', () => process.exit(0));

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
process.on('uncaughtException', (error) => {
  appendLog({ direction: 'internal', error: error.stack || error.message || String(error) });
  console.error(error.stack || error.message || error);
  process.exit(1);
});
