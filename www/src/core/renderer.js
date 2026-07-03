import { state } from '#core/state';
import { renderQueue } from '#features/queue';
import { renderOutput } from '#features/output';
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
    });
  }
  if (name === 'output') return stableKey(snapshot?.output);
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
}
