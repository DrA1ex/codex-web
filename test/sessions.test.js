'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { extractThreadList, normalizeSession, fallbackThreadTitle, extractMessagePreview } = require('../src/codex/sessions');
const { item, makeAppWithQueue } = require('./helpers');

test('session list normalization extracts IDs, preview, cwd match, and updated time', () => {
  const projectDir = process.cwd();
  const result = { threads: [{ threadId: 'thread-1' }] };
  assert.deepEqual(extractThreadList(result), result.threads);
  assert.deepEqual(extractThreadList({ data: [1] }), [1]);
  assert.deepEqual(extractThreadList({ items: [2] }), [2]);
  assert.deepEqual(extractThreadList([3]), [3]);

  const thread = {
    threadId: 'thread-1',
    cwd: projectDir,
    updatedAt: '2026-01-02T03:04:05.000Z',
    turns: [{
      items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Latest prompt text' }] }],
    }],
  };
  const session = normalizeSession(thread, projectDir);

  assert.equal(session.id, 'thread-1');
  assert.equal(session.cwdMatch, 'exact');
  assert.equal(session.preview, 'Latest prompt text');
  assert.equal(session.title, 'Latest prompt text');
  assert.equal(session.updatedAt, '2026-01-02T03:04:05.000Z');
  assert.equal(fallbackThreadTitle({ id: 'abc123' }, projectDir), require('node:path').basename(projectDir));
  assert.equal(extractMessagePreview(thread), 'Latest prompt text');
});

test('loadSessions merges exact and general results, filters ranked sessions, and reports warnings', async () => {
  const app = makeAppWithQueue([]);
  app.app.state = 'paused';
  const projectDir = app.opts.projectDir;
  const calls = [];
  app.rpc = {
    request: async (method, params) => {
      calls.push({ method, params });
      if (params.cwd) {
        return { threads: [{ threadId: 'exact', cwd: projectDir, updatedAt: '2026-01-01T00:00:00.000Z', preview: 'exact' }] };
      }
      return { threads: [
        { threadId: 'exact', cwd: projectDir, updatedAt: '2026-01-02T00:00:00.000Z', preview: 'duplicate' },
        { threadId: 'other', cwd: '/definitely/other/path', updatedAt: '2026-01-03T00:00:00.000Z', preview: 'other' },
      ] };
    },
  };

  await app.loadSessions();

  assert.equal(app.app.state, 'selecting-session');
  assert.equal(app.sessionsLoaded, true);
  assert.deepEqual(calls.map((c) => c.method), ['thread/list', 'thread/list']);
  assert.deepEqual(app.sessions.map((s) => s.id), ['exact']);
  assert.equal(app.sessions[0].preview, 'duplicate');
});

test('loadSessions preserves warnings from failed list requests', async () => {
  const app = makeAppWithQueue([]);
  app.app.state = 'paused';
  app.rpc = {
    request: async (method, params) => {
      if (params.cwd) throw new Error('exact failed');
      return { threads: [{ threadId: 'general', cwd: app.opts.projectDir, preview: 'general' }] };
    },
  };

  await app.loadSessions();

  assert.equal(app.sessions.length, 1);
  assert.match(app.app.message, /warnings: exact failed/);
});

test('selectSession resumes a session, loads pair state, refreshes title, and schedules pump', async () => {
  const app = makeAppWithQueue([]);
  app.app.state = 'selecting-session';
  const requests = [];
  app.rpc = {
    request: async (method, params) => {
      requests.push({ method, params });
      if (method === 'thread/resume') return { thread: { threadId: 'selected', title: 'Selected title', cwd: app.opts.projectDir } };
      if (method === 'thread/read') return { thread: { threadId: 'selected', title: 'Read title', cwd: app.opts.projectDir } };
      return {};
    },
  };
  app.setupPairState = async (sessionId) => { app.setupPairStateCalled = sessionId; };
  app.eventLog = (level, message) => { app.lastEvent = { level, message }; };

  await app.selectSession('selected');

  assert.equal(app.setupPairStateCalled, 'selected');
  assert.equal(app.app.sessionId, 'selected');
  assert.equal(app.app.sessionTitle, 'Read title');
  assert.equal(app.app.state, 'watching');
  assert.equal(app.lastScheduledDelay, 200);
  assert.equal(requests[0].method, 'thread/resume');
  assert.equal(requests[1].method, 'thread/read');
});

test('selectSession falls back to bare resume when policy resume fails', async () => {
  const app = makeAppWithQueue([]);
  app.app.state = 'selecting-session';
  const paramsSeen = [];
  app.rpc = {
    request: async (method, params) => {
      if (method === 'thread/read') return {};
      paramsSeen.push(params);
      if (params.cwd) throw new Error('policy rejected');
      return { thread: { threadId: 'selected' } };
    },
  };
  app.setupPairState = async () => {};

  await app.selectSession('selected');

  assert.equal(paramsSeen.length, 2);
  assert.deepEqual(paramsSeen[1], { threadId: 'selected' });
});

test('selectSession unavailable state clears session and queue through failSessionSelection', async () => {
  const app = makeAppWithQueue([item('pending')]);
  app.app.state = 'selecting-session';
  app.releaseLock = () => { app.released = true; };
  app.setupPairState = async () => { throw new Error('lock failed'); };
  app.rpc = { request: async () => ({ thread: { threadId: 'selected' } }) };

  await app.selectSession('selected');

  assert.equal(app.released, true);
  assert.equal(app.app.sessionId, null);
  assert.equal(app.app.state, 'selecting-session');
  assert.equal(app.app.sessionError.message, 'lock failed');
  assert.deepEqual(app.queue, []);
});

test('createSession starts a thread and validates missing session ids', async () => {
  const app = makeAppWithQueue([]);
  app.app.state = 'selecting-session';
  app.rpc = {
    request: async (method) => {
      if (method === 'thread/start') return { thread: { threadId: 'new-thread', title: 'New thread' } };
      if (method === 'thread/read') return { thread: { threadId: 'new-thread', title: 'Read new thread' } };
      return {};
    },
  };
  app.setupPairState = async () => {};

  await app.createSession();

  assert.equal(app.app.sessionId, 'new-thread');
  assert.equal(app.app.sessionTitle, 'Read new thread');
  assert.equal(app.app.state, 'watching');

  const missing = makeAppWithQueue([]);
  missing.app.state = 'selecting-session';
  missing.rpc = { request: async () => ({ thread: {} }) };
  await assert.rejects(() => missing.createSession(), /did not return a session id/);
});
