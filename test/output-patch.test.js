'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const { createOutputPatch } = require('../src/app/output-patch');
const { makeAppWithQueue } = require('./helpers');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('createOutputPatch emits only changed records, removals, and ordering', () => {
  const previous = {
    output: [{ id: 'a', text: 'old' }, { id: 'b', text: 'same' }],
    outputGroups: [{ id: 'g1', status: 'active' }],
    outputHistory: { hasMore: true },
  };
  const next = {
    output: [{ id: 'b', text: 'same' }, { id: 'a', text: 'new' }, { id: 'c', text: 'added' }],
    outputGroups: [],
    outputHistory: { hasMore: false },
  };

  const patch = createOutputPatch(previous, next, 3);

  assert.equal(patch.sequence, 3);
  assert.deepEqual(patch.output.upsert.map((entry) => entry.id), ['a', 'c']);
  assert.deepEqual(patch.output.remove, []);
  assert.deepEqual(patch.output.order, ['b', 'a', 'c']);
  assert.deepEqual(patch.outputGroups.remove, ['g1']);
  assert.deepEqual(patch.outputHistory, { hasMore: false });
});

test('rapid output deltas are batched into one incremental SSE patch', async () => {
  const app = makeAppWithQueue([]);
  const broadcasts = [];
  app.broadcast = (event, data) => broadcasts.push({ event, data });

  app.appendOutput('hello ', 'delta', true);
  app.appendOutput('world', 'delta', true);
  assert.equal(broadcasts.length, 0);

  await sleep(70);

  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].event, 'outputPatch');
  assert.equal(broadcasts[0].data.output.upsert.length, 1);
  assert.equal(broadcasts[0].data.output.upsert[0].text, 'hello world');
  assert.equal(Object.prototype.hasOwnProperty.call(broadcasts[0].data, 'fullOutput'), false);
});

test('SSE backpressure queues events until drain and disconnects an overflowing client', () => {
  const app = makeAppWithQueue([]);
  const res = new EventEmitter();
  const writes = [];
  let first = true;
  res.write = (chunk) => {
    writes.push(String(chunk));
    if (first) {
      first = false;
      return false;
    }
    return true;
  };
  res.end = () => { res.ended = true; };
  const client = { res, blocked: false, queue: [], queuedBytes: 0, closed: false };
  app.clients.add(client);

  app.sendSse(client, 'one', { n: 1 });
  app.sendSse(client, 'two', { n: 2 });
  assert.equal(client.blocked, true);
  assert.equal(client.queue.length, 1);

  res.emit('drain');
  assert.equal(client.blocked, false);
  assert.equal(client.queue.length, 0);
  assert.match(writes.at(-1), /event: two/);

  client.blocked = true;
  app.sendSse(client, 'huge', { value: 'x'.repeat(1024 * 1024 + 1) });
  assert.equal(client.closed, true);
  assert.equal(app.clients.has(client), false);
  assert.equal(res.ended, true);
});

test('frontend output patch module applies sequences and detects gaps', async () => {
  const modulePath = pathToFileURL(path.join(__dirname, '..', 'www', 'src', 'core', 'output-patch.js')).href;
  const { applyOutputPatch } = await import(modulePath);
  const snapshot = {
    outputSequence: 1,
    output: [{ id: 'a', text: 'old' }],
    outputGroups: [{ id: 'g', status: 'active' }],
    outputHistory: { hasMore: true },
  };

  const result = applyOutputPatch(snapshot, {
    sequence: 2,
    output: { upsert: [{ id: 'a', text: 'new' }, { id: 'b', text: 'added' }], remove: [], order: ['b', 'a'] },
    outputGroups: { upsert: [], remove: ['g'], order: [] },
    outputHistory: { hasMore: false },
  });

  assert.deepEqual(result, { applied: true, gap: false });
  assert.deepEqual(snapshot.output.map((entry) => entry.id), ['b', 'a']);
  assert.equal(snapshot.output[1].text, 'new');
  assert.deepEqual(snapshot.outputGroups, []);
  assert.equal(snapshot.outputHistory.hasMore, false);

  const before = JSON.stringify(snapshot);
  const gap = applyOutputPatch(snapshot, {
    sequence: 4,
    output: { upsert: [], remove: [], order: null },
    outputGroups: { upsert: [], remove: [], order: null },
  });
  assert.deepEqual(gap, { applied: false, gap: true });
  assert.equal(JSON.stringify(snapshot), before);
});

test('frontend output component model keys groups and escapes streamed content', async () => {
  const outputModulePath = pathToFileURL(path.join(__dirname, '..', 'www', 'src', 'features', 'output', 'index.js')).href;
  const stateModulePath = pathToFileURL(path.join(__dirname, '..', 'www', 'src', 'core', 'state.js')).href;
  const [{ outputComponentModel }, { state }] = await Promise.all([
    import(outputModulePath),
    import(stateModulePath),
  ]);
  state.snap = { outputHistory: { hasMore: true } };
  state.outputHistoryLoading = false;
  state.expandedOutputGroups = Object.create(null);
  state.expandedDiffOutput = Object.create(null);
  state.expandedToolOutput = Object.create(null);

  const lines = [
    { id: 'plain', type: 'delta', text: '<script>alert(1)</script>' },
    { id: 'group-line', groupId: 'group-1', type: 'prompt', text: 'Grouped prompt' },
  ];
  const groups = [{
    id: 'group-1',
    status: 'completed',
    title: 'Grouped title',
    summary: 'Done',
  }];
  const components = outputComponentModel(lines, groups);

  assert.deepEqual(components.map((component) => component.key), [
    'history-control',
    'line:plain',
    'group:group-1',
  ]);
  assert.match(components[1].html, /data-output-component="line:plain"/);
  assert.doesNotMatch(components[1].html, /<script>/);
  assert.match(components[1].html, /&lt;script&gt;/);
  assert.match(components[2].html, /Grouped title/);
});

test('the complete frontend ESM graph imports under Node', async () => {
  const bootstrap = pathToFileURL(path.join(__dirname, '..', 'www', 'src', 'core', 'bootstrap.js')).href;
  const loaded = await import(bootstrap);
  assert.equal(typeof loaded.startApp, 'function');
});
