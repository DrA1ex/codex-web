import { state } from '#core/state';
import { esc, fmtCountdown } from '#utils/format';
import { byId, setHidden } from '#utils/dom';

function approvalCommand(params) {
  if (Array.isArray(params.command)) return params.command.join(' ');
  return params.command || '';
}

export function renderApproval() {
  const box = byId('approvalBox');
  const approval = state.snap?.approval;

  if (!box) return;
  if (!approval) {
    setHidden(box, true);
    box.innerHTML = '';
    return;
  }

  const params = approval.params || {};
  setHidden(box, false);
  box.innerHTML = `
    <div class="approval-modal">
      <div class="approval-head">
        <b>Approval required</b>
        <span>Auto-decline in <b>${esc(fmtCountdown(approval.expiresAt))}</b></span>
      </div>
      <pre>Method: ${esc(approval.method)}\nCommand: ${esc(approvalCommand(params) || '—')}\nCWD: ${esc(params.cwd || '—')}\nReason: ${esc(params.reason || '—')}</pre>
      <div class="actions">
        <button data-approval="accept" class="primary">Accept once</button>
        <button data-approval="accept-for-session">Accept for session</button>
        <button data-approval="decline">Decline</button>
        <button data-approval="cancel" class="danger">Cancel turn</button>
      </div>
    </div>
  `;
}
