import { api } from '#core/api';
import { state } from '#core/state';
import { sendComposerNow } from '#features/composer';
import { cancelQueueEdit, renderQueue, saveQueueEdit, toggleQueueItemExpandedInDom } from '#features/queue';
import { closeConfirm, confirmCurrentAction } from '#ui/confirm';
import { closeScheduleModal } from '#ui/schedule';
import { setQueueMenuOpen } from '#ui/header';
import { saveSchedule } from './actions.js';

function queueMenuIsOpen() {
  const menu = document.getElementById('queueMenu');
  return menu && !menu.classList.contains('hidden');
}

function cancelOrPause() {
  if (state.editingQueueItemId) {
    cancelQueueEdit(state.editingQueueItemId);
    renderQueue();
    return;
  }

  const path = state.snap?.app?.state === 'countdown' ? '/api/control/cancel-send' : '/api/control/pause';
  api(path).catch((error) => alert(error.message));
}

function handleEscape(event) {
  if (state.scheduleOpen) {
    event.preventDefault();
    closeScheduleModal();
    return;
  }

  if (state.confirmAction) {
    event.preventDefault();
    closeConfirm();
    return;
  }

  if (queueMenuIsOpen()) {
    event.preventDefault();
    setQueueMenuOpen(false);
    return;
  }

  event.preventDefault();
  cancelOrPause();
}

function handlePromptPreviewKey(event, target) {
  if (!target?.dataset?.togglePrompt || (event.key !== 'Enter' && event.key !== ' ')) return false;

  event.preventDefault();
  toggleQueueItemExpandedInDom(target.dataset.id);

  return true;
}

export function attachKeyboardHandlers() {
  document.addEventListener('keydown', (event) => {
    const target = event.target;

    if (event.key === 'Escape') {
      handleEscape(event);
      return;
    }

    if (state.scheduleOpen && event.key === 'Enter' && target?.tagName !== 'BUTTON') {
      event.preventDefault();
      saveSchedule();
      return;
    }

    if (state.confirmAction && event.key === 'Enter') {
      event.preventDefault();
      confirmCurrentAction();
      return;
    }

    if (target?.dataset?.editText && (event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      saveQueueEdit(target.dataset.editText);
      return;
    }

    handlePromptPreviewKey(event, target);
  });

  if (state.composer) {
    state.composer.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        sendComposerNow();
      }
    });
  }
}
