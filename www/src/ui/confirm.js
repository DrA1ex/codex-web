import { state } from '#core/state';
import { api, getState, isNetworkError, writeOutputError } from '#core/api';
import { esc } from '#utils/format';
import { byId, setHidden } from '#utils/dom';

const CONFIRM_ACTIONS = {
  interrupt: () => api('/api/control/interrupt').then((result) => {
    if (result.message) openMessage('Interrupt', result.message);
  }),
  'force-steer': ({ text }) => api('/api/control/steer-force', { text }).then((result) => {
    if (result.message) openMessage('Interrupt', result.message);
    return getState();
  }),
  'clear-pending': () => api('/api/queue/clear'),
  'clear-completed': () => api('/api/queue/clear-completed'),
  stop: () => api('/api/control/stop'),
  remove: ({ id }) => api('/api/queue/remove', { id }),
};

export function openConfirm(action, title, message, yesText, danger, data = {}) {
  state.confirmAction = { action, title, message, yesText, danger: Boolean(danger), data };
  state.modalMessage = null;
  renderConfirm();
}

export function openMessage(title, message, kind = 'info') {
  state.confirmAction = null;
  state.modalMessage = { title, message, kind };
  renderConfirm();
}

export function closeConfirm() {
  state.confirmAction = null;
  state.modalMessage = null;
  renderConfirm();
}

export function renderConfirm() {
  const box = byId('confirmBox');
  if (!box) return;

  if (!state.confirmAction && !state.modalMessage) {
    setHidden(box, true);
    box.innerHTML = '';
    return;
  }

  if (state.modalMessage) {
    const current = state.modalMessage;
    setHidden(box, false);
    box.innerHTML = `
      <div class="confirm-modal message-modal ${esc(current.kind || 'info')}" role="dialog" aria-modal="true" aria-labelledby="messageTitle">
        <div class="confirm-head"><b id="messageTitle">${esc(current.title || 'Message')}</b></div>
        <p>${esc(current.message)}</p>
        <div class="actions">
          <button id="confirmCancelBtn" class="primary">OK</button>
        </div>
      </div>
    `;
    return;
  }

  const current = state.confirmAction;
  setHidden(box, false);
  box.innerHTML = `
    <div class="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirmTitle">
      <div class="confirm-head"><b id="confirmTitle">${esc(current.title)}</b></div>
      <p>${esc(current.message)}</p>
      <div class="actions">
        <button id="confirmYesBtn" class="${current.danger ? 'danger' : 'primary'}">${esc(current.yesText || 'Yes')}</button>
        <button id="confirmCancelBtn">Cancel</button>
      </div>
    </div>
  `;
}

export function confirmCurrentAction() {
  const current = state.confirmAction;
  if (!current) return;

  closeConfirm();

  const handler = CONFIRM_ACTIONS[current.action];
  if (!handler) return;

  handler(current.data).catch((error) => {
    if (!isNetworkError(error)) writeOutputError(error);
  });
}
