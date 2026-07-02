import { api, getState } from '#core/api';
import { state } from '#core/state';
import { renderOutput } from '#features/output';
import {
  cancelQueueEditInDom,
  renderQueue,
  saveQueueEdit,
  startQueueEditInDom,
  toggleQueueItemExpandedInDom,
} from '#features/queue';
import { closeConfirm, confirmCurrentAction } from '#ui/confirm';
import { closeScheduleModal, openScheduleModal } from '#ui/schedule';
import { renderHeader, setMobileCollapsed } from '#ui/header';
import {
  addQueue,
  clearCompletedQueue,
  clearPendingQueue,
  closeQueueMenuIfOutside,
  confirmRemoveQueueItem,
  interruptPrompt,
  post,
  reportError,
  queueItemById,
  saveSchedule,
  scrollOutputToBottom,
  sendQueueItemNow,
  stopServer,
  toggleQueueMenu,
  toggleTheme,
  undoQueue,
  updateQueueItem,
} from './actions.js';

const CLICK_TARGET_SELECTOR = [
  'button',
  '[data-act]',
  '[data-session]',
  '[data-approval]',
  '[data-queue-filter]',
  '[data-output-diff]',
  '[data-toggle-prompt]',
].join(',');

const SIMPLE_POST_ACTIONS = {
  cancelSendBtn: '/api/control/cancel-send',
  pauseBtn: '/api/control/pause',
  resumeBtn: '/api/control/resume',
  clearOutputBtn: '/api/output/clear',
  createSessionBtn: '/api/session/create',
  reloadSessionsBtn: '/api/session/reload',
  changeSessionBtn: '/api/session/reload',
  cancelSessionChangeBtn: '/api/session/cancel-change',
};

const BUTTON_ACTIONS = {
  addBtn: addQueue,
  scheduleBtn: openScheduleModal,
  interruptBtn: interruptPrompt,
  undoBtn: undoQueue,
  queueMenuBtn: toggleQueueMenu,
  clearBtn: clearPendingQueue,
  clearCompletedBtn: clearCompletedQueue,
  stopBtn: stopServer,
  confirmCancelBtn: closeConfirm,
  confirmYesBtn: confirmCurrentAction,
  scheduleCloseBtn: closeScheduleModal,
  scheduleSaveBtn: saveSchedule,
  scheduleCancelQueueBtn: () => api('/api/queue/cancel-run')
    .then(() => {
      closeScheduleModal();
      getState().catch(reportError);
    })
    .catch(reportError),
  bottomBtn: scrollOutputToBottom,
  themeBtn: toggleTheme,
};

function normalizedClickTarget(event) {
  const rawTarget = event.target?.nodeType === Node.TEXT_NODE ? event.target.parentElement : event.target;
  return rawTarget?.closest?.(CLICK_TARGET_SELECTOR) || rawTarget;
}

function shouldSuppressPromptToggle() {
  if (!state.suppressQueuePromptToggleUntil) return false;

  const shouldSuppress = Date.now() < state.suppressQueuePromptToggleUntil;
  if (shouldSuppress) state.suppressQueuePromptToggleUntil = 0;
  return shouldSuppress;
}

function handlePromptToggle(target, event) {
  if (event.target?.closest?.('.queue-drag-handle')) return false;

  const toggle = target.closest?.('[data-toggle-prompt]');
  if (!toggle) return false;

  if (shouldSuppressPromptToggle()) return true;

  toggleQueueItemExpandedInDom(toggle.dataset.id);

  return true;
}

function handleQueueFilter(target) {
  const filter = target.closest?.('[data-queue-filter]');
  if (!filter) return false;

  state.activeQueueFilter = filter.dataset.queueFilter;
  renderHeader();
  renderQueue();
  return true;
}

function handleOutputDiffToggle(target) {
  const toggle = target.closest?.('[data-output-diff]');
  if (!toggle) return false;

  state.expandedDiffOutput[toggle.dataset.outputDiff] = !state.expandedDiffOutput[toggle.dataset.outputDiff];
  renderOutput();
  return true;
}

function handleMobileCollapse(target) {
  const button = target.closest?.('#headerCollapseBtn, #limitsCollapseBtn, #queueCollapseBtn');
  if (!button) return false;

  const sectionById = {
    headerCollapseBtn: 'header',
    limitsCollapseBtn: 'limits',
    queueCollapseBtn: 'queue',
  };
  const section = sectionById[button.id];

  if (section) setMobileCollapsed(section, !state.mobileCollapsed[section]);
  return true;
}

function handleButton(target) {
  const action = BUTTON_ACTIONS[target.id];
  if (action) {
    action(target);
    return true;
  }

  const postPath = SIMPLE_POST_ACTIONS[target.id];
  if (postPath) {
    post(postPath);
    return true;
  }

  return false;
}

function handleSessionAction(target) {
  if (!target.dataset.session) return false;
  post('/api/session/select', { sessionId: target.dataset.session });
  return true;
}

function handleApprovalAction(target) {
  if (!target.dataset.approval) return false;
  post('/api/approval/respond', { decision: target.dataset.approval });
  return true;
}

function handleQueueItemAction(target) {
  const { act, id } = target.dataset || {};
  if (!act) return false;

  const item = queueItemById(id);

  if (act === 'remove') confirmRemoveQueueItem(id);
  else if (act === 'edit') {
    startQueueEditInDom(id, item);
  } else if (act === 'cancelEdit') {
    cancelQueueEditInDom(id);
  } else if (act === 'saveEdit') {
    saveQueueEdit(id);
  } else if (act === 'sendNow') {
    sendQueueItemNow(id);
  } else {
    updateQueueItem(id, act);
  }

  return true;
}

export function attachClickHandlers() {
  document.addEventListener('click', (event) => {
    const target = normalizedClickTarget(event);
    if (!target) return;

    closeQueueMenuIfOutside(target);

    handlePromptToggle(target, event) ||
      handleQueueFilter(target) ||
      handleOutputDiffToggle(target) ||
      handleMobileCollapse(target) ||
      handleButton(target) ||
      handleSessionAction(target) ||
      handleApprovalAction(target) ||
      handleQueueItemAction(target);
  });
}
