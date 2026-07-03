import { state } from '#core/state';
import { finishQueueDrag, setQueueDropMarker } from '#features/queue';
import { byId, toArray } from '#utils/dom';

const TOUCH_DRAG_DELAY_MS = 420;
const TOUCH_DRAG_MOVE_TOLERANCE = 9;

let touchDragTimer = null;
let touchDragPointerId = null;
let touchDragStartX = 0;
let touchDragStartY = 0;
let touchDragCandidate = null;
let touchDragActive = false;

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

function isInteractiveDragTarget(target) {
  return Boolean(target?.closest?.('button,textarea,select,input,a,[role="menuitem"]'));
}

function pendingQueueItemAtPoint(x, y) {
  return document
    .elementFromPoint(x, y)
    ?.closest?.('.queue-item[data-queue-status="pending"]') || null;
}

function clearTouchDragTimer() {
  if (!touchDragTimer) return;
  clearTimeout(touchDragTimer);
  touchDragTimer = null;
}

function resetTouchDragState() {
  clearTouchDragTimer();
  if (touchDragCandidate) touchDragCandidate.classList.remove('drag-arming');
  touchDragPointerId = null;
  touchDragStartX = 0;
  touchDragStartY = 0;
  touchDragCandidate = null;
  touchDragActive = false;
  state.queueTouchDragId = null;
  document.body.classList.remove('queue-touch-dragging');
}

function armTouchQueueDrag(event, item) {
  touchDragPointerId = event.pointerId;
  touchDragStartX = event.clientX;
  touchDragStartY = event.clientY;
  touchDragCandidate = item;
  touchDragActive = false;
  state.queueTouchDragId = item.dataset.queueId;
  item.classList.add('drag-arming');

  clearTouchDragTimer();
  touchDragTimer = setTimeout(() => {
    touchDragTimer = null;
    if (
      !touchDragCandidate
      || !document.body.contains(touchDragCandidate)
      || state.queueTouchDragId !== touchDragCandidate.dataset.queueId
    ) {
      resetTouchDragState();
      return;
    }

    touchDragActive = true;
    state.queueDragId = touchDragCandidate.dataset.queueId;
    suppressQueuePromptToggleClick();
    touchDragCandidate.classList.remove('drag-arming');
    touchDragCandidate.classList.add('dragging');
    document.body.classList.add('queue-touch-dragging');

    try {
      touchDragCandidate.setPointerCapture?.(touchDragPointerId);
    } catch {
      // Pointer capture can fail when the browser already cancelled this touch.
    }
  }, TOUCH_DRAG_DELAY_MS);
}

function cancelTouchQueueDrag({ finish = false } = {}) {
  const wasActive = touchDragActive;
  clearDraggingClass();
  resetTouchDragState();

  if (finish && wasActive && state.queueDragId) {
    suppressQueuePromptToggleClick();
    finishQueueDrag();
    return;
  }

  if (state.queueDragId && wasActive) {
    suppressQueuePromptToggleClick();
    finishQueueDrag();
  }
}

function updateTouchQueueDrag(event) {
  const target = pendingQueueItemAtPoint(event.clientX, event.clientY);
  if (!target || target.dataset.queueId === state.queueDragId) return;

  const rect = target.getBoundingClientRect();
  setQueueDropMarker(target, event.clientY < rect.top + rect.height / 2);
}

function attachQueueTouchDragHandlers() {
  document.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
    if (touchDragPointerId != null || isInteractiveDragTarget(event.target)) return;

    const item = queueDragItemFromEvent(event);
    if (!item) return;

    armTouchQueueDrag(event, item);
  });

  document.addEventListener('pointermove', (event) => {
    if (event.pointerId !== touchDragPointerId) return;

    if (!touchDragActive) {
      const dx = event.clientX - touchDragStartX;
      const dy = event.clientY - touchDragStartY;
      if (Math.hypot(dx, dy) > TOUCH_DRAG_MOVE_TOLERANCE) resetTouchDragState();
      return;
    }

    event.preventDefault();
    suppressQueuePromptToggleClick();
    updateTouchQueueDrag(event);
  }, { passive: false });

  document.addEventListener('pointerup', (event) => {
    if (event.pointerId !== touchDragPointerId) return;
    if (!touchDragActive) {
      resetTouchDragState();
      return;
    }

    event.preventDefault();
    cancelTouchQueueDrag({ finish: true });
  }, { passive: false });

  document.addEventListener('pointercancel', (event) => {
    if (event.pointerId !== touchDragPointerId) return;
    cancelTouchQueueDrag();
  });
}

export function attachQueueDragHandlers() {
  attachQueueTouchDragHandlers();

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
