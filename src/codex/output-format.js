'use strict';

const {
  MAX_OUTPUT_ENTRY_CHARS,
  OUTPUT_TRUNCATED_MARKER,
} = require('../shared/config');
const { asArray } = require('../shared/utils');

function isApprovalMethod(method) {
  return /requestApproval$/.test(method) || method.includes('/requestApproval') || method.includes('/permissions/requestApproval') || method.includes('/commandExecution/requestApproval') || method.includes('/fileChange/requestApproval');
}
function isCompactionMethod(method) {
  return /compact|compaction|summari[sz]|summary/i.test(String(method || ''));
}
function canAppendOutput(previousType, nextType) {
  if (!previousType || !nextType || previousType !== nextType) return false;
  return nextType === 'delta' || nextType === 'tool-delta' || nextType === 'reasoning-delta' || nextType === 'context-delta';
}
function limitOutputText(text) {
  const s = String(text);
  if (s.length <= MAX_OUTPUT_ENTRY_CHARS) return s;
  return s.slice(0, Math.max(0, MAX_OUTPUT_ENTRY_CHARS - OUTPUT_TRUNCATED_MARKER.length)) + OUTPUT_TRUNCATED_MARKER;
}
function appendLimitedOutputText(current, addition) {
  const base = String(current || '');
  if (base.length >= MAX_OUTPUT_ENTRY_CHARS) return base;
  const next = String(addition);
  const room = MAX_OUTPUT_ENTRY_CHARS - base.length;
  if (next.length <= room) return base + next;
  if (room <= OUTPUT_TRUNCATED_MARKER.length) {
    return base.slice(0, Math.max(0, MAX_OUTPUT_ENTRY_CHARS - OUTPUT_TRUNCATED_MARKER.length)) + OUTPUT_TRUNCATED_MARKER;
  }
  return base + next.slice(0, room - OUTPUT_TRUNCATED_MARKER.length) + OUTPUT_TRUNCATED_MARKER;
}
function extractDeltaText(method, params) {
  if (!params) return '';
  if (typeof params.delta === 'string') return params.delta;
  if (typeof params.textDelta === 'string') return params.textDelta;
  if (typeof params.outputDelta === 'string') return params.outputDelta;
  if (typeof params.chunk === 'string') return params.chunk;
  if (typeof params.text === 'string' && /delta/i.test(method)) return params.text;
  if (params.deltaBase64) {
    try { return Buffer.from(params.deltaBase64, 'base64').toString('utf8'); } catch (_) {}
  }
  if (params.bytesBase64) {
    try { return Buffer.from(params.bytesBase64, 'base64').toString('utf8'); } catch (_) {}
  }
  return '';
}
function extractItemText(item) {
  if (!item) return '';
  if (typeof item.text === 'string') return item.text;
  if (typeof item.message === 'string') return item.message;
  if (typeof item.content === 'string') return item.content;
  if (Array.isArray(item.content)) {
    return item.content.map((part) => {
      if (typeof part === 'string') return part;
      if (typeof part?.text === 'string') return part.text;
      if (typeof part?.content === 'string') return part.content;
      if (typeof part?.text?.value === 'string') return part.text.value;
      return '';
    }).filter(Boolean).join('\n');
  }
  return '';
}
function formatItemStarted(item) {
  if (!item) return '';
  if (item.type === 'commandExecution') return `[tool] command: ${asArray(item.command).join(' ') || item.command || ''}`;
  if (item.type === 'mcpToolCall') return `[tool] ${item.server || 'mcp'}:${item.tool || ''}`;
  if (item.type === 'dynamicToolCall') return `[tool] ${item.tool || 'dynamicTool'}`;
  if (item.type === 'fileChange') return '';
  if (item.type === 'webSearch') return `[tool] web search ${item.query || ''}`;
  if (item.type === 'userMessage') return '';
  if (item.type === 'agentMessage') return '';
  if (item.type === 'reasoning') return '[reasoning]';
  if (item.type === 'plan') return '[plan]';
  return item.type ? `[item] ${item.type}` : '';
}
function outputTypeForItem(item) {
  if (!item) return 'item';
  if (item.type === 'reasoning') return 'reasoning';
  if (item.type === 'plan') return 'plan';
  if (item.type === 'fileChange') return 'diff';
  if (item.type === 'userMessage') return 'prompt';
  if (item.type === 'commandExecution' || item.type === 'mcpToolCall' || item.type === 'dynamicToolCall' || item.type === 'webSearch') return 'tool';
  return 'item';
}
function formatItemCompleted(item) {
  if (!item) return '';
  if (item.type === 'commandExecution') return '';
  if (item.type === 'fileChange') return '';
  if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') return `[tool] ${item.status || 'completed'}`;
  if (item.type === 'agentMessage' || item.type === 'userMessage' || item.type === 'reasoning' || item.type === 'plan') return '';
  return item.status ? `[item] ${item.type || 'item'} ${item.status}` : '';
}

module.exports = {
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
};
