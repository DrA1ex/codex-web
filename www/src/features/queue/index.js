import { state } from '#core/state';
import { api, getState, isNetworkError, writeOutputError } from '#core/api';
import { renderQueue, renderQueueItemById } from './render.js';
import { cancelQueueEdit, queueEditText, setQueueEditDraft, startQueueEdit } from './editor.js';

export { clearQueueScrollRequest, requestQueueScroll } from './scroll.js';
export { finishQueueDrag, setQueueDropMarker } from './drag.js';
export { renderQueue, renderQueueItemById, toggleQueueItemExpandedInDom } from './render.js';
export { queueMatchesFilter } from './status.js';
export { cancelQueueEdit, setQueueEditDraft, startQueueEdit } from './editor.js';


export function startQueueEditInDom(id, item) {
  if (!id) return;

  startQueueEdit(id, item);

  if (!renderQueueItemById(id, { restoreEditor: true })) {
    renderQueue();
  }
}

export function cancelQueueEditInDom(id) {
  if (!id) return;

  cancelQueueEdit(id);

  if (!renderQueueItemById(id)) {
    renderQueue();
  }
}

export async function saveQueueEdit(id) {
  if (!id || state.savingQueueEdits[id]) return;

  const item = (state.snap?.queue || []).find((queueItem) => queueItem.id === id);
  const text = queueEditText(id, item?.text || '');

  state.savingQueueEdits[id] = true;
  if (!renderQueueItemById(id, { restoreEditor: true })) renderQueue();

  try {
    const response = await api('/api/queue/update', { id, action: 'edit', text });
    const updatedItem = response?.item;

    if (updatedItem && Array.isArray(state.snap?.queue)) {
      const index = state.snap.queue.findIndex((queueItem) => queueItem.id === id);
      if (index >= 0) state.snap.queue[index] = updatedItem;
    }

    delete state.editDrafts[id];
    delete state.savingQueueEdits[id];
    if (state.editingQueueItemId === id) state.editingQueueItemId = null;

    if (updatedItem) {
      if (!renderQueueItemById(updatedItem.id || id)) renderQueue();
      return;
    }

    renderQueue();
    getState().catch((error) => {
      if (!isNetworkError(error)) writeOutputError(error);
    });
  } catch (error) {
    delete state.savingQueueEdits[id];
    state.editDrafts[id] = text;
    if (!renderQueueItemById(id, { restoreEditor: true })) renderQueue();
    if (!isNetworkError(error)) writeOutputError(error);
  }
}
