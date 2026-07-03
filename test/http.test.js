'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');

const { renderAuthErrorPage } = require('../src/http/auth-page');
const { rawPathname, staticAssetName, staticContentType } = require('../src/http/static-assets');
const { sendText, sendJson, readJsonBody } = require('../src/http/utils');
const { resolveApiRoute } = require('../src/http/api-routes');
const { item, makeAppWithQueue, mockResponse } = require('./helpers');

test('static asset helpers accept safe root/src assets and reject traversal', () => {
  assert.equal(rawPathname('/src/app.js?token=secret#hash'), '/src/app.js');
  assert.equal(staticAssetName('/app.js'), 'app.js');
  assert.equal(staticAssetName('/styles.css'), 'styles.css');
  assert.equal(staticAssetName('/src/ui/button.svg'), 'src/ui/button.svg');
  assert.equal(staticAssetName('/src/../secret.js'), null);
  assert.equal(staticAssetName('/src//bad.js'), null);
  assert.equal(staticAssetName('/%E0%A4%A'), null);
  assert.equal(staticContentType('src/ui/app.mjs'), 'text/javascript; charset=utf-8');
  assert.equal(staticContentType('src/ui/styles.css'), 'text/css; charset=utf-8');
  assert.equal(staticContentType('src/ui/icon.svg'), 'image/svg+xml');
  assert.equal(staticContentType('src/ui/file.unknown'), 'application/octet-stream');
});

test('sendText and sendJson write expected HTTP response metadata', () => {
  const textRes = mockResponse();
  sendText(textRes, 201, 'created', 'text/custom');
  assert.equal(textRes.status, 201);
  assert.equal(textRes.headers['Content-Type'], 'text/custom');
  assert.equal(textRes.body, 'created');

  const jsonRes = mockResponse();
  sendJson(jsonRes, 202, { ok: true });
  assert.equal(jsonRes.status, 202);
  assert.equal(jsonRes.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(jsonRes.body, '{"ok":true}');
});

test('readJsonBody parses empty, valid, invalid, and oversized request bodies', async () => {
  const empty = Readable.from([]);
  assert.deepEqual(await readJsonBody(empty), {});

  const valid = Readable.from(['{"ok":true}']);
  assert.deepEqual(await readJsonBody(valid), { ok: true });

  const invalid = Readable.from(['{bad']);
  await assert.rejects(() => readJsonBody(invalid), /Invalid JSON body/);

  const huge = Readable.from(['x'.repeat(20 * 1024 * 1024 + 1)]);
  huge.destroy = () => {};
  await assert.rejects(() => readJsonBody(huge), /Request body too large/);
});

test('auth error page does not include runtime token placeholders', () => {
  const html = renderAuthErrorPage();
  assert.match(html, /Authorization error/);
  assert.doesNotMatch(html, /__TOKEN__/);
});

test('index requires a valid token and does not leak token on auth error', () => {
  const app = makeAppWithQueue([]);
  app.token = 'secret-token';
  const res = mockResponse();

  app.serveIndex({ headers: {} }, res, new URL('http://localhost/'));

  assert.equal(res.status, 403);
  assert.match(res.body, /Authorization error/);
  assert.doesNotMatch(res.body, /secret-token/);
});

test('snapshot exposes queue controls, sessions, rate limits, and debug summary', () => {
  const app = makeAppWithQueue([item('done', 'completed'), item('pending')]);
  app.app.state = 'watching';
  app.opts.debug = false;
  app.debug.connectedBrowserClients = 2;

  const snap = app.snapshot();

  assert.equal(snap.app.queueCounts.total, 2);
  assert.equal(snap.app.nextPendingId, 'pending');
  assert.equal(snap.app.canPause, true);
  assert.equal(snap.app.canResume, false);
  assert.deepEqual(snap.debug, { connectedBrowserClients: 2 });
});

test('resolveApiRoute dispatches GET/POST handlers and reports 404/405', async () => {
  const app = makeAppWithQueue([item('pending')]);
  app.app.state = 'paused';

  let response = await resolveApiRoute(app, { method: 'GET' }, '/api/state', {});
  assert.equal(response.status, 200);
  assert.equal(response.body.app.sessionId, 'session');

  response = await resolveApiRoute(app, { method: 'GET' }, '/api/missing', {});
  assert.equal(response.status, 404);

  response = await resolveApiRoute(app, { method: 'PUT' }, '/api/state', {});
  assert.equal(response.status, 405);

  response = await resolveApiRoute(app, { method: 'POST' }, '/api/queue/add', { text: 'hello' });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);

  response = await resolveApiRoute(app, { method: 'POST' }, '/api/output/clear', {});
  assert.equal(response.status, 200);
  assert.deepEqual(app.output, []);
});

test('resolveApiRoute exposes rate-limit reset request endpoint', async () => {
  const app = makeAppWithQueue([]);
  app.requestLimitReset = () => ({ ok: true, resetRequest: { requestId: 'request-1' } });

  const response = await resolveApiRoute(app, { method: 'POST' }, '/api/limits/reset-request', {});

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, resetRequest: { requestId: 'request-1' } });
});

test('handleHttp validates tokens, handles API routes, and returns JSON errors', async () => {
  const app = makeAppWithQueue([]);
  app.token = 'token';

  const forbidden = mockResponse();
  await app.handleHttp({ method: 'GET', url: '/api/state', headers: { host: 'localhost' } }, forbidden);
  assert.equal(forbidden.status, 403);

  const ok = mockResponse();
  await app.handleHttp({ method: 'GET', url: '/api/state?token=token', headers: { host: 'localhost' } }, ok);
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).app.sessionId, 'session');

  const missing = mockResponse();
  await app.handleHttp({ method: 'GET', url: '/missing', headers: { host: 'localhost' } }, missing);
  assert.equal(missing.status, 404);

  const broken = mockResponse();
  await app.handleHttp({ method: 'POST', url: '/api/queue/add?token=token', headers: { host: 'localhost' }, on(event, handler) { if (event === 'data') handler('{bad'); if (event === 'end') handler(); } }, broken);
  assert.equal(broken.status, 500);
  assert.match(broken.body, /Invalid JSON body/);
});

test('serveEvents registers SSE clients and removes them on close', () => {
  const app = makeAppWithQueue([]);
  app.token = 'token';
  const req = new EventEmitter();
  req.headers = {};
  const res = mockResponse();

  app.serveEvents(req, res, new URL('http://localhost/events?token=token'));

  assert.equal(res.status, 200);
  assert.equal(app.clients.size, 1);
  assert.match(res.body, /event: state/);
  assert.equal(app.app.connectedClients, 1);

  req.emit('close');
  assert.equal(app.clients.size, 0);
  assert.equal(app.app.connectedClients, 0);
});

test('sendSse drops clients that cannot be written to', () => {
  const app = makeAppWithQueue([]);
  const client = { res: { write() { throw new Error('closed'); } } };
  app.clients.add(client);

  app.sendSse(client, 'state', { ok: true });

  assert.equal(app.clients.has(client), false);
});
