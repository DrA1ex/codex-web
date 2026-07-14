'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { item, makeAppWithQueue } = require('./helpers');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('sendComposerNow creates a queue item and sends immediately only when idle', async () => {
  const app = makeAppWithQueue([]);
  app.rateLimits = { status: 'available', buckets: [], resetAt: null };
  app.app.state = 'watching';
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

test('sendComposerNow queues without immediate send when queue is paused', async () => {
  const app = makeAppWithQueue([]);
  app.rateLimits = { status: 'available', buckets: [], resetAt: null };
  app.app.state = 'paused';
  app.sendPrompt = async () => { throw new Error('should not send while paused'); };

  const result = await app.sendComposerNow('hold in queue');

  assert.equal(result.ok, true);
  assert.equal(result.clearComposer, true);
  assert.deepEqual(app.queue.map((i) => i.text), ['hold in queue']);
  assert.equal(app.lastScheduledDelay, 200);
  assert.equal(app.app.state, 'paused');
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

test('sendComposerNow queues normal text when a sent queue item is active but current ids are missing', async () => {
  const active = item('active', 'sent');
  const app = makeAppWithQueue([active]);
  app.rateLimits = { status: 'available', buckets: [], resetAt: null };
  app.app.state = 'watching';
  app.sendPrompt = async () => { throw new Error('should not start a second turn'); };
  app.rpc = { request: async (method) => { throw new Error(`should not call ${method}`); } };

  const result = await app.sendComposerNow('normal follow-up text');

  assert.equal(result.ok, true);
  assert.equal(result.clearComposer, true);
  assert.deepEqual(app.queue.map((queueItem) => [queueItem.id, queueItem.status, queueItem.text]), [
    ['active', 'sent', 'Prompt active'],
    [result.item.id, 'pending', 'normal follow-up text'],
  ]);
  assert.equal(app.lastScheduledDelay, 200);
  assert.equal(app.output.some((entry) => entry.type === 'user-note'), false);
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

test('sendComposerNow queues compact command instead of executing it immediately', async () => {
  const app = makeAppWithQueue([]);
  app.rateLimits = { status: 'available', buckets: [], resetAt: null };
  app.app.state = 'watching';
  app.executeCommand = async () => { throw new Error('should not execute queued command immediately'); };

  const result = await app.sendComposerNow('/compact');

  assert.equal(result.ok, true);
  assert.equal(result.clearComposer, true);
  assert.equal(result.item.kind, 'command');
  assert.equal(result.item.command, '/compact');
  assert.equal(app.queue.length, 1);
  assert.equal(app.app.state, 'watching');
  assert.equal(app.lastScheduledDelay, 200);
});

test('sendComposerNow steers active turn without changing queue', async () => {
  const active = item('active', 'sent');
  const pending = item('pending');
  const app = makeAppWithQueue([active, pending]);
  const requests = [];
  app.app.state = 'streaming';
  app.currentItemId = 'active';
  app.currentTurnId = 'turn-active';
  app.createOutputGroupForItem(active);
  app.rpc = { request: async (...args) => { requests.push(args); return {}; } };

  const result = await app.sendComposerNow('/think focus on the queue-state bug');

  assert.deepEqual(result, { ok: true, clearComposer: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0], 'turn/steer');
  assert.equal(requests[0][1].threadId, app.app.sessionId);
  assert.equal(requests[0][1].expectedTurnId, 'turn-active');
  assert.deepEqual(requests[0][1].input, [{ type: 'text', text: 'focus on the queue-state bug' }]);
  assert.match(requests[0][1].clientUserMessageId, /^codex-queue-steer-/);
  assert.equal(requests[0][2], 3000);
  assert.deepEqual(app.queue.map((queueItem) => [queueItem.id, queueItem.status]), [
    ['active', 'sent'],
    ['pending', 'pending'],
  ]);
  const note = app.output.find((entry) => entry.type === 'user-note');
  assert.match(note?.text || '', /focus on the queue-state bug/);
  assert.match(note?.text || '', /Status: (waiting to send|accepted by app-server)/);
  assert.equal(note?.steer?.clientUserMessageId, requests[0][1].clientUserMessageId);
  assert.equal(note?.groupId, app.currentOutputGroupId);
});

test('sendComposerNow creates waiting steer note and undo action before rpc resolves', async () => {
  const active = item('active', 'sent');
  const app = makeAppWithQueue([active]);
  const steer = deferred();
  app.app.state = 'streaming';
  app.currentItemId = 'active';
  app.currentTurnId = 'turn-active';
  app.createOutputGroupForItem(active);
  app.rpc = { request: async () => await steer.promise };

  const result = await app.sendComposerNow('/think stay on backend first');

  assert.deepEqual(result, { ok: true, clearComposer: true });
  const note = app.output.find((entry) => entry.type === 'user-note');
  assert.match(note?.text || '', /Status: waiting to send/);
  assert.equal(note?.steer?.status, 'waiting');
  assert.equal(app.undoActions.length, 1);
  assert.equal(app.undoActions[0].type, 'steer');
  assert.equal(app.undoActions[0].status, 'waiting');
  assert.match(app.undoActions[0].clientUserMessageId, /^codex-queue-steer-/);
});

test('accepted steer is submitted when app-server starts matching userMessage item', async () => {
  const active = item('active', 'sent');
  const app = makeAppWithQueue([active]);
  app.app.state = 'streaming';
  app.currentItemId = 'active';
  app.currentTurnId = 'turn-active';
  app.createOutputGroupForItem(active);
  app.rpc = { request: async () => ({}) };

  await app.sendComposerNow('/think wait until tool finishes');
  await Promise.resolve();

  const action = app.undoActions[0];
  assert.equal(action.status, 'accepted');
  app.handleNotification('item/started', {
    item: {
      type: 'userMessage',
      clientId: action.clientUserMessageId,
      content: [{ type: 'text', text: 'wait until tool finishes' }],
    },
  });

  const note = app.output.find((entry) => entry.type === 'user-note');
  assert.equal(action.status, 'submitted');
  assert.equal(note?.steer?.status, 'submitted');
  assert.match(note?.text || '', /Status: submitted to turn/);
  assert.equal(app.undoActions.length, 0);
});

test('submitted steer is not downgraded by a late steer rpc ack', async () => {
  const active = item('active', 'sent');
  const app = makeAppWithQueue([active]);
  const steer = deferred();
  app.app.state = 'streaming';
  app.currentItemId = 'active';
  app.currentTurnId = 'turn-active';
  app.createOutputGroupForItem(active);
  app.rpc = { request: async () => await steer.promise };

  await app.sendComposerNow('/think submit before ack');
  const action = app.undoActions[0];
  app.handleNotification('item/started', {
    item: {
      type: 'userMessage',
      clientId: action.clientUserMessageId,
      content: [{ type: 'text', text: 'submit before ack' }],
    },
  });

  steer.resolve({});
  await Promise.resolve();

  const note = app.output.find((entry) => entry.type === 'user-note');
  assert.equal(action.status, 'submitted');
  assert.equal(note?.steer?.status, 'submitted');
});

test('/undo cancels an unsent steer and leaves late rpc success ignored', async () => {
  const active = item('active', 'sent');
  const app = makeAppWithQueue([active]);
  const steer = deferred();
  app.app.state = 'streaming';
  app.currentItemId = 'active';
  app.currentTurnId = 'turn-active';
  app.createOutputGroupForItem(active);
  app.rpc = { request: async () => await steer.promise };

  await app.sendComposerNow('/think cancel me');
  const action = app.undoActions[0];
  const undo = await app.undoLast();

  assert.equal(undo.ok, true);
  assert.equal(undo.clearComposer, true);
  assert.equal(action.status, 'canceled');
  assert.equal(app.undoActions.length, 0);
  assert.match(app.output.find((entry) => entry.type === 'user-note')?.text || '', /Status: canceled/);
  assert.match(app.output.at(-1)?.command?.message || '', /Steer canceled/);

  steer.resolve({});
  await Promise.resolve();
  assert.match(app.output.find((entry) => entry.type === 'user-note')?.text || '', /Status: canceled/);
});

test('/think! without text promotes a waiting steer into interrupt follow-up', async () => {
  const active = item('active', 'sent');
  const app = makeAppWithQueue([active]);
  const steer = deferred();
  const requests = [];
  app.rateLimits = { status: 'available', buckets: [], resetAt: null };
  app.app.state = 'streaming';
  app.currentItemId = 'active';
  app.currentTurnId = 'turn-a';
  app.createOutputGroupForItem(active);
  app.rpc = {
    request: async (method, params, timeout) => {
      requests.push([method, params, timeout]);
      if (method === 'turn/steer') return await steer.promise;
      if (method === 'turn/start') return { turn: { id: 'turn-b' } };
      return {};
    },
  };

  await app.sendComposerNow('/think use the backend state first');
  const action = app.undoActions[0];
  const result = await app.sendComposerNow('/think!');

  assert.deepEqual(result, { ok: true, clearComposer: true });
  assert.equal(action.status, 'promoted');
  assert.equal(app.undoActions.length, 0);
  assert.deepEqual(requests.map(([method]) => method), ['turn/steer', 'turn/interrupt', 'turn/start']);
  assert.equal(requests[1][1].turnId, 'turn-a');
  assert.equal(requests[2][1].input[0].text, 'use the backend state first');
  assert.match(app.output.find((entry) => entry.type === 'user-note')?.text || '', /Status: force requested/);

  steer.resolve({});
  await Promise.resolve();
  assert.match(app.output.find((entry) => entry.type === 'user-note')?.text || '', /Status: force requested/);
});

test('/think! without text rejects a steer that was already accepted', async () => {
  const active = item('active', 'sent');
  const app = makeAppWithQueue([active]);
  const requests = [];
  app.rateLimits = { status: 'available', buckets: [], resetAt: null };
  app.app.state = 'streaming';
  app.currentItemId = 'active';
  app.currentTurnId = 'turn-active';
  app.createOutputGroupForItem(active);
  app.rpc = { request: async (...args) => { requests.push(args); return {}; } };

  await app.sendComposerNow('/think already accepted steer');
  await Promise.resolve();
  const result = await app.sendComposerNow('/think!');

  assert.equal(result.ok, false);
  assert.equal(result.commandError, true);
  assert.match(result.message, /already accepted/);
  assert.deepEqual(requests.map(([method]) => method), ['turn/steer']);
  assert.equal(app.undoActions[0].status, 'accepted');
});

test('/think! without text does not consume pending undo actions', async () => {
  const active = item('active', 'sent');
  const pending = item('pending');
  const app = makeAppWithQueue([active, pending]);
  const steer = deferred();
  const requests = [];
  app.rateLimits = { status: 'available', buckets: [], resetAt: null };
  app.app.state = 'streaming';
  app.currentItemId = 'active';
  app.currentTurnId = 'turn-active';
  app.createOutputGroupForItem(active);
  app.rpc = {
    request: async (method, params, timeout) => {
      requests.push([method, params, timeout]);
      if (method === 'turn/steer') return await steer.promise;
      return {};
    },
  };

  await app.sendComposerNow('/think keep waiting');
  app.recordPendingUndo(pending);
  const result = await app.sendComposerNow('/think!');

  assert.equal(result.ok, false);
  assert.equal(result.commandError, true);
  assert.match(result.message, /No waiting steer/);
  assert.deepEqual(requests.map(([method]) => method), ['turn/steer']);
  assert.deepEqual(app.queue.map((queueItem) => queueItem.id), ['active', 'pending']);
  assert.deepEqual(app.undoActions.map((action) => action.type), ['steer', 'pending']);
});

test('/think! without text keeps waiting steer until risky interrupt is confirmed', async () => {
  const active = item('active', 'sent');
  const app = makeAppWithQueue([active]);
  const steer = deferred();
  const requests = [];
  app.rateLimits = { status: 'limited', buckets: [], resetAt: null };
  app.app.state = 'streaming';
  app.currentItemId = 'active';
  app.currentTurnId = 'turn-active';
  app.currentTurnResolve = () => {};
  app.createOutputGroupForItem(active);
  app.rpc = {
    request: async (method, params, timeout) => {
      requests.push([method, params, timeout]);
      if (method === 'turn/steer') return await steer.promise;
      return {};
    },
  };

  await app.sendComposerNow('/think wait for confirmation');
  const action = app.undoActions[0];
  const prompt = await app.sendComposerNow('/think!');

  assert.equal(prompt.ok, false);
  assert.equal(prompt.needsConfirmation, true);
  assert.equal(prompt.promoteSteerActionId, action.id);
  assert.equal(action.status, 'waiting');
  assert.equal(app.undoActions.length, 1);
  assert.deepEqual(requests.map(([method]) => method), ['turn/steer']);

  const confirmed = await app.forceSteerActivePrompt(prompt.text, { confirmed: true, promoteSteerActionId: prompt.promoteSteerActionId });

  assert.equal(confirmed.ok, true);
  assert.equal(action.status, 'promoted');
  assert.equal(app.undoActions.length, 0);
  assert.deepEqual(requests.map(([method]) => method), ['turn/steer', 'turn/interrupt']);
  assert.equal(app.queue.at(-1).text, 'wait for confirmation');
  assert.equal(app.queue.at(-1).status, 'pending');
});

test('/think! confirmation refuses to promote a steer that was accepted meanwhile', async () => {
  const active = item('active', 'sent');
  const app = makeAppWithQueue([active]);
  const steer = deferred();
  const requests = [];
  app.rateLimits = { status: 'limited', buckets: [], resetAt: null };
  app.app.state = 'streaming';
  app.currentItemId = 'active';
  app.currentTurnId = 'turn-active';
  app.createOutputGroupForItem(active);
  app.rpc = {
    request: async (method, params, timeout) => {
      requests.push([method, params, timeout]);
      if (method === 'turn/steer') return await steer.promise;
      return {};
    },
  };

  await app.sendComposerNow('/think wait but maybe send');
  const action = app.undoActions[0];
  const prompt = await app.sendComposerNow('/think!');
  action.status = 'accepted';
  action.acceptedAt = new Date().toISOString();

  const confirmed = await app.forceSteerActivePrompt(prompt.text, { confirmed: true, promoteSteerActionId: prompt.promoteSteerActionId });

  assert.equal(confirmed.ok, false);
  assert.match(confirmed.message, /already accepted/);
  assert.deepEqual(requests.map(([method]) => method), ['turn/steer']);
  assert.equal(active.status, 'sent');
});

test('sendComposerNow rejects steering when there is no active turn', async () => {
  const app = makeAppWithQueue([]);
  app.rpc = { request: async () => { throw new Error('should not send'); } };

  const result = await app.sendComposerNow('/think note');

  assert.equal(result.ok, false);
  assert.equal(result.commandError, true);
  assert.match(result.message, /No active turn/);
  assert.equal(app.queue.length, 0);
  const command = app.output.at(-1);
  assert.equal(command.type, 'command');
  assert.equal(command.command.status, 'error');
  assert.equal(command.command.raw, '/think note');
  assert.match(command.command.message, /No active turn/);
});

test('sendComposerNow keeps not-steerable note visible without failing active item', async () => {
  const active = item('active', 'sent');
  const app = makeAppWithQueue([active]);
  const err = new Error('turn is not steerable right now');
  err.code = 'activeTurnNotSteerable';
  app.app.state = 'streaming';
  app.currentItemId = 'active';
  app.currentTurnId = 'turn-active';
  app.createOutputGroupForItem(active);
  app.rpc = { request: async () => { throw err; } };

  const result = await app.sendComposerNow('/think wait for tool result');
  await Promise.resolve();

  assert.equal(result.ok, true);
  assert.equal(active.status, 'sent');
  assert.equal(app.app.state, 'streaming');
  const note = app.output.find((entry) => entry.type === 'user-note');
  assert.match(note?.text || '', /Status: not steerable/);
  assert.equal(note?.steer?.forceAvailable, true);
  assert.equal(app.undoActions.length, 0);
});

test('force steering requires confirmation when limits are unavailable', async () => {
  const active = item('active', 'sent');
  const app = makeAppWithQueue([active]);
  app.rateLimits = { status: 'limited', buckets: [], resetAt: null };
  app.app.state = 'streaming';
  app.currentItemId = 'active';
  app.currentTurnId = 'turn-active';
  app.rpc = { request: async () => { throw new Error('should not interrupt before confirmation'); } };

  const result = await app.sendComposerNow('/think! force correction');

  assert.equal(result.ok, false);
  assert.equal(result.needsConfirmation, true);
  assert.equal(result.confirmAction, 'force-steer');
  assert.equal(active.status, 'sent');
  assert.equal(app.currentTurnId, 'turn-active');
});

test('confirmed force steering with unavailable limits marks active item interrupted and queues correction', async () => {
  const active = item('active', 'sent');
  const app = makeAppWithQueue([active]);
  const requests = [];
  let resolved = false;
  app.rateLimits = { status: 'limited', buckets: [], resetAt: null };
  app.app.state = 'streaming';
  app.currentItemId = 'active';
  app.currentTurnId = 'turn-active';
  app.currentTurnResolve = () => { resolved = true; };
  app.rpc = { request: async (...args) => { requests.push(args); return {}; } };

  const result = await app.forceSteerActivePrompt('queued correction', { confirmed: true });
  app.handleNotification('turn/failed', { turn: { id: 'turn-active', status: 'failed', error: { message: 'interrupted' } } });

  assert.equal(result.ok, true);
  assert.equal(active.status, 'interrupted');
  assert.equal(active.error, null);
  assert.equal(app.queue.at(-1).text, 'queued correction');
  assert.equal(app.queue.at(-1).status, 'pending');
  assert.equal(resolved, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0], 'turn/interrupt');
  assert.ok(app.output.some((entry) => /\[steer] Original turn interrupted/.test(entry.text)));
});

test('force steering attaches replacement turn to the same queue item', async () => {
  const active = item('active', 'sent');
  const app = makeAppWithQueue([active]);
  const requests = [];
  app.rateLimits = { status: 'available', buckets: [], resetAt: null };
  app.app.state = 'streaming';
  app.currentItemId = 'active';
  app.currentTurnId = 'turn-a';
  app.createOutputGroupForItem(active);
  app.rpc = {
    request: async (method, params, timeout) => {
      requests.push([method, params, timeout]);
      if (method === 'turn/start') return { turn: { id: 'turn-b' } };
      return {};
    },
  };

  const result = await app.sendComposerNow('/think! replacement correction');
  app.handleNotification('turn/failed', { turn: { id: 'turn-a', status: 'failed', error: { message: 'interrupted' } } });
  app.handleNotification('turn/completed', { turn: { id: 'turn-b', status: 'completed' } });

  assert.deepEqual(result, { ok: true, clearComposer: true });
  assert.equal(active.status, 'completed');
  assert.equal(active.usage?.turnId, 'turn-b');
  assert.equal(app.currentTurnId, 'turn-b');
  assert.equal(app.app.state, 'streaming');
  assert.equal(requests[0][0], 'turn/interrupt');
  assert.equal(requests[1][0], 'turn/start');
  assert.equal(requests[1][1].input[0].text, 'replacement correction');
  assert.ok(app.output.some((entry) => /\[steer] Follow-up prompt sent/.test(entry.text)));
});

test('force steering keeps replacement output in the original output group when interrupt event has no turn id', async () => {
  const active = item('active', 'sent');
  const app = makeAppWithQueue([active]);
  app.rateLimits = { status: 'available', buckets: [], resetAt: null };
  app.app.state = 'streaming';
  app.currentItemId = 'active';
  app.currentTurnId = 'turn-a';
  const group = app.createOutputGroupForItem(active);
  app.rpc = {
    request: async (method) => {
      if (method === 'turn/start') return { turn: { id: 'turn-b' } };
      return {};
    },
  };

  await app.sendComposerNow('/think! replacement correction');
  app.handleNotification('turn/failed', { turn: { status: 'failed', error: { message: 'interrupted' } } });
  app.handleNotification('item/started', { item: { type: 'agentMessage', text: 'working after replacement' } });
  app.handleNotification('turn/completed', { turn: { id: 'turn-b', status: 'completed' } });

  assert.equal(active.status, 'completed');
  assert.equal(app.outputGroups[0].id, group.id);
  assert.equal(app.outputGroups[0].status, 'completed');
  assert.deepEqual(app.outputGroups[0].turnIds, ['turn-a', 'turn-b']);
  assert.ok(app.output.every((entry) => entry.groupId === group.id));
  assert.ok(app.output.some((entry) => /Original turn interrupted/.test(entry.text)));
});

test('force steering ignores completed original turn and waits for replacement completion', async () => {
  const active = item('active', 'sent');
  const app = makeAppWithQueue([active]);
  app.rateLimits = { status: 'available', buckets: [], resetAt: null };
  app.app.state = 'streaming';
  app.currentItemId = 'active';
  app.currentTurnId = 'turn-a';
  const group = app.createOutputGroupForItem(active);
  app.rpc = {
    request: async (method) => {
      if (method === 'turn/start') return { turn: { id: 'turn-b' } };
      return {};
    },
  };

  await app.sendComposerNow('/think! replacement correction');
  app.handleNotification('turn/completed', { turn: { id: 'turn-a', status: 'completed' } });

  assert.equal(active.status, 'sent');
  assert.equal(app.currentTurnId, 'turn-b');
  assert.equal(app.outputGroups[0].id, group.id);
  assert.equal(app.outputGroups[0].status, 'active');

  app.handleNotification('item/started', { item: { type: 'agentMessage', text: 'working after replacement' } });
  app.handleNotification('turn/completed', { turn: { id: 'turn-b', status: 'completed' } });

  assert.equal(active.status, 'completed');
  assert.equal(app.outputGroups[0].status, 'completed');
  assert.deepEqual(app.outputGroups[0].turnIds, ['turn-a', 'turn-b']);
  assert.ok(app.output.every((entry) => entry.groupId === group.id));
});

test('force steering can chain multiple replacements in the same output group', async () => {
  const active = item('active', 'sent');
  const app = makeAppWithQueue([active]);
  const replacementIds = ['turn-b', 'turn-c'];
  app.rateLimits = { status: 'available', buckets: [], resetAt: null };
  app.app.state = 'streaming';
  app.currentItemId = 'active';
  app.currentTurnId = 'turn-a';
  const group = app.createOutputGroupForItem(active);
  app.rpc = {
    request: async (method) => {
      if (method === 'turn/start') return { turn: { id: replacementIds.shift() } };
      return {};
    },
  };

  await app.sendComposerNow('/think! first correction');
  app.handleNotification('turn/completed', { turn: { id: 'turn-a', status: 'completed' } });
  assert.equal(active.status, 'sent');
  assert.equal(app.currentTurnId, 'turn-b');

  await app.sendComposerNow('/think! second correction');
  app.handleNotification('turn/completed', { turn: { id: 'turn-b', status: 'completed' } });
  app.handleNotification('item/started', { item: { type: 'agentMessage', text: 'working after second replacement' } });
  app.handleNotification('turn/completed', { turn: { id: 'turn-c', status: 'completed' } });

  assert.equal(active.status, 'completed');
  assert.equal(app.outputGroups[0].id, group.id);
  assert.equal(app.outputGroups[0].status, 'completed');
  assert.deepEqual(app.outputGroups[0].turnIds, ['turn-a', 'turn-b', 'turn-c']);
  assert.ok(app.output.every((entry) => entry.groupId === group.id));
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
  assert.deepEqual(events, ['outputPatch']);
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

test('queued compact command waits for app-server compaction completion', async () => {
  const compact = item('compact', 'pending', { text: '/compact' });
  const next = item('next');
  const app = makeAppWithQueue([compact, next]);
  const requests = [];
  let limitReads = 0;
  let threadReads = 0;
  app.rpc = {
    request: async (method, params) => {
      requests.push({ method, params });
      if (method === 'account/rateLimits/read') {
        limitReads += 1;
        return {
          rateLimits: {
            limitId: 'codex',
            limitName: 'codex',
            primary: { usedPercent: limitReads === 1 ? 12 : 13, windowDurationMins: 300 },
          },
        };
      }
      if (method === 'thread/read') {
        threadReads += 1;
        return { thread: { contextTokenCount: threadReads === 1 ? 12000 : 4200 } };
      }
      if (method === 'thread/compact/start') {
        app.handleNotification('thread/compacted', { threadId: app.app.sessionId, turnId: 'compact-turn' });
      }
      return {};
    },
  };

  await app.runCountdownAndSend(compact, { continueQueue: true });

  assert.deepEqual(requests.map((request) => request.method), [
    'account/rateLimits/read',
    'thread/read',
    'thread/compact/start',
    'thread/read',
    'account/rateLimits/read',
  ]);
  assert.equal(compact.kind, 'command');
  assert.equal(compact.status, 'completed');
  assert.match(app.output.find((entry) => /\[compact] completed/.test(entry.text))?.text || '', /completed/);
  const usageOutput = app.output.find((entry) => /\[compact usage]/.test(entry.text))?.text || '';
  assert.match(usageOutput, /tokens: 12,000 -> 4,200 \(-7,800\)/);
  assert.match(usageOutput, /codex 5h: 12% -> 13% \(\+1%\)/);
  assert.equal(compact.usage.compactTokensBefore, 12000);
  assert.equal(compact.usage.compactTokensAfter, 4200);
  assert.equal(app.app.state, 'watching');
  assert.equal(app.lastScheduledDelay, 200);
});

test('queued compact command completes when app-server reports a compact turn completion', async () => {
  const compact = item('compact', 'pending', { text: '/compact' });
  const next = item('next');
  const app = makeAppWithQueue([compact, next]);
  const requests = [];
  app.rpc = {
    request: async (method, params) => {
      requests.push({ method, params });
      if (method === 'account/rateLimits/read') {
        return { rateLimits: { limitId: 'codex', limitName: 'codex', primary: { usedPercent: 10, windowDurationMins: 300 } } };
      }
      if (method === 'thread/read') {
        return { thread: { contextTokenCount: 5000 } };
      }
      if (method === 'thread/compact/start') {
        app.handleNotification('turn/started', { turn: { id: 'compact-turn' } });
        app.handleNotification('turn/completed', { turn: { id: 'compact-turn', status: 'completed' } });
      }
      return {};
    },
  };

  await app.runCountdownAndSend(compact, { continueQueue: true });

  assert.equal(compact.status, 'completed');
  assert.equal(app.currentItemId, null);
  assert.equal(app.currentTurnId, null);
  assert.equal(app.snapshot().app.canInterrupt, false);
  assert.equal(app.app.state, 'watching');
  assert.equal(app.lastScheduledDelay, 200);
  assert.match(app.output.find((entry) => /\[command] \/compact completed/.test(entry.text))?.text || '', /completed/);
});

test('queued command failure pauses queue and marks item failed', async () => {
  const compact = item('compact', 'pending', { text: '/compact' });
  const app = makeAppWithQueue([compact]);
  app.rpc = { request: async () => { throw new Error('compact unavailable'); } };

  await app.runCountdownAndSend(compact, { continueQueue: true });

  assert.equal(compact.status, 'failed');
  assert.equal(compact.error, 'compact unavailable');
  assert.equal(app.app.state, 'paused');
  assert.match(app.output.at(-1).text, /queued command failure/);
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

  const turnStart = requests.find((request) => request.method === 'turn/start');
  assert.ok(turnStart);
  assert.equal(turnStart.params.model, 'gpt-test');
  assert.equal(turnStart.params.effort, 'high');
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

test('sendPrompt creates and completes an output group with turn metadata', async () => {
  const active = item('active');
  const app = makeAppWithQueue([active], { model: 'gpt-test', effort: 'medium' });
  app.rpc = { request: async () => ({ turn: { id: 'turn-active' } }) };
  app.waitForTurnCompletion = async () => {
    app.handleNotification('turn/started', { turn: { id: 'turn-active' } });
    app.handleNotification('turn/delta', { delta: 'Prompt work finished.' });
    app.handleNotification('turn/completed', { turn: { id: 'turn-active', status: 'completed' } });
  };
  app.tryReadSession = async () => {};

  await app.sendPrompt(active, { continueQueue: false });

  assert.equal(app.outputGroups.length, 1);
  assert.equal(app.outputGroups[0].queueItemId, 'active');
  assert.equal(app.outputGroups[0].turnId, 'turn-active');
  assert.equal(app.outputGroups[0].status, 'completed');
  assert.equal(app.outputGroups[0].summary, 'Prompt work finished.');
  assert.ok(app.output.every((entry) => entry.groupId === app.outputGroups[0].id));
  assert.equal(app.currentOutputGroupId, null);
});

test('sendPrompt stores token usage and account-level limit deltas', async () => {
  const active = item('active');
  const app = makeAppWithQueue([active]);
  let limitReads = 0;
  app.rpc = {
    request: async (method) => {
      if (method === 'account/rateLimits/read') {
        limitReads += 1;
        return {
          rateLimits: {
            limitId: 'codex',
            limitName: 'codex',
            primary: { usedPercent: limitReads === 1 ? 10 : 14, windowDurationMins: 300 },
          },
        };
      }
      if (method === 'turn/start') return { turn: { id: 'turn-active' } };
      return {};
    },
  };
  app.waitForTurnCompletion = async () => {
    app.handleNotification('thread/tokenUsage/updated', {
      threadId: app.app.sessionId,
      turnId: 'turn-active',
      tokenUsage: { last: { inputTokens: 10, cachedInputTokens: 4, outputTokens: 6, reasoningOutputTokens: 2, totalTokens: 18 } },
    });
    app.handleNotification('turn/completed', { turn: { id: 'turn-active', status: 'completed' } });
  };
  app.tryReadSession = async () => {};
  app.scheduleQueueItemUsageRefresh = (id) => { app.pendingUsageRefreshItemId = id; };

  await app.sendPrompt(active, { continueQueue: false });

  assert.equal(active.status, 'completed');
  assert.equal(active.usage.threadId, app.app.sessionId);
  assert.equal(active.usage.turnId, 'turn-active');
  assert.equal(active.usage.tokenUsage.totalTokens, 18);
  assert.deepEqual(active.usage.limitDeltas.map((delta) => [delta.window, delta.usedPercent]), [['5h', 4]]);
  assert.equal(active.usage.limitDeltaScope, 'account');
  assert.equal(active.usage.refreshPending, true);
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
