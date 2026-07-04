import { state } from '#core/state';
import { api, getState, isNetworkError } from '#core/api';
import { esc } from '#utils/format';
import { byId, setHidden } from '#utils/dom';

const CONFIRM_ACTIONS = {
  interrupt: () => api('/api/control/interrupt').then((result) => {
    if (result.message) alert(result.message);
  }),
  'force-steer': ({ text }) => api('/api/control/steer-force', { text }).then((result) => {
    if (result.message) alert(result.message);
    return getState();
  }),
  stop: () => api('/api/control/stop'),
  remove: ({ id }) => api('/api/queue/remove', { id }),
};

export function openConfirm(action, title, message, yesText, danger, data = {}) {
  state.confirmAction = { action, title, message, yesText, danger: Boolean(danger), data };
  renderConfirm();
}

export function closeConfirm() {
  state.confirmAction = null;
  renderConfirm();
}

export function renderConfirm() {
  const box = byId('confirmBox');
  if (!box) return;

  if (!state.confirmAction) {
    setHidden(box, true);
    box.innerHTML = '';
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
    if (!isNetworkError(error)) alert(error.message);
  });
}
