'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  isApprovalMethod,
  isCompactionMethod,
  canAppendOutput,
  limitOutputText,
  appendLimitedOutputText,
  extractDeltaText,
  extractItemText,
  formatItemStarted,
  outputTypeForItem,
  formatItemCompleted,
} = require('../src/codex/output-format');
const { MAX_OUTPUT_ENTRY_CHARS, OUTPUT_TRUNCATED_MARKER } = require('../src/shared/config');

test('output formatting classifies stream items and deltas', () => {
  assert.equal(isApprovalMethod('item/fileChange/requestApproval'), true);
  assert.equal(isApprovalMethod('anything/requestApproval'), true);
  assert.equal(isCompactionMethod('turn/summary/delta'), true);
  assert.equal(canAppendOutput('delta', 'delta'), true);
  assert.equal(canAppendOutput('tool', 'tool'), false);
  assert.equal(extractDeltaText('turn/delta', { deltaBase64: Buffer.from('hello').toString('base64') }), 'hello');
  assert.equal(extractDeltaText('turn/delta', { bytesBase64: Buffer.from('bytes').toString('base64') }), 'bytes');
  assert.equal(extractDeltaText('turn/delta', { text: 'text delta' }), 'text delta');
  assert.equal(extractItemText({ text: 'item text' }), 'item text');
  assert.equal(extractItemText({ content: [{ text: 'part one' }, { text: { value: 'part two' } }] }), 'part one\npart two');
  assert.equal(formatItemStarted({ type: 'commandExecution', command: ['npm', 'test'] }), '[tool] command: npm test');
  assert.equal(formatItemStarted({ type: 'mcpToolCall', server: 'srv', tool: 'read' }), '[tool] srv:read');
  assert.equal(formatItemStarted({ type: 'webSearch', query: 'docs' }), '[tool] web search docs');
  assert.equal(formatItemStarted({ type: 'reasoning' }), '[reasoning]');
  assert.equal(outputTypeForItem({ type: 'fileChange' }), 'diff');
  assert.equal(outputTypeForItem({ type: 'userMessage' }), 'prompt');
  assert.equal(formatItemCompleted({ type: 'dynamicToolCall', status: 'completed' }), '[tool] completed');
  assert.equal(formatItemCompleted({ type: 'fileChange', status: 'completed' }), '');
  assert.equal(formatItemCompleted({ type: 'custom', status: 'failed' }), '[item] custom failed');
});

test('output text limiting truncates single and appended entries consistently', () => {
  const long = 'x'.repeat(MAX_OUTPUT_ENTRY_CHARS + 50);
  const limited = limitOutputText(long);
  assert.equal(limited.length, MAX_OUTPUT_ENTRY_CHARS);
  assert.equal(limited.endsWith(OUTPUT_TRUNCATED_MARKER), true);

  const appended = appendLimitedOutputText('a'.repeat(MAX_OUTPUT_ENTRY_CHARS - 5), 'b'.repeat(100));
  assert.equal(appended.length, MAX_OUTPUT_ENTRY_CHARS);
  assert.equal(appended.endsWith(OUTPUT_TRUNCATED_MARKER), true);

  assert.equal(appendLimitedOutputText('base', ' next'), 'base next');
});
