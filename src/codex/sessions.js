'use strict';

const path = require('node:path');
const { pathRelation, asArray, truncate, shortId } = require('../shared/utils');

function extractThreadList(result) {
  return result?.data || result?.threads || result?.items || (Array.isArray(result) ? result : []);
}
function normalizeSession(t, projectDir) {
  const id = t.id || t.threadId || t.sessionId || '';
  const cwd = t.cwd || t.currentWorkingDirectory || t.projectDir || t.path || t.metadata?.cwd || t.session?.cwd || null;
  const rank = pathRelation(projectDir, cwd);
  const updated = t.updatedAt || t.recencyAt || t.createdAt || t.lastActivityAt || null;
  const updatedAtMs = typeof updated === 'number' ? updated * 1000 : (updated ? Date.parse(updated) : 0);
  return {
    id,
    title: fallbackThreadTitle(t, projectDir),
    preview: t.preview || t.lastUserMessage || extractMessagePreview(t) || '',
    cwd,
    cwdMatch: rank === 0 ? 'exact' : (rank === 1 ? 'child' : (rank === 2 ? 'parent' : 'other')),
    rank,
    updatedAt: updatedAtMs ? new Date(updatedAtMs).toISOString() : null,
    updatedAtMs,
    status: t.status || null,
  };
}
function fallbackThreadTitle(t, projectDir) {
  return t.name || t.title || t.preview || extractMessagePreview(t) || path.basename(projectDir) || shortId(t.id || t.threadId || t.sessionId || 'session');
}
function extractMessagePreview(t) {
  const turns = asArray(t.turns);
  for (let i = turns.length - 1; i >= 0; i--) {
    const items = asArray(turns[i].items);
    for (let j = items.length - 1; j >= 0; j--) {
      const item = items[j];
      if (item.type === 'userMessage') {
        const c = asArray(item.content).find((x) => x.type === 'text');
        if (c?.text) return truncate(c.text, 120);
      }
    }
  }
  return '';
}

module.exports = {
  extractThreadList,
  normalizeSession,
  fallbackThreadTitle,
  extractMessagePreview,
};
