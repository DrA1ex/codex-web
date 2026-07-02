import { state } from '#core/state';
import { esc, fmtCountdown } from '#utils/format';

export function renderApproval(){
  var box = document.getElementById('approvalBox');
  var a = state.snap && state.snap.approval;
  if(!box) return;
  if(!a){
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  var p = a.params || {};
  var cmd = Array.isArray(p.command) ? p.command.join(' ') : (p.command || '');
  box.classList.remove('hidden');
  box.innerHTML = '<div class="approval-modal"><div class="approval-head"><b>Approval required</b><span>Auto-decline in <b>' + esc(fmtCountdown(a.expiresAt)) + '</b></span></div><pre>Method: ' + esc(a.method) + '\nCommand: ' + esc(cmd || '—') + '\nCWD: ' + esc(p.cwd || '—') + '\nReason: ' + esc(p.reason || '—') + '</pre><div class="actions"><button data-approval="accept" class="primary">Accept once</button><button data-approval="accept-for-session">Accept for session</button><button data-approval="decline">Decline</button><button data-approval="cancel" class="danger">Cancel turn</button></div></div>';
}
