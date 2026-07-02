import { state } from '#core/state';
import { api, getState } from '#core/api';
import { esc, fmtTime } from '#utils/format';

function isRunningStatus(status){ return status === 'sending' || status === 'sent'; }
function isDoneStatus(status){ return status === 'completed'; }
function isPendingQueueItem(item){ return item && item.status === 'pending'; }

export function queueMatchesFilter(item){
  var status = item && item.status;
  if(state.activeQueueFilter === 'pending') return status === 'pending';
  if(state.activeQueueFilter === 'running') return isRunningStatus(status);
  if(state.activeQueueFilter === 'completed') return isDoneStatus(status);
  return true;
}

function queueAnimationDisabled(){
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function queueItemRects(el){
  var rects = Object.create(null);
  if(!el || queueAnimationDisabled()) return rects;
  Array.prototype.forEach.call(el.querySelectorAll('[data-queue-id]'), function(node){
    rects[node.dataset.queueId] = node.getBoundingClientRect();
  });
  return rects;
}

function animateQueueItems(el, oldRects){
  if(!el || queueAnimationDisabled()) return;
  var nodes = Array.prototype.slice.call(el.querySelectorAll('[data-queue-id]'));
  nodes.forEach(function(node){
    var oldRect = oldRects[node.dataset.queueId];
    if(!oldRect) {
      node.classList.add('queue-item-enter');
      requestAnimationFrame(function(){ node.classList.remove('queue-item-enter'); });
      return;
    }
    var newRect = node.getBoundingClientRect();
    var dx = oldRect.left - newRect.left;
    var dy = oldRect.top - newRect.top;
    var dh = oldRect.height - newRect.height;
    if(Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(dh) < 1) return;
    if(node.animate) {
      var animation = node.animate([
        { transform:'translate(' + dx + 'px, ' + dy + 'px)', height:oldRect.height + 'px' },
        { transform:'translate(0, 0)', height:newRect.height + 'px' }
      ], { duration:180, easing:'cubic-bezier(.2, .8, .2, 1)' });
      node.style.overflow = 'hidden';
      animation.onfinish = animation.oncancel = function(){ node.style.overflow = ''; };
    }
  });
}

function queueItemVisibleInPanel(item, panel){
  if(!item || !panel) return false;
  var itemRect = item.getBoundingClientRect();
  var panelRect = panel.getBoundingClientRect();
  return itemRect.top >= panelRect.top && itemRect.bottom <= panelRect.bottom;
}

function queueMoveSettleDelay(){
  return queueAnimationDisabled() ? 0 : state.queueMoveAnimationMs + 40;
}

export function clearQueueScrollRequest(){
  state.pendingQueueScrollId = null;
  state.pendingQueueScrollKind = '';
  state.pendingQueueScrollReady = false;
}

export function requestQueueScroll(id, kind, ready){
  state.pendingQueueScrollId = id;
  state.pendingQueueScrollKind = kind || '';
  state.pendingQueueScrollReady = !!ready;
}

function flashQueueItem(target){
  if(!target) return;
  state.queueFlashId = target.dataset.queueId;
  target.classList.add('queue-item-flash');
  setTimeout(function(){
    target.classList.remove('queue-item-flash');
    if(state.queueFlashId === target.dataset.queueId) state.queueFlashId = null;
  }, 900);
}

function scrollQueueItemAfterMove(id){
  if(state.pendingQueueScrollTimer) clearTimeout(state.pendingQueueScrollTimer);
  state.pendingQueueScrollTimer = setTimeout(function(){
    state.pendingQueueScrollTimer = null;
    var el = document.getElementById('queue');
    if(!el) return;
    var target = Array.prototype.find.call(el.querySelectorAll('[data-queue-id]'), function(node){ return node.dataset.queueId === id; });
    if(!target) return;
    if(!queueItemVisibleInPanel(target, el)) target.scrollIntoView({ behavior:'smooth', block:'center' });
    flashQueueItem(target);
  }, queueMoveSettleDelay());
}

export function clearQueueDropMarker(){
  state.queueDropBeforeId = undefined;
  var el = document.getElementById('queue');
  if(!el) return;
  Array.prototype.forEach.call(el.querySelectorAll('.queue-item.drop-before, .queue-item.drop-after'), function(node){
    node.classList.remove('drop-before', 'drop-after');
  });
}

function pendingQueueIdsFromDom(){
  var el = document.getElementById('queue');
  if(!el) return [];
  return Array.prototype.map.call(el.querySelectorAll('.queue-item[data-queue-status="pending"]'), function(node){ return node.dataset.queueId; });
}

export function setQueueDropMarker(target, before){
  clearQueueDropMarker();
  if(!target) return;
  target.classList.add(before ? 'drop-before' : 'drop-after');
  if(before) {
    state.queueDropBeforeId = target.dataset.queueId;
    return;
  }
  var ids = pendingQueueIdsFromDom();
  var idx = ids.indexOf(target.dataset.queueId);
  state.queueDropBeforeId = idx >= 0 && idx + 1 < ids.length ? ids[idx + 1] : '';
}

export function finishQueueDrag(){
  var id = state.queueDragId;
  var beforeId = state.queueDropBeforeId;
  state.queueDragId = null;
  clearQueueDropMarker();
  if(id == null || beforeId === undefined || beforeId === id) return;
  api('/api/queue/reorder', { id:id, beforeId:beforeId || null }).catch(function(e){ alert(e.message); getState(); });
}

export function renderQueue(){
  var snap = state.snap || {};
  var q = snap.queue || [];
  var el = document.getElementById('queue');
  var app = snap.app || {};
  if(!el) return;
  if(!q.length){
    el.innerHTML = '<div class="empty">Queue is empty.</div>';
    return;
  }
  var filtered = q.filter(queueMatchesFilter);
  if(!filtered.length){
    el.innerHTML = '<div class="empty">No items match this filter.</div>';
    return;
  }
  var oldRects = queueItemRects(el);
  var html = '';
  filtered.forEach(function(item){
    var i = q.indexOf(item);
    var active = item.status === 'sending' || item.status === 'sent';
    var completed = item.status === 'completed';
    var running = item.status === 'sending' || item.status === 'sent';
    var editing = state.editingQueueItemId === item.id && !completed && !running;
    var expanded = !!state.expandedQueueItems[item.id] || editing;
    var text = expanded ? (item.text || item.preview || '') : (item.preview || item.text || '');
    var idAttr = esc(item.id);
    var toggleAttrs = editing ? '' : ' data-toggle-prompt="1" data-id="' + idAttr + '" role="button" tabindex="0" title="Click to ' + (expanded ? 'collapse' : 'expand') + ' prompt"';
    var draggable = isPendingQueueItem(item) && !editing;
    html += '<div class="queue-item ' + (active ? 'active ' : '') + (running ? 'running ' : '') + (completed ? 'completed ' : '') + (draggable ? 'draggable ' : '') + (expanded ? 'expanded ' : '') + (editing ? 'editing' : '') + '" data-queue-id="' + idAttr + '" data-queue-status="' + esc(item.status) + '"' + (draggable ? ' draggable="true"' : '') + '>' +
      '<div class="queue-top"><span>' + (draggable ? '<span class="queue-drag-handle" title="Drag to reorder">↕</span>' : '') + '#' + (i+1) + ' <span class="status ' + esc(item.status) + '">' + esc(item.status) + '</span> · ' + item.lineCount + ' lines</span><span>' + esc(fmtTime(completed && item.finishedAt ? item.finishedAt : item.createdAt)) + '</span></div>';
    if(editing) {
      var draft = Object.prototype.hasOwnProperty.call(state.editDrafts, item.id) ? state.editDrafts[item.id] : (item.text || '');
      html += '<textarea class="queue-edit" data-edit-text="' + idAttr + '" spellcheck="false">' + esc(draft) + '</textarea>';
    } else {
      html += '<div class="prompt-preview" aria-label="' + esc(item.text || item.preview || '') + '"' + toggleAttrs + '>' + esc(text || '') + '</div>';
    }
    if(item.error) html += '<div class="prompt-error">' + esc(item.error) + '</div>';
    if(editing) {
      html += '<div class="actions queue-actions"><button data-act="saveEdit" data-id="' + idAttr + '" class="primary"' + (state.savingQueueEdits[item.id] ? ' disabled' : '') + '>' + (state.savingQueueEdits[item.id] ? 'Saving...' : 'Save') + '</button><button data-act="cancelEdit" data-id="' + idAttr + '"' + (state.savingQueueEdits[item.id] ? ' disabled' : '') + '>Cancel</button></div>';
    } else if(!completed && !running) {
      var sendDisabled = app.state === 'countdown' || app.isManualSend;
      html += '<div class="actions queue-actions"><button data-act="edit" data-id="' + idAttr + '">Edit</button><button data-act="duplicate" data-id="' + idAttr + '">Duplicate</button><button data-act="sendNow" data-id="' + idAttr + '"' + (sendDisabled ? ' disabled title="A prompt is already scheduled to send"' : '') + '>Send</button><button data-act="remove" data-id="' + idAttr + '" class="danger">Remove</button>';
      if(item.status === 'unknown' || item.status === 'failed') html += '<button data-act="markCompleted" data-id="' + idAttr + '">Done</button><button data-act="retry" data-id="' + idAttr + '">Retry</button>';
      html += '</div>';
    }
    html += '</div>';
  });

  var activeEdit = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.editText ? document.activeElement : null;
  var activeEditId = activeEdit ? activeEdit.dataset.editText : null;
  var activeEditSelection = activeEdit ? {
    value: activeEdit.value,
    start: activeEdit.selectionStart,
    end: activeEdit.selectionEnd,
    scrollTop: activeEdit.scrollTop
  } : null;
  if(activeEditId) state.editDrafts[activeEditId] = activeEdit.value;
  el.innerHTML = html;
  animateQueueItems(el, oldRects);

  if(state.pendingQueueScrollId) {
    var target = Array.prototype.find.call(el.querySelectorAll('[data-queue-id]'), function(node){ return node.dataset.queueId === state.pendingQueueScrollId; });
    if(target) {
      var targetItem = (state.snap.queue || []).find(function(x){ return x.id === state.pendingQueueScrollId; });
      var waitForSendPosition = state.pendingQueueScrollKind === 'send' && targetItem && targetItem.status === 'pending' && !state.pendingQueueScrollReady;
      if(!waitForSendPosition) {
        var scrollId = state.pendingQueueScrollId;
        clearQueueScrollRequest();
        scrollQueueItemAfterMove(scrollId);
      }
    }
  } else if(!state.didInitialQueueScroll) {
    state.didInitialQueueScroll = true;
    var firstOpenItem = q.find(function(item){ return item.status !== 'completed'; });
    if(firstOpenItem) {
      var firstTarget = Array.prototype.find.call(el.querySelectorAll('[data-queue-id]'), function(node){ return node.dataset.queueId === firstOpenItem.id; });
      if(firstTarget) firstTarget.scrollIntoView({ block:'center' });
    }
  }

  if(state.editingQueueItemId) {
    var editor = el.querySelector('[data-edit-text]');
    if(editor && (state.pendingEditFocusId === state.editingQueueItemId || activeEditId === state.editingQueueItemId)) {
      if(activeEditSelection && activeEditId === state.editingQueueItemId) {
        editor.value = activeEditSelection.value;
        state.editDrafts[state.editingQueueItemId] = activeEditSelection.value;
      }
      editor.focus();
      if(state.pendingEditFocusId === state.editingQueueItemId) {
        editor.selectionStart = editor.selectionEnd = editor.value.length;
        state.pendingEditFocusId = null;
      } else if(activeEditSelection && activeEditId === state.editingQueueItemId) {
        editor.selectionStart = activeEditSelection.start;
        editor.selectionEnd = activeEditSelection.end;
        editor.scrollTop = activeEditSelection.scrollTop;
      }
    }
  }
}

function queueEditText(id, fallback){
  var editor = document.querySelector('[data-edit-text="' + id + '"]');
  if(editor) {
    state.editDrafts[id] = editor.value;
    return editor.value;
  }
  if(Object.prototype.hasOwnProperty.call(state.editDrafts, id)) return state.editDrafts[id];
  return fallback || '';
}

export function saveQueueEdit(id){
  if(!id || state.savingQueueEdits[id]) return;
  var item = (state.snap.queue || []).find(function(x){ return x.id === id; });
  var text = queueEditText(id, item ? item.text || '' : '');
  state.savingQueueEdits[id] = true;
  renderQueue();
  api('/api/queue/update', { id:id, action:'edit', text:text }).then(function(r){
    if(r && r.item && state.snap && Array.isArray(state.snap.queue)) {
      var idx = state.snap.queue.findIndex(function(x){ return x.id === id; });
      if(idx >= 0) state.snap.queue[idx] = r.item;
    }
    delete state.editDrafts[id];
    delete state.savingQueueEdits[id];
    if(state.editingQueueItemId === id) state.editingQueueItemId = null;
    renderQueue();
    getState();
  }).catch(function(e){
    delete state.savingQueueEdits[id];
    state.editDrafts[id] = text;
    renderQueue();
    alert(e.message);
  });
}
