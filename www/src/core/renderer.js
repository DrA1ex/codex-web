import { state } from '#core/state';
import { renderQueue } from '#features/queue';
import { renderOutput } from '#features/output';
import { updateCounter } from '#features/composer';
import { renderApproval } from '#ui/approval';
import { renderConfirm } from '#ui/confirm';
import { renderHeader } from '#ui/header';
import { renderLimitResetModal } from '#ui/limit-reset';
import { renderScheduleModal } from '#ui/schedule';
import { renderSessions } from '#ui/sessions';

const CACHED_SECTIONS = {
  header: renderHeader,
  sessions: renderSessions,
  approval: renderApproval,
  queue: renderQueue,
  output: renderOutput,
  debug: renderDebug,
};

function queueTime(item) {
  const time = new Date(item?.finishedAt || item?.createdAt || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

export function mergeCompletedArchiveQueue(queue, archiveItems) {
  const byId = new Map();
  for (const item of archiveItems || []) byId.set(item.id, item);
  for (const item of queue || []) byId.set(item.id, item);
  return [...byId.values()];
}

export function syncCompletedArchiveCache(snapshot) {
  const sessionId = snapshot?.app?.sessionId || '';
  const cache = state.completedArchiveCache;
  if (cache.sessionId !== sessionId) {
    cache.sessionId = sessionId;
    cache.items = [];
    cache.hasMore = false;
    cache.totalCompleted = 0;
    cache.cursor = null;
    cache.loading = false;
  }

  const archive = snapshot?.completedArchive || null;
  if (!archive) return;

  const totalCompleted = Number(snapshot?.app?.queueCounts?.completed || 0);
  if (!totalCompleted) {
    cache.items = [];
    cache.hasMore = false;
    cache.totalCompleted = 0;
    cache.cursor = null;
    cache.loading = false;
    return;
  }
  cache.totalCompleted = totalCompleted;

  const incoming = Array.isArray(archive.items) ? archive.items : [];
  if (incoming.length) {
    const hadCachedItems = cache.items.length > 0;
    const merged = mergeCompletedArchiveQueue(cache.items, incoming)
      .filter((item) => item?.status === 'completed')
      .sort((left, right) => queueTime(left) - queueTime(right) || String(left.id || '').localeCompare(String(right.id || '')));
    cache.items = merged;
    if (!hadCachedItems) cache.cursor = archive.cursor || null;
  } else if (!cache.items.length) {
    cache.cursor = archive.cursor || null;
  }

  cache.hasMore = cache.items.length < totalCompleted && Boolean(archive.hasMore || cache.hasMore);
}

function stableKey(value) {
  try {
    return JSON.stringify(value == null ? null : value);
  } catch {
    return String(Date.now());
  }
}

export function sectionKey(name, snapshot) {
  const app = snapshot?.app || {};

  if (name === 'header') return stableKey({ app, rateLimits: snapshot?.rateLimits });
  if (name === 'sessions') {
    return stableKey({
      state: app.state,
      sessionId: app.sessionId,
      sessionError: app.sessionError,
      sessions: snapshot?.sessions,
    });
  }
  if (name === 'approval') return stableKey(snapshot?.approval);
  if (name === 'queue') {
    return stableKey({
      queue: snapshot?.queue,
      counts: app.queueCounts,
      nextPendingId: app.nextPendingId,
      canInterrupt: app.canInterrupt,
      sendLocked: app.state === 'countdown',
      completedArchiveLevel: state.completedQueueArchiveLevel,
      completedArchiveHasMore: state.completedArchiveCache.hasMore,
      completedArchiveLoading: state.completedArchiveCache.loading,
      completedArchiveCursor: state.completedArchiveCache.cursor,
      completedArchiveCount: state.completedArchiveCache.items.length,
    });
  }
  if (name === 'output') {
    return stableKey({
      output: snapshot?.output,
      outputGroups: snapshot?.outputGroups,
      outputHistory: snapshot?.outputHistory,
      outputHistoryLoading: state.outputHistoryLoading,
    });
  }
  if (name === 'debug') return stableKey(snapshot?.debug);

  return '';
}

function renderDebug() {
  const debug = document.getElementById('debug');
  if (debug) debug.textContent = JSON.stringify(state.snap?.debug || {}, null, 2);
}

function renderSection(name, force) {
  const nextKey = sectionKey(name, state.snap);
  const hasPendingQueueScroll = name === 'queue' && state.pendingQueueScrollId;

  if (!force && !hasPendingQueueScroll && state.renderKeys[name] === nextKey) return;

  state.renderKeys[name] = nextKey;
  CACHED_SECTIONS[name]();
}

export function update(snapshot) {
  const isFirstRender = !state.snap;
  syncCompletedArchiveCache(snapshot);
  snapshot.queue = mergeCompletedArchiveQueue(snapshot.queue || [], state.completedArchiveCache.items);
  state.snap = snapshot;
  render(isFirstRender);
}

export function render(force = false) {
  if (!state.snap) return;

  renderSection('header', force);
  renderSection('sessions', force);
  renderSection('approval', force);
  renderConfirm();
  renderLimitResetModal();
  renderScheduleModal();
  renderSection('queue', force);
  renderSection('output', force);
  renderSection('debug', force);
  updateCounter();
}
