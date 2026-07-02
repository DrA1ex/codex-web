import { state } from '#core/state';
import { api, getState, isNetworkError } from '#core/api';
import { byId, toArray } from '#utils/dom';

export function clearQueueDropMarker() {
  state.queueDropBeforeId = undefined;

  const container = byId('queue');
  if (!container) return;

  toArray(container.querySelectorAll('.queue-item.drop-before, .queue-item.drop-after')).forEach((node) => {
    node.classList.remove('drop-before', 'drop-after');
  });
}

function pendingQueueIdsFromDom() {
  const container = byId('queue');
  if (!container) return [];

  return toArray(container.querySelectorAll('.queue-item[data-queue-status="pending"]')).map((node) => node.dataset.queueId);
}

export function setQueueDropMarker(target, before) {
  clearQueueDropMarker();
  if (!target) return;

  target.classList.add(before ? 'drop-before' : 'drop-after');

  if (before) {
    state.queueDropBeforeId = target.dataset.queueId;
    return;
  }

  const ids = pendingQueueIdsFromDom();
  const index = ids.indexOf(target.dataset.queueId);
  state.queueDropBeforeId = index >= 0 && index + 1 < ids.length ? ids[index + 1] : '';
}

export function finishQueueDrag() {
  const id = state.queueDragId;
  const beforeId = state.queueDropBeforeId;

  state.queueDragId = null;
  clearQueueDropMarker();

  if (id == null || beforeId === undefined || beforeId === id) return;

  api('/api/queue/reorder', { id, beforeId: beforeId || null }).catch((error) => {
    if (!isNetworkError(error)) alert(error.message);
    getState().catch(() => {});
  });
}
