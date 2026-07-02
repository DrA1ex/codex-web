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
