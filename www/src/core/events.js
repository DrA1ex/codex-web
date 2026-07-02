import { state } from '#core/state';
import { api, getState } from '#core/api';
import { renderHeader } from '#ui/header';
import { setMobileCollapsed, setQueueMenuOpen } from '#ui/header';
import { closeConfirm, confirmCurrentAction, openConfirm } from '#ui/confirm';
import { closeScheduleModal, openScheduleModal, scheduleInputIso, updateScheduleDraft } from '#ui/schedule';
import { addQueue, sendComposerNow, updateCounter } from '#features/composer';
import { clearQueueScrollRequest, finishQueueDrag, renderQueue, requestQueueScroll, saveQueueEdit, setQueueDropMarker } from '#features/queue';
import { renderOutput } from '#features/output';

export function attachEventHandlers(){
  document.addEventListener('click', function(ev){
    var rawTarget = ev.target && ev.target.nodeType === 3 ? ev.target.parentElement : ev.target;
    var t = rawTarget && rawTarget.closest ? (rawTarget.closest('button,[data-act],[data-session],[data-approval],[data-queue-filter],[data-output-diff],[data-toggle-prompt]') || rawTarget) : rawTarget;
    var queueMenuWrap = t.closest && t.closest('.menu-wrap');
    if(!queueMenuWrap) setQueueMenuOpen(false);

    var promptToggle = t.closest && t.closest('[data-toggle-prompt]');
    if(promptToggle) {
      var promptId = promptToggle.dataset.id;
      var itemForToggle = ((state.snap && state.snap.queue) || []).find(function(x){return x.id === promptId;});
      if(itemForToggle) {
        state.expandedQueueItems[promptId] = !state.expandedQueueItems[promptId];
        renderQueue();
      }
      return;
    }

    var queueFilter = t.closest && t.closest('[data-queue-filter]');
    if(queueFilter) {
      state.activeQueueFilter = queueFilter.dataset.queueFilter;
      renderHeader();
      renderQueue();
      return;
    }

    var diffToggle = t.closest && t.closest('[data-output-diff]');
    if(diffToggle) {
      state.expandedDiffOutput[diffToggle.dataset.outputDiff] = !state.expandedDiffOutput[diffToggle.dataset.outputDiff];
      renderOutput();
      return;
    }

    var mobileCollapseBtn = t.closest && t.closest('#headerCollapseBtn, #limitsCollapseBtn, #queueCollapseBtn');
    if(mobileCollapseBtn) {
      if(mobileCollapseBtn.id === 'headerCollapseBtn') setMobileCollapsed('header', !state.mobileCollapsed.header);
      else if(mobileCollapseBtn.id === 'limitsCollapseBtn') setMobileCollapsed('limits', !state.mobileCollapsed.limits);
      else if(mobileCollapseBtn.id === 'queueCollapseBtn') setMobileCollapsed('queue', !state.mobileCollapsed.queue);
    }
    else if(t.id === 'addBtn') addQueue();
    else if(t.id === 'cancelSendBtn') api('/api/control/cancel-send');
    else if(t.id === 'pauseBtn') api('/api/control/pause');
    else if(t.id === 'resumeBtn') api('/api/control/resume');
    else if(t.id === 'scheduleBtn') openScheduleModal();
    else if(t.id === 'interruptBtn') openConfirm('interrupt', 'Interrupt prompt?', 'The current running prompt will be interrupted. The queue will remain available after the turn stops.', 'Yes, interrupt', true);
    else if(t.id === 'undoBtn') api('/api/queue/undo').then(function(r){ if(state.composer && r.composerText !== undefined) state.composer.value = r.composerText; if(r.message) alert(r.message); updateCounter(); });
    else if(t.id === 'queueMenuBtn') {
      var menu = document.getElementById('queueMenu');
      setQueueMenuOpen(!(menu && !menu.classList.contains('hidden')));
    }
    else if(t.id === 'clearBtn') { setQueueMenuOpen(false); if(confirm('Clear all pending prompts?')) api('/api/queue/clear'); }
    else if(t.id === 'clearCompletedBtn') { setQueueMenuOpen(false); if(confirm('Clear all completed prompts?')) api('/api/queue/clear-completed'); }
    else if(t.id === 'stopBtn') openConfirm('stop', 'Stop server?', 'This will stop the local web server and the Codex app-server. A running prompt will be interrupted.', 'Yes, stop server', true);
    else if(t.id === 'confirmCancelBtn') closeConfirm();
    else if(t.id === 'confirmYesBtn') confirmCurrentAction();
    else if(t.id === 'scheduleCloseBtn') closeScheduleModal();
    else if(t.id === 'scheduleSaveBtn') {
      var scheduledRunAt = scheduleInputIso();
      if(!scheduledRunAt) { alert('Select a valid time.'); return; }
      api('/api/queue/schedule', { scheduledRunAt:scheduledRunAt }).then(function(){ closeScheduleModal(); getState(); }).catch(function(e){ alert(e.message); });
    }
    else if(t.id === 'scheduleCancelQueueBtn') api('/api/queue/cancel-run').then(function(){ closeScheduleModal(); getState(); }).catch(function(e){ alert(e.message); });
    else if(t.id === 'clearOutputBtn') api('/api/output/clear');
    else if(t.id === 'bottomBtn' && state.outputEl) state.outputEl.scrollTop = state.outputEl.scrollHeight;
    else if(t.id === 'themeBtn') {
      var nextTheme = state.snap && state.snap.app && state.snap.app.theme === 'light' ? 'dark' : 'light';
      api('/api/config/theme', { theme:nextTheme }).catch(function(e){ alert(e.message); });
    }
    else if(t.id === 'createSessionBtn') api('/api/session/create').catch(function(e){ alert(e.message); });
    else if(t.id === 'reloadSessionsBtn') api('/api/session/reload');
    else if(t.id === 'changeSessionBtn') api('/api/session/reload').catch(function(e){ alert(e.message); });
    else if(t.id === 'cancelSessionChangeBtn') api('/api/session/cancel-change').catch(function(e){ alert(e.message); });
    else if(t.dataset.session) api('/api/session/select', { sessionId:t.dataset.session }).catch(function(e){ alert(e.message); });
    else if(t.dataset.approval) api('/api/approval/respond', { decision:t.dataset.approval }).catch(function(e){ alert(e.message); });
    else if(t.dataset.act){
      var id = t.dataset.id;
      var act = t.dataset.act;
      var itemIndex = ((state.snap && state.snap.queue) || []).findIndex(function(x){return x.id === id;});
      var item = itemIndex >= 0 ? state.snap.queue[itemIndex] : null;
      if(act === 'remove') openConfirm('remove', 'Remove prompt?', 'This prompt will be removed from the queue.', 'Yes, remove', true, { id:id });
      else if(act === 'edit') { state.editingQueueItemId = id; state.editDrafts[id] = item ? item.text || '' : ''; state.pendingEditFocusId = id; state.expandedQueueItems[id] = true; renderQueue(); }
      else if(act === 'cancelEdit') { delete state.editDrafts[id]; state.editingQueueItemId = null; renderQueue(); }
      else if(act === 'saveEdit') saveQueueEdit(id);
      else if(act === 'sendNow') {
        state.activeQueueFilter = 'all';
        requestQueueScroll(id, 'send', false);
        api('/api/queue/update', { id:id, action:act }).then(function(r){
          if(state.pendingQueueScrollId) requestQueueScroll(r && r.item && r.item.id ? r.item.id : id, 'send', true);
          getState();
        }).catch(function(e){ clearQueueScrollRequest(); alert(e.message); getState(); });
      }
      else api('/api/queue/update', { id:id, action:act });
    }
  });

  document.addEventListener('dragstart', function(ev){
    var item = ev.target && ev.target.closest ? ev.target.closest('.queue-item[draggable="true"]') : null;
    if(!item) return;
    if(ev.target.closest && ev.target.closest('button,textarea,select,input')) {
      ev.preventDefault();
      return;
    }
    state.queueDragId = item.dataset.queueId;
    item.classList.add('dragging');
    if(ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', state.queueDragId);
    }
  });

  document.addEventListener('dragover', function(ev){
    if(!state.queueDragId) return;
    var item = ev.target && ev.target.closest ? ev.target.closest('.queue-item[data-queue-status="pending"]') : null;
    if(!item || item.dataset.queueId === state.queueDragId) return;
    ev.preventDefault();
    if(ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    var rect = item.getBoundingClientRect();
    setQueueDropMarker(item, ev.clientY < rect.top + rect.height / 2);
  });

  document.addEventListener('drop', function(ev){
    if(!state.queueDragId) return;
    ev.preventDefault();
    finishQueueDrag();
  });

  document.addEventListener('dragend', function(){
    var el = document.getElementById('queue');
    if(el) {
      Array.prototype.forEach.call(el.querySelectorAll('.queue-item.dragging'), function(node){ node.classList.remove('dragging'); });
    }
    if(state.queueDragId) finishQueueDrag();
  });

  document.addEventListener('input', function(ev){
    var t = ev.target;
    if(t && t.dataset && t.dataset.editText) state.editDrafts[t.dataset.editText] = t.value;
    if(t && (t.id === 'scheduleDateInput' || t.id === 'scheduleTimeInput')) updateScheduleDraft();
  });

  document.addEventListener('change', function(ev){
    var t = ev.target;
    if(t && t.id === 'modelSelect') api('/api/config/model', { model:t.value }).catch(function(e){ alert(e.message); getState(); });
    else if(t && t.id === 'effortSelect') api('/api/config/effort', { effort:t.value }).catch(function(e){ alert(e.message); getState(); });
    else if(t && (t.id === 'scheduleDateInput' || t.id === 'scheduleTimeInput')) updateScheduleDraft();
  });

  document.addEventListener('keydown', function(ev){
    var t = ev.target;
    if(ev.key === 'Escape') {
      if(state.scheduleOpen) {
        ev.preventDefault();
        closeScheduleModal();
        return;
      }
      if(state.confirmAction) {
        ev.preventDefault();
        closeConfirm();
        return;
      }
      var queueMenu = document.getElementById('queueMenu');
      if(queueMenu && !queueMenu.classList.contains('hidden')) {
        ev.preventDefault();
        setQueueMenuOpen(false);
        return;
      }
      ev.preventDefault();
      if(state.editingQueueItemId) { delete state.editDrafts[state.editingQueueItemId]; state.editingQueueItemId = null; renderQueue(); return; }
      api(state.snap && state.snap.app && state.snap.app.state === 'countdown' ? '/api/control/cancel-send' : '/api/control/pause');
      return;
    }

    if(state.scheduleOpen && ev.key === 'Enter' && !(t && t.tagName === 'BUTTON')) {
      ev.preventDefault();
      var scheduledRunAt = scheduleInputIso();
      if(!scheduledRunAt) { alert('Select a valid time.'); return; }
      api('/api/queue/schedule', { scheduledRunAt:scheduledRunAt }).then(function(){ closeScheduleModal(); getState(); }).catch(function(e){ alert(e.message); });
      return;
    }

    if(state.confirmAction && ev.key === 'Enter') {
      ev.preventDefault();
      confirmCurrentAction();
      return;
    }

    if(t && t.dataset && t.dataset.editText && (ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
      ev.preventDefault();
      saveQueueEdit(t.dataset.editText);
      return;
    }

    if(t && t.dataset && t.dataset.togglePrompt && (ev.key === 'Enter' || ev.key === ' ')) {
      ev.preventDefault();
      var item = ((state.snap && state.snap.queue) || []).find(function(x){return x.id === t.dataset.id;});
      if(item) {
        state.expandedQueueItems[t.dataset.id] = !state.expandedQueueItems[t.dataset.id];
        renderQueue();
      }
    }
  });

  if(state.composer) {
    state.composer.addEventListener('input', updateCounter);
    state.composer.addEventListener('keydown', function(ev){
      if((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter'){
        ev.preventDefault();
        sendComposerNow();
      }
    });
  }

  if(state.compactHeaderQuery) {
    if(state.compactHeaderQuery.addEventListener) state.compactHeaderQuery.addEventListener('change', function(){ if(state.snap) renderHeader(); });
    else if(state.compactHeaderQuery.addListener) state.compactHeaderQuery.addListener(function(){ if(state.snap) renderHeader(); });
  }
}
