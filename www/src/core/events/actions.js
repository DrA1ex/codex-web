import { api, getState, isNetworkError } from '#core/api';
import { state } from '#core/state';
import { addQueue, updateCounter } from '#features/composer';
import { clearQueueScrollRequest, renderQueue, requestQueueScroll } from '#features/queue';
import { openConfirm } from '#ui/confirm';
import { closeScheduleModal, scheduleInputIso } from '#ui/schedule';
import { setQueueMenuOpen } from '#ui/header';

export function reportError(error) {
  if (isNetworkError(error)) return;
  alert(error.message);
}

export function post(path, body) {
  return api(path, body).catch(reportError);
}

export function queueItemById(id) {
  return (state.snap?.queue || []).find((item) => item.id === id) || null;
}

export function closeQueueMenuIfOutside(target) {
  if (!target?.closest?.('.menu-wrap')) setQueueMenuOpen(false);
}

export function saveSchedule() {
  const scheduledRunAt = scheduleInputIso();
  if (!scheduledRunAt) {
    alert('Select a valid time.');
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
  api('/api/queue/undo')
    .then((response) => {
      if (state.composer && response.composerText !== undefined) state.composer.value = response.composerText;
      if (response.message) alert(response.message);
      updateCounter();
    })
    .catch(reportError);
}

export function toggleQueueMenu() {
  const menu = document.getElementById('queueMenu');
  setQueueMenuOpen(!(menu && !menu.classList.contains('hidden')));
}

export function clearPendingQueue() {
  setQueueMenuOpen(false);
  if (confirm('Clear all pending prompts?')) post('/api/queue/clear');
}

export function clearCompletedQueue() {
  setQueueMenuOpen(false);
  if (confirm('Clear all completed prompts?')) post('/api/queue/clear-completed');
}

export function scrollOutputToBottom() {
  if (state.outputEl) state.outputEl.scrollTop = state.outputEl.scrollHeight;
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

  if (app.state === 'countdown' || app.isManualSend) {
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

export { addQueue };
