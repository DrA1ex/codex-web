import { state } from '#core/state';
import { byId } from '#utils/dom';

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

export function startQueueEdit(id, item) {
  state.editingQueueItemId = id;
  state.editDrafts[id] = item?.text || '';
  state.pendingEditFocusId = id;
  state.expandedQueueItems[id] = true;
}

export function cancelQueueEdit(id) {
  delete state.editDrafts[id];
  state.editingQueueItemId = null;
}

export function setQueueEditDraft(id, value) {
  state.editDrafts[id] = value;
}

export function queueEditText(id, fallback = '') {
  const editor = document.querySelector('[data-edit-text]');

  if (editor?.dataset.editText === id) {
    state.editDrafts[id] = editor.value;
    return editor.value;
  }

  return hasOwn(state.editDrafts, id) ? state.editDrafts[id] : fallback;
}

export function queueDraftValue(id, fallback = '') {
  return hasOwn(state.editDrafts, id) ? state.editDrafts[id] : fallback;
}

export function captureActiveEditor() {
  const activeElement = document.activeElement;
  if (!activeElement?.dataset?.editText) return null;

  state.editDrafts[activeElement.dataset.editText] = activeElement.value;

  return {
    id: activeElement.dataset.editText,
    value: activeElement.value,
    start: activeElement.selectionStart,
    end: activeElement.selectionEnd,
    scrollTop: activeElement.scrollTop,
  };
}

export function restoreActiveEditor(container, activeEditor) {
  if (!state.editingQueueItemId) return;

  const editor = container.querySelector('[data-edit-text]');
  const shouldFocus = state.pendingEditFocusId === state.editingQueueItemId || activeEditor?.id === state.editingQueueItemId;
  if (!editor || !shouldFocus) return;

  if (activeEditor?.id === state.editingQueueItemId) {
    editor.value = activeEditor.value;
    state.editDrafts[state.editingQueueItemId] = activeEditor.value;
  }

  editor.focus();

  if (state.pendingEditFocusId === state.editingQueueItemId) {
    editor.selectionStart = editor.selectionEnd = editor.value.length;
    state.pendingEditFocusId = null;
    return;
  }

  if (activeEditor?.id === state.editingQueueItemId) {
    editor.selectionStart = activeEditor.start;
    editor.selectionEnd = activeEditor.end;
    editor.scrollTop = activeEditor.scrollTop;
  }
}

export function queueContainer() {
  return byId('queue');
}
