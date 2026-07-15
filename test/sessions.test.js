'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const { extractThreadList, normalizeSession, fallbackThreadTitle, extractMessagePreview } = require('../src/codex/sessions');
const { sha256, stripTrailingSep } = require('../src/shared/utils');
const { item, makeAppWithQueue, tempDir } = require('./helpers');

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
  assert.equal(normalizeSession({ threadId: 'thread-2', title: 'Short title' }, projectDir).title, 'Short title');
  assert.equal(fallbackThreadTitle({ id: 'abc123' }, projectDir), require('node:path').basename(projectDir));
  assert.equal(extractMessagePreview(thread), 'Latest prompt text');
});

test('loadSessions merges exact and general results, filters ranked sessions, and reports warnings', async () => {
  const stateDir = await tempDir();
  const app = makeAppWithQueue([], { stateDir });
  app.app.state = 'paused';
  const projectDir = app.opts.projectDir;
  const key = sha256(`${stripTrailingSep(projectDir)}\nexact`).slice(0, 32);
  const queueDir = path.join(stateDir, key);
  await fsp.mkdir(queueDir, { recursive: true });
  await fsp.writeFile(path.join(queueDir, 'queue.json'), JSON.stringify([
    item('queued', 'pending'),
    item('done', 'completed'),
    item('next', 'next'),
  ]));
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
  assert.deepEqual(app.sessions[0].queueCounts, { pending: 2, completed: 1 });
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
  const app = makeAppWithQueue([], { model: 'gpt-test', effort: 'medium' });
  app.app.state = 'selecting-session';
  const requests = [];
  app.rpc = {
    request: async (method, params) => {
      requests.push({ method, params });
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
  assert.equal(requests[0].method, 'thread/start');
  assert.equal(requests[0].params.model, 'gpt-test');
  assert.equal(requests[0].params.effort, 'medium');

  const missing = makeAppWithQueue([]);
  missing.app.state = 'selecting-session';
  missing.rpc = { request: async () => ({ thread: {} }) };
  await assert.rejects(() => missing.createSession(), /did not return a session id/);
});

test('loadSessions reads active queue and completed archive metadata asynchronously', async () => {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const { sha256, stripTrailingSep } = require('../src/shared/utils');
  const { tempDir } = require('./helpers');

  const stateDir = await tempDir();
  const app = makeAppWithQueue([], { stateDir, projectDir: process.cwd(), allSessions: true });
  app.app.sessionId = null;
  app.app.state = 'selecting-session';
  const sessionId = 'session-with-archive';
  const key = sha256(`${stripTrailingSep(app.opts.projectDir)}\n${sessionId}`).slice(0, 32);
  const pairDir = path.join(stateDir, key);
  await fs.mkdir(pairDir, { recursive: true });
  await fs.writeFile(path.join(pairDir, 'queue.json'), JSON.stringify([
    { id: 'pending', text: 'Pending', status: 'pending' },
    { id: 'active', text: 'Active', status: 'sent' },
  ]));
  await fs.writeFile(path.join(pairDir, 'completed.meta.json'), JSON.stringify({ totalCompleted: 17 }));

  app.rpc = {
    request: async (method, params) => {
      if (method !== 'thread/list') return {};
      if (params.cwd) return { data: [{ id: sessionId, cwd: app.opts.projectDir, preview: 'Recent work' }] };
      return { data: [] };
    },
  };

  await app.loadSessions();

  const session = app.sessions.find((candidate) => candidate.id === sessionId);
  assert.ok(session);
  assert.deepEqual(session.queueCounts, { pending: 1, completed: 17 });
});

test('session operations reject overlap and release the guard after failure', async () => {
  const app = makeAppWithQueue([]);
  app.app.state = 'selecting-session';
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  app.rpc = {
    request: async (method) => {
      if (method === 'thread/list') {
        await blocked;
        return { threads: [] };
      }
      return {};
    },
  };

  const loading = app.loadSessions();
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => app.createSession(), /Another session operation.*loadSessions/);
  release();
  await loading;
  assert.equal(app.sessionOperation, null);

  app.rpc.request = async () => { throw new Error('list failed'); };
  await app.loadSessions();
  assert.equal(app.sessionOperation, null);
});

test('selectSession rejects an empty id before changing state or calling RPC', async () => {
  const app = makeAppWithQueue([]);
  app.app.state = 'selecting-session';
  let called = false;
  app.rpc = { request: async () => { called = true; return {}; } };

  await assert.rejects(() => app.selectSession('   '), /session id is required/i);

  assert.equal(called, false);
  assert.equal(app.app.state, 'selecting-session');
  assert.equal(app.sessionOperation, null);
});

test('tryReadSession ignores a response that belongs to a previously selected session', async () => {
  const app = makeAppWithQueue([]);
  app.app.sessionId = 'old-session';
  app.app.sessionTitle = 'Old title';
  let resolveRead;
  app.rpc = {
    request: async () => await new Promise((resolve) => { resolveRead = resolve; }),
  };

  const reading = app.tryReadSession();
  await new Promise((resolve) => setImmediate(resolve));
  app.app.sessionId = 'new-session';
  app.app.sessionTitle = 'New title';
  resolveRead({ thread: { threadId: 'old-session', title: 'Late old title' } });
  await reading;

  assert.equal(app.app.sessionId, 'new-session');
  assert.equal(app.app.sessionTitle, 'New title');
  assert.equal(app.app.session, undefined);
});

test('selectSession persists state again after installing the selected session id', async () => {
  const app = makeAppWithQueue([]);
  app.app.state = 'selecting-session';
  const savedSessionIds = [];
  app.rpc = {
    request: async (method) => {
      if (method === 'thread/resume') return { thread: { threadId: 'selected-session', title: 'Selected' } };
      if (method === 'thread/read') return { thread: { threadId: 'selected-session', title: 'Selected' } };
      return {};
    },
  };
  app.saveState = async (overrides = {}) => { savedSessionIds.push(overrides.sessionId ?? app.app.sessionId); };
  app.setupPairState = async (sessionId) => { await app.saveState({ sessionId }); };

  await app.selectSession('selected-session');

  assert.deepEqual(savedSessionIds, ['selected-session', 'selected-session']);
});

test('failed session selection clears previous archive paths, indexes, and output history', async () => {
  const app = makeAppWithQueue([item('pending')]);
  app.app.state = 'selecting-session';
  app.completedArchivePath = '/tmp/old-completed.jsonl';
  app.completedArchiveMetaPath = '/tmp/old-completed.meta.json';
  app.archivedCompletedIds = new Set(['old-item']);
  app.completedArchiveRecent = [item('old-item', 'completed')];
  app.completedArchiveTotal = 1;
  app.outputHistory = { sessionId: 'old-session', hasMore: true, loadedTurnIds: new Set(['turn']), turns: [{}], cursorIndex: 1 };
  app.releaseLock = () => {};
  app.setupPairState = async () => { throw new Error('state unavailable'); };
  app.rpc = { request: async () => ({ thread: { threadId: 'new-session' } }) };

  await app.selectSession('new-session');

  assert.equal(app.completedArchivePath, null);
  assert.equal(app.completedArchiveMetaPath, null);
  assert.deepEqual([...app.archivedCompletedIds], []);
  assert.deepEqual(app.completedArchiveRecent, []);
  assert.equal(app.completedArchiveTotal, 0);
  assert.equal(app.outputHistory.sessionId, null);
  assert.equal(app.outputHistory.hasMore, false);
});
