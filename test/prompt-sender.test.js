'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { item, makeAppWithQueue } = require('./helpers');

test('sendComposerNow creates a queue item and sends immediately only when idle', async () => {
  const app = makeAppWithQueue([]);
  app.rateLimits = { status: 'available', buckets: [], resetAt: null };
  const sent = [];
  app.sendPrompt = async (queueItem, options) => {
    sent.push({ queueItem, options });
  };

  const result = await app.sendComposerNow('hello from composer');

  assert.equal(result.ok, true);
  assert.equal(result.clearComposer, true);
  assert.equal(result.item.text, 'hello from composer');
  assert.deepEqual(app.queue.map((i) => i.id), [result.item.id]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].queueItem.id, result.item.id);
  assert.deepEqual(sent[0].options, { continueQueue: false });
});

test('sendComposerNow queues instead of erroring when busy or pending exists', async () => {
  const busy = makeAppWithQueue([]);
  busy.rateLimits = { status: 'available', buckets: [], resetAt: null };
  busy.app.state = 'countdown';
  const busyResult = await busy.sendComposerNow('hello');
  assert.equal(busyResult.ok, true);
  assert.equal(busyResult.clearComposer, true);
  assert.deepEqual(busy.queue.map((i) => i.text), ['hello']);
  assert.equal(busy.lastScheduledDelay, 200);

  const queued = makeAppWithQueue([item('pending')]);
  queued.rateLimits = { status: 'available', buckets: [], resetAt: null };
  const queuedResult = await queued.sendComposerNow('hello');
  assert.equal(queuedResult.ok, true);
  assert.equal(queuedResult.clearComposer, true);
  assert.deepEqual(queued.queue.map((i) => i.text), ['Prompt pending', 'hello']);
  assert.equal(queued.lastScheduledDelay, 200);
});

test('sendComposerNow queues and clears composer when limits are not available', async () => {
  const app = makeAppWithQueue([]);
  app.rateLimits = { status: 'limited', buckets: [], resetAt: null };
  app.sendPrompt = async () => { throw new Error('should not send while limited'); };

  const result = await app.sendComposerNow('wait for limit');

  assert.equal(result.ok, true);
  assert.equal(result.clearComposer, true);
  assert.deepEqual(app.queue.map((i) => i.text), ['wait for limit']);
  assert.equal(app.lastScheduledDelay, 200);
});

test('sendComposerNow executes exact command and validates empty/session states', async () => {
  const app = makeAppWithQueue([]);
  const commands = [];
  app.executeCommand = async (command) => { commands.push(command); return { ok: true, clearComposer: true }; };

  assert.deepEqual(await app.sendComposerNow('  '), { ok: false, message: 'Prompt is empty' });
  assert.deepEqual(await app.sendComposerNow('/resume'), { ok: true, clearComposer: true });
  assert.deepEqual(commands, ['/resume']);

  const noSession = makeAppWithQueue([]);
  noSession.app.sessionId = null;
  await assert.rejects(() => noSession.sendComposerNow('hello'), /No Codex session selected/);
});

test('sendItemNow keeps active prompt above pending item when queue is already processing', async () => {
  const active = item('active', 'sent');
  const first = item('first');
  const second = item('second');
  const app = makeAppWithQueue([first, active, second]);
  app.currentItemId = 'active';

  await app.sendItemNow(second);

  assert.deepEqual(app.queue.map((i) => i.id), ['active', 'second', 'first']);
  assert.equal(app.lastScheduledDelay, 200);
  assert.match(app.output.at(-1).text, /\[queue\] next #second/);
});

test('sendItemNow promotes idle item to first pending slot before manual send', async () => {
  const first = item('first');
  const second = item('second');
  const done = item('done', 'completed');
  const third = item('third');
  const app = makeAppWithQueue([first, done, second, third]);
  app.rateLimits = { status: 'available', buckets: [], resetAt: null };
  const sent = [];
  app.runCountdownAndSend = async (queueItem, options) => {
    sent.push({ queueItem, options });
  };

  const result = await app.sendItemNow(second);

  assert.equal(result.ok, true);
  assert.deepEqual(app.queue.map((i) => i.id), ['done', 'second', 'first', 'third']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].queueItem.id, 'second');
  assert.deepEqual(sent[0].options, { continueQueue: false });
});

test('sendItemNow rejects extra sends while countdown is active', async () => {
  const first = item('first');
  const second = item('second');
  const app = makeAppWithQueue([first, second]);
  app.app.state = 'countdown';

  await assert.rejects(() => app.sendItemNow(second), /already scheduled to send/);

  assert.deepEqual(app.queue.map((i) => i.id), ['first', 'second']);
  assert.equal(app.lastScheduledDelay, undefined);
});

test('sendItemNow queues next item during running manual send without resuming queue', async () => {
  const active = item('active', 'sent');
  const first = item('first');
  const second = item('second');
  const app = makeAppWithQueue([first, active, second]);
  app.app.state = 'streaming';
  app.currentItemId = 'active';
  app.currentManualSend = true;

  const result = await app.sendItemNow(second);

  assert.equal(result.ok, true);
  assert.deepEqual(app.queue.map((i) => i.id), ['active', 'second', 'first']);
  assert.equal(app.manualSendContinueQueue, false);
  assert.equal(app.currentManualSend, true);
});

test('sendItemNow reserves manual send before async rate-limit polling', async () => {
  const first = item('first');
  const second = item('second');
  const app = makeAppWithQueue([first, second]);
  app.rateLimits = { status: 'unknown', buckets: [], resetAt: null };
  let releasePoll;
  app.pollRateLimits = async () => {
    await new Promise((resolve) => {
      releasePoll = () => {
        app.rateLimits = { status: 'available', buckets: [], resetAt: null };
        resolve();
      };
    });
  };
  const sent = [];
  app.runCountdownAndSend = async (queueItem, options) => {
    sent.push({ queueItem, options });
  };

  const firstSend = app.sendItemNow(first);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(app.currentManualSend, true);
  await assert.rejects(() => app.sendItemNow(second), /already scheduled to send/);
  assert.deepEqual(app.queue.map((i) => i.id), ['first', 'second']);

  releasePoll();
  await firstSend;

  assert.equal(app.currentManualSend, false);
  assert.deepEqual(sent.map((entry) => entry.queueItem.id), ['first']);
});

test('countdown tick emits only output event after initial state update', async () => {
  const pending = item('pending');
  const app = makeAppWithQueue([pending], { countdown: 1 });
  const events = [];
  let stateBroadcasts = 0;
  app.broadcast = (event) => { events.push(event); };
  app.broadcastAll = () => { stateBroadcasts += 1; };
  app.sendPrompt = async (queueItem) => {
    assert.equal(queueItem.status, 'next');
    queueItem.status = 'sending';
  };

  await app.runCountdownAndSend(pending);

  assert.equal(stateBroadcasts, 1);
  assert.deepEqual(events, ['output']);
  assert.equal(pending.status, 'sending');
});

test('runCountdownAndSend resets next item when cancelled during countdown', async () => {
  const pending = item('pending');
  const app = makeAppWithQueue([pending], { countdown: 1 });
  const originalAppendOutput = app.appendOutput.bind(app);
  app.appendOutput = (...args) => {
    const result = originalAppendOutput(...args);
    app.countdownCancel = true;
    return result;
  };
  app.sendPrompt = async () => { throw new Error('should not send'); };

  await app.runCountdownAndSend(pending);

  assert.equal(pending.status, 'pending');
});

test('sendPrompt marks successful prompts, waits for completion, and schedules queue continuation', async () => {
  const active = item('active');
  const pending = item('pending');
  const app = makeAppWithQueue([active, pending]);
  app.rpc = { request: async () => ({ turn: { id: 'turn-active' } }) };
  app.waitForTurnCompletion = async () => {};

  await app.sendPrompt(active, { continueQueue: true });

  assert.equal(active.status, 'sent');
  assert.equal(app.app.state, 'watching');
  assert.equal(app.lastScheduledDelay, 1500);
  assert.equal(app.currentItemId, null);
  assert.equal(app.currentTurnId, null);
});

test('sendPrompt passes selected model and effort to turn/start and prints them', async () => {
  const active = item('active');
  const requests = [];
  const app = makeAppWithQueue([active], { model: 'gpt-test', effort: 'high' });
  app.rpc = {
    request: async (method, params) => {
      requests.push({ method, params });
      return { turn: { id: 'turn-active' } };
    },
  };
  app.waitForTurnCompletion = async () => {};

  await app.sendPrompt(active, { continueQueue: false });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'turn/start');
  assert.equal(requests[0].params.model, 'gpt-test');
  assert.equal(requests[0].params.effort, 'high');
  assert.match(app.output.find((entry) => entry.type === 'send').text, /model: gpt-test · effort: high/);
});

test('sendPrompt output shows default model and effort when no override is selected', async () => {
  const active = item('active');
  const app = makeAppWithQueue([active]);
  app.app.defaultModel = 'gpt-default';
  app.rpc = { request: async () => ({ turn: { id: 'turn-active' } }) };
  app.waitForTurnCompletion = async () => {};

  await app.sendPrompt(active, { continueQueue: false });

  assert.match(app.output.find((entry) => entry.type === 'send').text, /model: gpt-default \(default\) · effort: default/);
});

test('sendPrompt pauses manual send after completion without queue continuation', async () => {
  const active = item('active');
  const app = makeAppWithQueue([active]);
  app.rpc = { request: async () => ({ turn: { id: 'turn-active' } }) };
  app.waitForTurnCompletion = async () => {};

  await app.sendPrompt(active, { continueQueue: false });

  assert.equal(app.app.state, 'paused');
  assert.match(app.app.message, /Manual send completed/);
});

test('sendPrompt marks failures before and after turn started with pause messages', async () => {
  const before = item('before');
  const beforeApp = makeAppWithQueue([before]);
  beforeApp.rpc = { request: async () => { throw new Error('start failed'); } };

  await beforeApp.sendPrompt(before, { continueQueue: false });
  assert.equal(before.status, 'failed');
  assert.match(before.error, /start failed/);
  assert.match(beforeApp.app.message, /before confirmation/);

  const after = item('after');
  const afterApp = makeAppWithQueue([after]);
  afterApp.turnStarted = true;
  afterApp.rpc = { request: async () => { afterApp.turnStarted = true; throw new Error('stream failed'); } };

  await afterApp.sendPrompt(after, { continueQueue: false });
  assert.equal(after.status, 'failed');
  assert.match(afterApp.app.message, /Error after turn\/started/);
});
