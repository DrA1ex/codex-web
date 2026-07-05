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
import { closeHelp, toggleHelpCommand } from '#ui/help';
import {
  closeLimitResetModal,
  confirmLimitReset,
  openLimitResetModal,
  requestLimitResetAgain,
} from '#ui/limit-reset';
import { closeScheduleModal, openScheduleModal } from '#ui/schedule';
import { hideStatusNotice, renderHeader, setMobileCollapsed } from '#ui/header';
import {
  addQueue,
  clearOutputFromMenu,
  clearCompletedQueue,
  clearPendingQueue,
  closeQueueMenuIfOutside,
  confirmRemoveQueueItem,
  copyVisibleOutput,
  copyVisibleOutputFromMenu,
  forceSteerNote,
  interruptPrompt,
  loadCompletedArchiveMore,
  loadPreviousOutputGroup,
  post,
  reportError,
  queueItemById,
  saveSchedule,
  scrollOutputToBottom,
  scrollOutputToBottomFromMenu,
  sendQueueItemNow,
  stopServer,
  toggleOutputMenu,
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
  '[data-output-tool]',
  '[data-output-group]',
  '[data-output-history-more]',
  '[data-force-steer]',
  '[data-help-command]',
  '[data-toggle-prompt]',
  '#statusNotice',
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
  undoMenuBtn: undoQueue,
  queueMenuBtn: toggleQueueMenu,
  outputMenuBtn: toggleOutputMenu,
  clearBtn: clearPendingQueue,
  clearCompletedBtn: clearCompletedQueue,
  stopBtn: stopServer,
  confirmCancelBtn: closeConfirm,
  confirmYesBtn: confirmCurrentAction,
  helpCloseBtn: closeHelp,
  limitResetOpenBtn: openLimitResetModal,
  limitResetCancelBtn: closeLimitResetModal,
  limitResetConfirmBtn: confirmLimitReset,
  limitResetRequestBtn: requestLimitResetAgain,
  scheduleCloseBtn: closeScheduleModal,
  scheduleSaveBtn: saveSchedule,
  scheduleCancelQueueBtn: () => api('/api/queue/cancel-run')
    .then(() => {
      closeScheduleModal();
      getState().catch(reportError);
    })
    .catch(reportError),
  bottomBtn: scrollOutputToBottom,
  bottomMenuBtn: scrollOutputToBottomFromMenu,
  copyOutputBtn: copyVisibleOutput,
  copyOutputMenuBtn: copyVisibleOutputFromMenu,
  clearOutputMenuBtn: clearOutputFromMenu,
  themeBtn: toggleTheme,
};

const MOBILE_MENU_ACTION_DELAY_MS = 170;

function normalizedClickTarget(event) {
  const rawTarget = event.target?.nodeType === Node.TEXT_NODE ? event.target.parentElement : event.target;
  return rawTarget?.closest?.(CLICK_TARGET_SELECTOR) || rawTarget;
}

function isMobileFloatingMenuAction(target) {
  return Boolean(target?.closest?.('.queue-menu.mobile-menu-floating'));
}

function runClickAction(target, event) {
  return handlePromptToggle(target, event) ||
    handleQueueFilter(target) ||
    handleOutputDiffToggle(target) ||
    handleOutputToolToggle(target) ||
    handleOutputGroupToggle(target) ||
    handleOutputHistoryMore(target) ||
    handleCompletedArchiveMore(target) ||
    handleForceSteer(target) ||
    handleHelpCommand(target) ||
    handleStatusNotice(target) ||
    handleMobileCollapse(target) ||
    handleButton(target) ||
    handleSessionAction(target) ||
    handleApprovalAction(target) ||
    handleQueueItemAction(target);
}

function handleHelpCommand(target) {
  const commandButton = target?.closest?.('[data-help-command]');
  const index = commandButton?.dataset?.helpCommand;
  if (index === undefined) return false;
  toggleHelpCommand(index);
  return true;
}

function handleCompletedArchiveMore(target) {
  const control = target?.closest?.('[data-completed-archive-more]');
  if (!control) return false;

  const targetLevel = Number(control.dataset.completedArchiveLevel);
  state.completedQueueArchiveLevel = Number.isFinite(targetLevel)
    ? Math.max(0, targetLevel)
    : state.completedQueueArchiveLevel + 1;
  loadCompletedArchiveMore().catch(reportError);
  renderQueue();
  return true;
}

function handleForceSteer(target) {
  const id = target?.dataset?.forceSteer;
  if (!id) return false;
  const entry = (state.snap?.output || []).find((line) => line.id === id);
  const text = entry?.steer?.text || '';
  if (!text) return true;
  forceSteerNote(text);
  return true;
}

function delayMobileMenuAction(target, event) {
  if (!isMobileFloatingMenuAction(target)) return false;

  event.preventDefault();
  event.stopPropagation();
  target.classList.add('menu-action-pressed');
  window.setTimeout(() => {
    runClickAction(target, event);
    target.classList.remove('menu-action-pressed');
  }, MOBILE_MENU_ACTION_DELAY_MS);

  return true;
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

function handleOutputToolToggle(target) {
  const toggle = target.closest?.('[data-output-tool]');
  if (!toggle || toggle.disabled) return false;

  state.expandedToolOutput[toggle.dataset.outputTool] = !state.expandedToolOutput[toggle.dataset.outputTool];
  renderOutput();
  return true;
}

function handleOutputGroupToggle(target) {
  const toggle = target.closest?.('[data-output-group]');
  if (!toggle) return false;

  state.expandedOutputGroups[toggle.dataset.outputGroup] = !state.expandedOutputGroups[toggle.dataset.outputGroup];
  renderOutput();
  return true;
}

function handleOutputHistoryMore(target) {
  const control = target.closest?.('[data-output-history-more]');
  if (!control || control.disabled) return false;
  loadPreviousOutputGroup().catch(reportError);
  return true;
}

function handleMobileCollapse(target) {
  const button = target.closest?.('#headerCollapseBtn, #limitsCollapseBtn, #queueCollapseBtn, #outputCollapseBtn');
  if (!button) return false;

  const sectionById = {
    headerCollapseBtn: 'header',
    limitsCollapseBtn: 'limits',
    queueCollapseBtn: 'queue',
    outputCollapseBtn: 'output',
  };
  const section = sectionById[button.id];

  if (section) setMobileCollapsed(section, !state.mobileCollapsed[section]);
  return true;
}

function handleStatusNotice(target) {
  if (!target.closest?.('#statusNotice')) return false;
  hideStatusNotice();
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

    if (delayMobileMenuAction(target, event)) return;

    runClickAction(target, event);
  });
}
