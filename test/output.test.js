'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { makeAppWithQueue } = require('./helpers');
const { MAX_OUTPUT_LINES, MAX_OUTPUT_TOTAL_CHARS } = require('../src/shared/config');

test('appendOutput appends compatible deltas and closes active diff on non-diff output', () => {
  const app = makeAppWithQueue([]);

  app.appendOutput('one', 'delta', true);
  app.appendOutput(' two', 'delta', true);
  assert.equal(app.output.length, 1);
  assert.equal(app.output[0].text, 'one two');

  app.updateDiffOutput('diff --git a/file b/file\n--- a/file\n+++ b/file\n-old\n+new');
  assert.equal(app.currentDiffFileKey, 'file');
  app.appendOutput('[reasoning] next', 'reasoning');
  assert.equal(app.currentDiffFileKey, null);
  assert.equal(app.output.at(-2).diff.active, false);
});

test('diff helpers parse files, captions, stats, and sections', () => {
  const app = makeAppWithQueue([]);
  const one = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n-old\n+new';
  const two = `${one}\ndiff --git a/b.js b/b.js\n--- a/b.js\n+++ b/b.js\n-a\n+b\n+c`;

  assert.deepEqual(app.diffFiles(one), ['a.js']);
  assert.equal(app.diffFileKey(one), 'a.js');
  assert.deepEqual(app.diffStats(two), { added: 3, removed: 2 });
  assert.equal(app.diffCaption(two), '2 files');

  const sections = app.diffSections(two);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].fileKey, 'a.js');
  assert.equal(sections[1].diff.added, 2);
});

test('diff output updates only consecutive diffs for the same file', () => {
  const app = makeAppWithQueue([]);

  app.updateDiffOutput('diff --git a/file b/file\n--- a/file\n+++ b/file\n-old\n+one');
  app.updateDiffOutput('diff --git a/file b/file\n--- a/file\n+++ b/file\n-old\n+one');
  assert.equal(app.output.length, 1);
  assert.equal(app.output[0].type, 'diff');
  assert.deepEqual(app.output[0].diff, { added: 1, removed: 1, caption: 'file', active: false });

  app.updateDiffOutput('diff --git a/file b/file\n--- a/file\n+++ b/file\n-old\n-two\n+three\n+four');
  assert.equal(app.output.length, 1);
  assert.match(app.output[0].text, /\+four/);
  assert.deepEqual(app.output[0].diff, { added: 2, removed: 2, caption: 'file', active: false });

  app.updateDiffOutput('diff --git a/other b/other\n--- a/other\n+++ b/other\n-before\n+after');
  assert.equal(app.output.length, 2);
  assert.equal(app.output[0].diff.active, false);
  assert.deepEqual(app.output[1].diff, { added: 1, removed: 1, caption: 'other', active: false });

  app.appendOutput('[reasoning] thinking', 'reasoning');
  app.updateDiffOutput('diff --git a/other b/other\n--- a/other\n+++ b/other\n-before\n+after again');
  assert.equal(app.output.length, 4);
  assert.equal(app.output[1].diff.active, false);
  assert.equal(app.output[2].type, 'reasoning');
  assert.deepEqual(app.output[3].diff, { added: 1, removed: 1, caption: 'other', active: false });

  app.finishActiveOutputBlocks();
  assert.equal(app.output[3].diff.active, false);
});

test('turn-level diff snapshots create or update only changed file blocks', () => {
  const app = makeAppWithQueue([]);
  const fileA = 'diff --git a/file-a.js b/file-a.js\n--- a/file-a.js\n+++ b/file-a.js\n-old\n+one';
  const fileB = 'diff --git a/file-b.js b/file-b.js\n--- a/file-b.js\n+++ b/file-b.js\n-before\n+after';
  const fileBUpdated = 'diff --git a/file-b.js b/file-b.js\n--- a/file-b.js\n+++ b/file-b.js\n-before\n+after\n+again';
  const fileAUpdated = 'diff --git a/file-a.js b/file-a.js\n--- a/file-a.js\n+++ b/file-a.js\n-old\n+two';

  app.updateDiffOutput(fileA);
  assert.equal(app.output.length, 1);
  assert.equal(app.output[0].diff.caption, 'file-a.js');

  app.updateDiffOutput(`${fileA}\n${fileB}`);
  assert.equal(app.output.length, 2);
  assert.equal(app.output[1].diff.caption, 'file-b.js');
  assert.match(app.output[1].text, /file-b\.js/);
  assert.doesNotMatch(app.output[1].text, /file-a\.js/);

  app.updateDiffOutput(`${fileA}\n${fileB}`);
  assert.equal(app.output.length, 2);

  app.updateDiffOutput(`${fileA}\n${fileBUpdated}`);
  assert.equal(app.output.length, 2);
  assert.deepEqual(app.output[1].diff, { added: 2, removed: 1, caption: 'file-b.js', active: false });

  app.appendOutput('[reasoning] changed plan', 'reasoning');
  app.updateDiffOutput(`${fileAUpdated}\n${fileBUpdated}`);
  assert.equal(app.output.length, 4);
  assert.equal(app.output[2].type, 'reasoning');
  assert.equal(app.output[3].diff.caption, 'file-a.js');
  assert.match(app.output[3].text, /\+two/);
});

test('command output completion updates existing tool block once and falls back when missing', () => {
  const app = makeAppWithQueue([]);
  app.appendCommandOutput({ id: 'cmd-1', command: ['npm', 'test'] });

  app.appendCommandOutputText({ id: 'cmd-1' }, 'one\n');
  app.appendCommandOutputText({ id: 'cmd-1' }, 'two\n');

  app.updateCommandOutput({ id: 'cmd-1', status: 'completed', exitCode: 0 });
  app.updateCommandOutput({ id: 'cmd-1', status: 'completed', exitCode: 0 });

  assert.equal(app.output.length, 1);
  assert.equal(app.output[0].type, 'tool');
  assert.equal(app.output[0].tool.command, 'npm test');
  assert.equal(app.output[0].tool.output, 'one\ntwo\n');
  assert.equal(app.output[0].tool.exitCode, 0);
  assert.equal(app.output[0].tool.active, false);

  const fallback = makeAppWithQueue([]);
  fallback.updateCommandOutput({ id: 'missing', status: 'failed', exitCode: 1 });
  assert.equal(fallback.output.at(-1).type, 'error');
  assert.match(fallback.output.at(-1).text, /exit: 1/);
});

test('anonymous command output fallback stays inside the current output group', () => {
  const app = makeAppWithQueue([]);
  const first = app.createOutputGroupForItem({ id: 'item-1', text: 'First prompt' });
  app.appendCommandOutput({ command: ['npm', 'test'] });
  assert.equal(app.appendCommandOutputText({}, 'first output\n'), true);
  app.finishCurrentOutputGroup('completed');

  const second = app.createOutputGroupForItem({ id: 'item-2', text: 'Second prompt' });
  assert.equal(app.appendCommandOutputText({}, 'second output\n'), false);

  assert.equal(app.output.length, 1);
  assert.equal(app.output[0].groupId, first.id);
  assert.equal(app.output[0].tool.output, 'first output\n');
  assert.equal(app.currentOutputGroupId, second.id);
});

test('clearOutput clears diff and command tracking maps', () => {
  const app = makeAppWithQueue([]);
  app.appendCommandOutput({ id: 'cmd-1', command: 'echo hi' });
  app.updateDiffOutput('diff --git a/file b/file\n--- a/file\n+++ b/file\n-old\n+new');
  app.createOutputGroupForItem({ id: 'item-1', text: 'Grouped prompt' });

  app.clearOutput();

  assert.deepEqual(app.output, []);
  assert.deepEqual(app.outputGroups, []);
  assert.equal(app.currentOutputGroupId, null);
  assert.equal(app.currentDiffOutputId, null);
  assert.equal(app.currentDiffFileKey, null);
  assert.equal(app.diffSnapshotByFileKey.size, 0);
  assert.equal(app.commandOutputByItemId.size, 0);
});

test('output groups stamp entries and summarize completed prompts', () => {
  const app = makeAppWithQueue([]);
  const group = app.createOutputGroupForItem({ id: 'item-1', text: 'Implement grouped output\nDetails' });

  app.appendOutput('[send] #item-1', 'send');
  app.appendOutput('[prompt]\nImplement grouped output', 'prompt');
  app.appendOutput('Done with grouped output.', 'delta', true);
  app.finishCurrentOutputGroup('completed');

  assert.equal(app.outputGroups.length, 1);
  assert.equal(app.outputGroups[0].id, group.id);
  assert.equal(app.outputGroups[0].queueItemId, 'item-1');
  assert.equal(app.outputGroups[0].title, 'Implement grouped output');
  assert.equal(app.outputGroups[0].status, 'completed');
  assert.equal(app.outputGroups[0].summary, 'Done with grouped output.');
  assert.ok(app.output.every((entry) => entry.groupId === group.id));
  assert.ok(app.output.every((entry) => entry.queueItemId === 'item-1'));
});

test('trimOutput enforces line and character limits and removes stale command mappings', () => {
  const app = makeAppWithQueue([]);
  for (let i = 0; i < MAX_OUTPUT_LINES + 5; i++) {
    app.appendOutput(`line ${i}`, 'system');
  }
  assert.equal(app.output.length, MAX_OUTPUT_LINES);

  app.output = [];
  app.commandOutputByItemId.set('cmd', 'gone');
  app.appendOutput('x'.repeat(MAX_OUTPUT_TOTAL_CHARS + 1000), 'system');
  assert.equal(app.output.length, 1);
  assert.equal(app.commandOutputByItemId.has('cmd'), false);
});
