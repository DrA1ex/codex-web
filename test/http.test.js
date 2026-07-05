'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');

const { renderAuthErrorPage } = require('../src/http/auth-page');
const { rawPathname, staticAssetName } = require('../src/http/static-assets');
const { sendText, sendJson, readJsonBody } = require('../src/http/utils');
const { resolveApiRoute } = require('../src/http/api-routes');
const { item, makeAppWithQueue, mockResponse } = require('./helpers');

test('static asset helpers accept safe root/src assets and reject traversal', () => {
  assert.equal(rawPathname('/src/app.js?token=secret#hash'), '/src/app.js');
  assert.equal(staticAssetName('/app.js'), 'app.js');
  assert.equal(staticAssetName('/styles.css'), 'styles.css');
  assert.equal(staticAssetName('/src/ui/button.svg'), 'src/ui/button.svg');
  assert.equal(staticAssetName('/src/icons/send.png'), 'src/icons/send.png');
  assert.equal(staticAssetName('/assets/icons/send.png'), 'assets/icons/send.png');
  assert.equal(staticAssetName('/src/../secret.js'), null);
  assert.equal(staticAssetName('/src//bad.js'), null);
  assert.equal(staticAssetName('/%E0%A4%A'), null)
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

test('index requires a valid token and does not leak token on auth error', async () => {
  const app = makeAppWithQueue([]);
  app.token = 'secret-token';
  const res = mockResponse();

  await app.serveIndex({ headers: {} }, res, new URL('http://localhost/'));

  assert.equal(res.status, 403);
  assert.match(res.body, /Authorization error/);
  assert.doesNotMatch(res.body, /secret-token/);
});

test('handleHttp serves static text and binary assets asynchronously', async () => {
  const app = makeAppWithQueue([]);
  app.token = 'token';

  const css = mockResponse();
  await app.handleHttp({ method: 'GET', url: '/styles.css', headers: { host: 'localhost' } }, css);
  assert.equal(css.status, 200);
  assert.equal(css.headers['Content-Type'], 'text/css; charset=utf-8');
  assert.match(css.body, /body/);

  const icon = mockResponse();
  await app.handleHttp({ method: 'GET', url: '/assets/icons/send.png', headers: { host: 'localhost' } }, icon);
  assert.equal(icon.status, 200);
  assert.equal(icon.headers['Content-Type'], 'image/png');
  assert.ok(icon.body.length > 0);
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

test('snapshot caps completed archive and exposes archive metadata', () => {
  const completed = Array.from({ length: 12 }, (_, index) => item(`done-${index}`, 'completed', {
    finishedAt: new Date(Date.now() - (index * 1000)).toISOString(),
  }));
  const app = makeAppWithQueue([...completed, item('pending')]);
  app.app.state = 'watching';

  const snap = app.snapshot();

  assert.equal(snap.completedArchive.items.length, 10);
  assert.equal(snap.completedArchive.hasMore, true);
  assert.equal(snap.completedArchive.cursor.id, snap.completedArchive.items[0].id);
  assert.equal(snap.queue.filter((queueItem) => queueItem.status === 'completed').length, 10);
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

  app.loadPreviousOutputGroup = async () => ({ ok: true, loaded: false, hasMore: false });

  response = await resolveApiRoute(app, { method: 'POST' }, '/api/output/history/previous', {});
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, loaded: false, hasMore: false });

  app.setSandbox = async (sandbox) => ({ ok: true, sandbox });
  app.setApprovalPolicy = async (approvalPolicy) => ({ ok: true, approvalPolicy });

  response = await resolveApiRoute(app, { method: 'POST' }, '/api/config/sandbox', { sandbox: 'read-only' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, sandbox: 'read-only' });

  response = await resolveApiRoute(app, { method: 'POST' }, '/api/config/approval', { approvalPolicy: 'never' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, approvalPolicy: 'never' });
});

test('resolveApiRoute exposes rate-limit reset request endpoint', async () => {
  const app = makeAppWithQueue([]);
  app.requestLimitReset = () => ({ ok: true, resetRequest: { requestId: 'request-1' } });

  const response = await resolveApiRoute(app, { method: 'POST' }, '/api/limits/reset-request', {});

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, resetRequest: { requestId: 'request-1' } });
});

test('resolveApiRoute exposes completed archive pages', async () => {
  const completed = Array.from({ length: 12 }, (_, index) => item(`done-${index}`, 'completed', {
    finishedAt: new Date(Date.now() - (index * 1000)).toISOString(),
  }));
  const app = makeAppWithQueue([...completed, item('pending')]);
  const initial = app.completedArchiveSnapshot();

  const response = await resolveApiRoute(app, { method: 'POST' }, '/api/queue/completed-page', {
    before: initial.cursor,
    limit: 50,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.items.length, 2);
  assert.equal(response.body.hasMore, false);
  assert.equal(response.body.cursor.id, response.body.items[0].id);
});

test('completed archive pages walk large history to the end', async () => {
  const base = Date.parse('2026-01-01T00:00:00.000Z');
  const completed = Array.from({ length: 123 }, (_, index) => item(`done-${index}`, 'completed', {
    finishedAt: new Date(base + (index * 1000)).toISOString(),
  }));
  const app = makeAppWithQueue([...completed, item('pending')]);

  let page = app.completedArchiveSnapshot();
  const loaded = [...page.items];

  while (page.hasMore) {
    const response = await resolveApiRoute(app, { method: 'POST' }, '/api/queue/completed-page', {
      before: page.cursor,
      limit: 50,
    });
    assert.equal(response.status, 200);
    page = response.body;
    loaded.push(...page.items);
  }

  assert.equal(loaded.length, 123);
  assert.equal(new Set(loaded.map((queueItem) => queueItem.id)).size, 123);
  assert.equal(page.hasMore, false);
});

test('completed archive stale cursor does not restart from newest page', async () => {
  const completed = Array.from({ length: 12 }, (_, index) => item(`done-${index}`, 'completed', {
    finishedAt: new Date(Date.now() - (index * 1000)).toISOString(),
  }));
  const app = makeAppWithQueue([...completed, item('pending')]);

  const response = await resolveApiRoute(app, { method: 'POST' }, '/api/queue/completed-page', {
    before: { id: 'missing-cursor' },
    limit: 50,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.items.length, 0);
  assert.equal(response.body.hasMore, false);
  assert.equal(response.body.cursor, null);
  assert.equal(response.body.totalCompleted, 12);
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
