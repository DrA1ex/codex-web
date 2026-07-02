import { state } from '#core/state';
import { api } from '#core/api';
import { esc } from '#utils/format';

export function openConfirm(action, title, message, yesText, danger, data){
  state.confirmAction = { action:action, title:title, message:message, yesText:yesText, danger:!!danger, data:data || {} };
  renderConfirm();
}

export function closeConfirm(){
  state.confirmAction = null;
  renderConfirm();
}

export function renderConfirm(){
  var box = document.getElementById('confirmBox');
  if(!box) return;
  if(!state.confirmAction) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  var confirmAction = state.confirmAction;
  box.classList.remove('hidden');
  box.innerHTML = '<div class="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirmTitle"><div class="confirm-head"><b id="confirmTitle">' + esc(confirmAction.title) + '</b></div><p>' + esc(confirmAction.message) + '</p><div class="actions"><button id="confirmYesBtn" class="' + (confirmAction.danger ? 'danger' : 'primary') + '">' + esc(confirmAction.yesText || 'Yes') + '</button><button id="confirmCancelBtn">Cancel</button></div></div>';
}

export function confirmCurrentAction(){
  var action = state.confirmAction && state.confirmAction.action;
  var data = state.confirmAction && state.confirmAction.data || {};
  closeConfirm();
  if(action === 'interrupt') api('/api/control/interrupt').then(function(r){ if(r.message) alert(r.message); }).catch(function(e){ alert(e.message); });
  else if(action === 'stop') api('/api/control/stop').catch(function(e){ alert(e.message); });
  else if(action === 'remove') api('/api/queue/remove', { id:data.id }).catch(function(e){ alert(e.message); });
}
