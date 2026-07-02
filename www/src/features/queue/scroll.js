import { state } from '#core/state';
import { byId, toArray } from '#utils/dom';

export function queueAnimationDisabled() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export function queueItemRects(container) {
  if (!container || queueAnimationDisabled()) return Object.create(null);

  return toArray(container.querySelectorAll('[data-queue-id]')).reduce((rects, node) => {
    rects[node.dataset.queueId] = node.getBoundingClientRect();
    return rects;
  }, Object.create(null));
}

export function animateQueueItems(container, oldRects) {
  if (!container || queueAnimationDisabled()) return;

  toArray(container.querySelectorAll('[data-queue-id]')).forEach((node) => {
    const oldRect = oldRects[node.dataset.queueId];

    if (!oldRect) {
      node.classList.add('queue-item-enter');
      requestAnimationFrame(() => node.classList.remove('queue-item-enter'));
      return;
    }

    const newRect = node.getBoundingClientRect();
    const dx = oldRect.left - newRect.left;
    const dy = oldRect.top - newRect.top;
    const heightDelta = oldRect.height - newRect.height;

    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(heightDelta) < 1) return;
    if (!node.animate) return;

    const animation = node.animate(
      [
        { transform: `translate(${dx}px, ${dy}px)`, height: `${oldRect.height}px` },
        { transform: 'translate(0, 0)', height: `${newRect.height}px` },
      ],
      { duration: state.queueMoveAnimationMs, easing: 'cubic-bezier(.2, .8, .2, 1)' },
    );

    node.style.overflow = 'hidden';
    animation.onfinish = animation.oncancel = () => {
      node.style.overflow = '';
    };
  });
}

function queueItemVisibleInPanel(item, panel) {
  if (!item || !panel) return false;

  const itemRect = item.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  return itemRect.top >= panelRect.top && itemRect.bottom <= panelRect.bottom;
}

function queueMoveSettleDelay() {
  return queueAnimationDisabled() ? 0 : state.queueMoveAnimationMs + 40;
}

export function clearQueueScrollRequest() {
  state.pendingQueueScrollId = null;
  state.pendingQueueScrollKind = '';
  state.pendingQueueScrollReady = false;
}

export function requestQueueScroll(id, kind = '', ready = false) {
  state.pendingQueueScrollId = id;
  state.pendingQueueScrollKind = kind;
  state.pendingQueueScrollReady = Boolean(ready);
}

function flashQueueItem(target) {
  if (!target) return;

  state.queueFlashId = target.dataset.queueId;
  target.classList.add('queue-item-flash');

  setTimeout(() => {
    target.classList.remove('queue-item-flash');
    if (state.queueFlashId === target.dataset.queueId) state.queueFlashId = null;
  }, 900);
}

export function scrollQueueItemAfterMove(id) {
  if (state.pendingQueueScrollTimer) clearTimeout(state.pendingQueueScrollTimer);

  state.pendingQueueScrollTimer = setTimeout(() => {
    state.pendingQueueScrollTimer = null;

    const container = byId('queue');
    const target = container && toArray(container.querySelectorAll('[data-queue-id]')).find((node) => node.dataset.queueId === id);
    if (!target) return;

    if (!queueItemVisibleInPanel(target, container)) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    flashQueueItem(target);
  }, queueMoveSettleDelay());
}
