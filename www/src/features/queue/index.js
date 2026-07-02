import { state } from '#core/state';
import { api, getState } from '#core/api';
import { renderQueue } from './render.js';
import { cancelQueueEdit, queueEditText, setQueueEditDraft, startQueueEdit } from './editor.js';

export { clearQueueScrollRequest, requestQueueScroll } from './scroll.js';
export { finishQueueDrag, setQueueDropMarker } from './drag.js';
export { renderQueue } from './render.js';
export { queueMatchesFilter } from './status.js';
export { cancelQueueEdit, setQueueEditDraft, startQueueEdit } from './editor.js';

export async function saveQueueEdit(id) {
  if (!id || state.savingQueueEdits[id]) return;

  const item = (state.snap?.queue || []).find((queueItem) => queueItem.id === id);
  const text = queueEditText(id, item?.text || '');

  state.savingQueueEdits[id] = true;
  renderQueue();

  try {
    const response = await api('/api/queue/update', { id, action: 'edit', text });

    if (response?.item && Array.isArray(state.snap?.queue)) {
      const index = state.snap.queue.findIndex((queueItem) => queueItem.id === id);
      if (index >= 0) state.snap.queue[index] = response.item;
    }

    delete state.editDrafts[id];
    delete state.savingQueueEdits[id];
    if (state.editingQueueItemId === id) state.editingQueueItemId = null;

    renderQueue();
    getState();
  } catch (error) {
    delete state.savingQueueEdits[id];
    state.editDrafts[id] = text;
    renderQueue();
    alert(error.message);
  }
}
