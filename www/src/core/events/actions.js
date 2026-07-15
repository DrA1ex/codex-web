import { api, getState, isNetworkError, writeOutputError } from '#core/api';
import { state } from '#core/state';
import { addQueue, handleComposerResponse, updateCounter } from '#features/composer';
import { renderOutput } from '#features/output';
import { clearQueueScrollRequest, renderQueue, requestQueueScroll } from '#features/queue';
import { openConfirm, openMessage } from '#ui/confirm';
import { closeScheduleModal, scheduleInputIso } from '#ui/schedule';
import { setOutputMenuOpen, setQueueMenuOpen } from '#ui/header';

export function reportError(error) {
  if (isNetworkError(error)) return;
  writeOutputError(error);
}

export function post(path, body) {
  return api(path, body).catch(reportError);
}

export function queueItemById(id) {
  return (state.snap?.queue || []).find((item) => item.id === id) || null;
}

export function closeQueueMenuIfOutside(target) {
  if (!target?.closest?.('.menu-wrap')) {
    setQueueMenuOpen(false);
    setOutputMenuOpen(false);
  }
}

export function saveSchedule() {
  const scheduledRunAt = scheduleInputIso();
  if (!scheduledRunAt) {
    openMessage('Schedule', 'Select a valid time.', 'warning');
    return;
  }

  api('/api/queue/schedule', { scheduledRunAt })
    .then(() => {
      closeScheduleModal();
      getState().catch(reportError);
    })
    .catch(reportError);
}

export function undoQueue() {
  setQueueMenuOpen(false);
  api('/api/queue/undo')
    .then((response) => {
      handleComposerResponse(response);
      updateCounter();
      getState().catch(reportError);
    })
    .catch(reportError);
}

export function toggleQueueMenu() {
  const menu = document.getElementById('queueMenu');
  setOutputMenuOpen(false);
  setQueueMenuOpen(!(menu && !menu.classList.contains('hidden')));
}

export function toggleOutputMenu() {
  const menu = document.getElementById('outputMenu');
  setQueueMenuOpen(false);
  setOutputMenuOpen(!(menu && !menu.classList.contains('hidden')));
}

export function scrollOutputToBottomFromMenu() {
  setOutputMenuOpen(false);
  scrollOutputToBottom();
}

export function copyVisibleOutputFromMenu() {
  setOutputMenuOpen(false);
  copyVisibleOutput();
}

export function clearOutputFromMenu() {
  setOutputMenuOpen(false);
  post('/api/output/clear');
}

export async function loadPreviousOutputGroup() {
  const history = state.snap?.outputHistory || {};
  if (state.outputHistoryLoading || !history.hasMore) return;

  state.outputHistoryLoading = true;
  renderOutput();

  try {
    const response = await api('/api/output/history/previous');
    if (state.snap) {
      state.snap.outputHistory = {
        ...(state.snap.outputHistory || {}),
        hasMore: Boolean(response?.hasMore),
      };
    }
    await getState().catch(reportError);
    window.requestAnimationFrame(() => {
      if (state.outputEl) state.outputEl.scrollTop = 0;
    });
  } catch (error) {
    reportError(error);
  } finally {
    state.outputHistoryLoading = false;
    renderOutput();
  }
}

export function clearPendingQueue() {
  setQueueMenuOpen(false);
  openConfirm(
    'clear-pending',
    'Clear pending prompts?',
    'This will permanently remove all pending prompts from the queue. This cannot be undone.',
    'Yes, clear pending',
    true,
  );
}

export function clearCompletedQueue() {
  setQueueMenuOpen(false);
  openConfirm(
    'clear-completed',
    'Clear completed prompts?',
    'This will permanently remove all completed prompts from the queue. This cannot be undone.',
    'Yes, clear completed',
    true,
  );
}

function queueTime(item) {
  const time = new Date(item?.finishedAt || item?.createdAt || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function mergeCompletedArchiveItems(items, nextItems) {
  const byId = new Map();
  for (const item of items || []) byId.set(item.id, item);
  for (const item of nextItems || []) byId.set(item.id, item);
  return [...byId.values()]
    .filter((item) => item?.status === 'completed')
    .sort((left, right) => queueTime(left) - queueTime(right) || String(left.id || '').localeCompare(String(right.id || '')));
}

function mergeLoadedQueue(queue, archiveItems) {
  const byId = new Map();
  for (const item of archiveItems || []) byId.set(item.id, item);
  for (const item of queue || []) byId.set(item.id, item);
  return [...byId.values()];
}

export async function loadCompletedArchiveMore() {
  const archive = state.completedArchiveCache;
  if (!state.snap?.app?.sessionId || archive.loading || !archive.hasMore || !archive.cursor) return;

  archive.loading = true;
  renderQueue();

  try {
    const response = await api('/api/queue/completed-page', {
      before: archive.cursor,
      limit: 50,
    });

    archive.items = mergeCompletedArchiveItems(archive.items, response.items || []);
    archive.totalCompleted = Number(response.totalCompleted || archive.totalCompleted || state.snap?.app?.queueCounts?.completed || 0);
    archive.hasMore = archive.items.length < archive.totalCompleted && Boolean(response.hasMore);
    archive.cursor = response.cursor || archive.cursor;
    if (state.snap?.queue) state.snap.queue = mergeLoadedQueue(state.snap.queue, archive.items);
    renderQueue();
    await getState().catch(reportError);
  } catch (error) {
    reportError(error);
  } finally {
    archive.loading = false;
    renderQueue();
  }
}

export function scrollOutputToBottom() {
  if (state.outputEl) state.outputEl.scrollTop = state.outputEl.scrollHeight;
  state.outputUnread = false;
  const button = document.getElementById('bottomBtn');
  if (button) {
    button.classList.remove('has-new-output');
    button.innerHTML = '<span class="icon icon-arrow-down" aria-hidden="true"></span>Scroll to bottom';
  }
}

export function copyVisibleOutput() {
  const text = state.outputEl?.innerText || '';
  if (!text.trim()) return;
  navigator.clipboard?.writeText(text).catch(reportError);
}

export function toggleTheme() {
  const nextTheme = state.snap?.app?.theme === 'light' ? 'dark' : 'light';
  post('/api/config/theme', { theme: nextTheme });
}

export function updateQueueItem(id, action) {
  return api('/api/queue/update', { id, action }).catch(reportError);
}

export function sendQueueItemNow(id) {
  const app = state.snap?.app || {};

  if (app.state === 'countdown') {
    renderQueue();
    return;
  }

  requestQueueScroll(id, 'send', false);

  api('/api/queue/update', { id, action: 'sendNow' })
    .then((response) => {
      if (state.pendingQueueScrollId) requestQueueScroll(response?.item?.id || id, 'send', true);
      getState().catch(reportError);
    })
    .catch((error) => {
      clearQueueScrollRequest();
      reportError(error);
      getState().catch(reportError);
    });
}

export function confirmRemoveQueueItem(id) {
  openConfirm('remove', 'Remove prompt?', 'This prompt will be removed from the queue.', 'Yes, remove', true, { id });
}

export function stopServer() {
  openConfirm(
    'stop',
    'Stop server?',
    'This will stop the local web server and the Codex app-server. A running prompt will be interrupted.',
    'Yes, stop server',
    true,
  );
}

export function interruptPrompt() {
  openConfirm(
    'interrupt',
    'Interrupt prompt?',
    'The current running prompt will be interrupted. The queue will remain available after the turn stops.',
    'Yes, interrupt',
    true,
  );
}

export function forceSteerNote(text) {
  const status = state.snap?.rateLimits?.status || 'unknown';
  if (status !== 'available') {
    openConfirm(
      'force-steer',
      'Interrupt active prompt?',
      'The active prompt may not be able to continue after interruption because rate limits are currently unavailable. The current queue item will be marked as interrupted, and the correction may remain pending until limits are available.',
      'Interrupt anyway',
      true,
      { text },
    );
    return;
  }

  api('/api/control/steer-force', { text })
    .then((response) => {
      if (response.message) openMessage('Interrupt', response.message);
      getState().catch(reportError);
    })
    .catch(reportError);
}

export { addQueue };
