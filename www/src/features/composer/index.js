import { state } from '#core/state';
import { api, getState, isNetworkError } from '#core/api';
import { setButtonState } from '#ui/header';
import { requestQueueScroll } from '#features/queue';

function applyComposerResponse(response) {
  const composer = state.composer;
  if (!composer) return;

  if (response.clearComposer) composer.value = '';
  if (response.composerText !== undefined) composer.value = response.composerText;
}

function handleComposerError(error) {
  if (isNetworkError(error)) return;
  alert(error.message);
}

export function updateCounter() {
  const composer = state.composer;
  if (!composer) return;

  const text = composer.value;
  const lines = text ? text.split(/\r?\n/).length : 0;
  const counter = document.getElementById('counter');

  if (counter) counter.textContent = `Lines: ${lines} · Chars: ${text.length}`;
  setButtonState('addBtn', !text.trim(), false);
}

export async function addQueue() {
  const response = await api('/api/queue/add', { text: state.composer?.value || '' }).catch(handleComposerError);
  if (!response) return;

  if (response.item?.id) requestQueueScroll(response.item.id, '', true);
  applyComposerResponse(response);
  if (response.message) alert(response.message);
  updateCounter();
  getState().catch(handleComposerError);
}

export async function sendComposerNow() {
  const response = await api('/api/queue/send-composer', { text: state.composer?.value || '' }).catch(handleComposerError);
  if (!response) return;

  applyComposerResponse(response);
  if (response.message) alert(response.message);
  updateCounter();
  getState().catch(handleComposerError);
}
