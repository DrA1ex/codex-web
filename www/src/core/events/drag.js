import { state } from '#core/state';
import { finishQueueDrag, setQueueDropMarker } from '#features/queue';
import { byId, toArray } from '#utils/dom';

function queueDragItemFromEvent(event) {
  return event.target?.closest?.('.queue-item[draggable="true"]') || null;
}

function suppressQueuePromptToggleClick() {
  state.suppressQueuePromptToggleUntil = Date.now() + 500;
}

function clearDraggingClass() {
  const queue = byId('queue');
  if (!queue) return;

  toArray(queue.querySelectorAll('.queue-item.dragging')).forEach((node) => node.classList.remove('dragging'));
}

export function attachQueueDragHandlers() {
  document.addEventListener('dragstart', (event) => {
    const item = queueDragItemFromEvent(event);
    if (!item) return;

    if (event.target.closest?.('button,textarea,select,input')) {
      event.preventDefault();
      return;
    }

    state.queueDragId = item.dataset.queueId;
    suppressQueuePromptToggleClick();
    item.classList.add('dragging');

    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', state.queueDragId);
    }
  });

  document.addEventListener('dragover', (event) => {
    if (!state.queueDragId) return;

    const item = event.target?.closest?.('.queue-item[data-queue-status="pending"]') || null;
    if (!item || item.dataset.queueId === state.queueDragId) return;

    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';

    const rect = item.getBoundingClientRect();
    setQueueDropMarker(item, event.clientY < rect.top + rect.height / 2);
  });

  document.addEventListener('drop', (event) => {
    if (!state.queueDragId) return;
    event.preventDefault();
    suppressQueuePromptToggleClick();
    finishQueueDrag();
  });

  document.addEventListener('dragend', () => {
    clearDraggingClass();
    suppressQueuePromptToggleClick();
    if (state.queueDragId) finishQueueDrag();
  });
}
