'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { JsonRpcClient } = require('../src/codex/json-rpc-client');

test('JsonRpcClient writes requests, notifications, and responses', async () => {
  const written = [];
  const client = new JsonRpcClient({
    opts: {},
    jsonRpcLogPath: null,
    debug: {},
    handleNotification() {},
    handleServerRequest() {},
    debugLog() {},
  });
  client.proc = { stdin: { writable: true, write: (line) => { written.push(JSON.parse(line)); } } };

  const requestPromise = client.request('method/read', { value: 1 });
  assert.deepEqual(written[0], { method: 'method/read', id: 1, params: { value: 1 } });
  client.handleLine(JSON.stringify({ id: 1, result: { ok: true } }));
  assert.deepEqual(await requestPromise, { ok: true });

  client.notify('event/name', { x: 1 });
  client.respond(2, { ok: false });
  client.respond(3, { code: -1 }, true);
  assert.deepEqual(written.slice(1), [
    { method: 'event/name', params: { x: 1 } },
    { id: 2, result: { ok: false } },
    { id: 3, error: { code: -1 } },
  ]);
});

test('JsonRpcClient rejects errors, handles notifications/server requests, and ignores malformed lines', async () => {
  const notifications = [];
  const serverRequests = [];
  const debugLogs = [];
  const app = {
    opts: {},
    jsonRpcLogPath: null,
    debug: {},
    handleNotification: (method, params) => { notifications.push({ method, params }); },
    handleServerRequest: async (msg) => { serverRequests.push(msg); },
    debugLog: (...args) => { debugLogs.push(args); },
  };
  const client = new JsonRpcClient(app);
  const written = [];
  client.proc = { stdin: { writable: true, write: (line) => { written.push(JSON.parse(line)); } } };

  const failed = client.request('bad/method');
  client.handleLine(JSON.stringify({ id: 1, error: { code: 123, message: 'bad', data: { reason: 'x' } } }));
  await assert.rejects(failed, (err) => {
    assert.equal(err.message, 'bad');
    assert.equal(err.code, 123);
    assert.deepEqual(err.data, { reason: 'x' });
    return true;
  });
  assert.deepEqual(app.debug.lastJsonRpcError, { code: 123, message: 'bad', data: { reason: 'x' } });

  client.handleLine('{bad json');
  assert.equal(debugLogs.at(-1)[0], 'jsonrpc parse error');

  client.handleLine(JSON.stringify({ method: 'notify/event', params: { ok: true } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notifications, [{ method: 'notify/event', params: { ok: true } }]);

  client.handleLine(JSON.stringify({ id: 5, method: 'server/request', params: { a: 1 } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(serverRequests.length, 1);

  client.handleLine(JSON.stringify({ id: 999, result: {} }));
  assert.equal(debugLogs.at(-1)[0], 'orphan rpc response');
});

test('JsonRpcClient request rejects when app-server is not running', async () => {
  const client = new JsonRpcClient({ opts: {}, debug: {}, debugLog() {} });
  await assert.rejects(() => client.request('method'), /app-server is not running/);
});

test('JsonRpcClient registers pending request before a synchronous response can arrive', async () => {
  const debugLogs = [];
  const client = new JsonRpcClient({
    opts: {},
    jsonRpcLogPath: null,
    debug: {},
    debugLog: (...args) => debugLogs.push(args),
  });
  client.proc = {
    stdin: {
      writable: true,
      write(line) {
        const request = JSON.parse(line);
        client.handleLine(JSON.stringify({ id: request.id, result: { immediate: true } }));
        return true;
      },
    },
  };

  assert.deepEqual(await client.request('immediate/read'), { immediate: true });
  assert.equal(client.pending.size, 0);
  assert.equal(debugLogs.some(([message]) => message === 'orphan rpc response'), false);
});

test('JsonRpcClient removes pending requests when stdin write fails', async () => {
  const client = new JsonRpcClient({ opts: {}, jsonRpcLogPath: null, debug: {}, debugLog() {} });
  client.proc = {
    stdin: {
      writable: true,
      write() { throw new Error('broken pipe'); },
    },
  };

  await assert.rejects(client.request('write/fails', {}, 1000), /broken pipe/);
  assert.equal(client.pending.size, 0);

  client.proc.stdin.write = (_line, callback) => {
    setImmediate(() => callback(new Error('async write failed')));
    return true;
  };
  await assert.rejects(client.request('write/fails-async', {}, 1000), /async write failed/);
  assert.equal(client.pending.size, 0);
});

test('JsonRpcClient contains synchronous server and notification handler failures', async () => {
  const written = [];
  const errors = [];
  const client = new JsonRpcClient({
    opts: {},
    jsonRpcLogPath: null,
    debug: {},
    debugLog() {},
    setError: (message) => errors.push(message),
    handleServerRequest() { throw new Error('server handler failed'); },
    handleNotification() { throw new Error('notification failed'); },
  });
  client.proc = {
    stdin: {
      writable: true,
      write: (line) => { written.push(JSON.parse(line)); return true; },
    },
  };

  client.handleLine(JSON.stringify({ id: 99, method: 'server/request' }));
  client.handleLine(JSON.stringify({ method: 'notify/request' }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(written, [{
    id: 99,
    error: { code: -32603, message: 'server handler failed' },
  }]);
  assert.match(errors[0], /notify\/request/);
  assert.match(errors[0], /notification failed/);
});

test('JsonRpcClient start rejects immediately when child exits before spawn', async () => {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const exits = [];
  const app = {
    opts: { codexBin: 'codex', projectDir: process.cwd(), debug: false },
    debug: {},
    shuttingDown: false,
    debugLog() {},
    handleRpcExit: async (err) => exits.push(err),
    setError() {},
  };
  const client = new JsonRpcClient(app, { spawn: () => child });

  const starting = client.start();
  child.emit('exit', 7, null);

  await assert.rejects(starting, /exited: code=7/);
  assert.equal(client.exited, true);
  assert.equal(client.started, false);
  assert.deepEqual(exits, []);
});

test('JsonRpcClient child exit rejects pending work and blocks requests after exit', async () => {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const exits = [];
  const app = {
    opts: { codexBin: 'codex', projectDir: process.cwd(), debug: false },
    debug: {},
    shuttingDown: false,
    debugLog() {},
    handleRpcExit: async (err) => exits.push(err),
    setError() {},
  };
  const client = new JsonRpcClient(app, { spawn: () => child });

  const starting = client.start();
  child.emit('spawn');
  await starting;
  const pending = client.request('slow/request', {}, 10_000);
  child.emit('exit', 1, 'SIGTERM');

  await assert.rejects(pending, /exited before response/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(exits.length, 1);
  assert.equal(exits[0].code, 'APP_SERVER_EXITED');
  await assert.rejects(() => client.request('after/exit'), /not running/);
  assert.throws(() => client.notify('after/exit'), /not running/);
});

test('JsonRpcClient stop escalates from stdin close to TERM and KILL without real delays', async () => {
  const kills = [];
  const sleeps = [];
  const client = new JsonRpcClient({ opts: {}, debug: {}, debugLog() {} }, {
    sleep: async (ms) => { sleeps.push(ms); },
    kill: (pid, signal) => { kills.push([pid, signal]); },
  });
  let ended = false;
  let readlineClosed = false;
  client.proc = {
    pid: 12345,
    stdin: { writable: true, end: () => { ended = true; } },
    kill: (signal) => { kills.push(['child', signal]); },
  };
  client.rl = { close: () => { readlineClosed = true; } };

  await client.stop();

  assert.equal(ended, true);
  assert.equal(readlineClosed, true);
  assert.deepEqual(sleeps, [100, 500]);
  if (process.platform === 'win32') {
    assert.deepEqual(kills, [['child', 'SIGTERM'], ['child', 'SIGKILL']]);
  } else {
    assert.deepEqual(kills, [[-12345, 'SIGTERM'], [-12345, 'SIGKILL']]);
  }
});
