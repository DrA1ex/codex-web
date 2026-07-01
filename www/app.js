(function(){
  var TOKEN = window.CODEX_LIMIT_WATCH_TOKEN || '';
  var snap = null;
  var expandedQueueItems = Object.create(null);
  var composer = document.getElementById('composer');
  var outputEl = document.getElementById('output');
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function fmtTime(iso){ if(!iso) return ''; try { return new Date(iso).toLocaleString(); } catch(e){ return iso; } }
  function fmtClock(ts){ if(!ts) return '—'; try { return new Date(ts * 1000).toLocaleTimeString(); } catch(e){ return '—'; } }
  function fmtRelative(ts){
    if(!ts) return 'unknown';
    var mins = Math.max(0, Math.ceil(((ts * 1000) - Date.now()) / 60000));
    if(mins < 60) return mins + 'm';
    var hours = Math.floor(mins / 60); var rem = mins % 60;
    if(hours < 24) return hours + 'h' + (rem ? ' ' + rem + 'm' : '');
    var days = Math.floor(hours / 24); var hrem = hours % 24;
    return days + 'd' + (hrem ? ' ' + hrem + 'h' : '');
  }
  function windowLabel(w){
    var mins = Number(w && w.windowDurationMins) || 0;
    if(mins === 300) return '5h';
    if(mins === 10080) return 'weekly';
    if(mins && mins % 1440 === 0) return (mins / 1440) + 'd';
    if(mins && mins % 60 === 0) return (mins / 60) + 'h';
    return (w && w.name) || 'window';
  }
  function metaItem(label, value, title){
    value = value == null || value === '' ? '—' : String(value);
    title = title == null || title === '' ? value : String(title);
    return '<div class="meta-item" title="' + esc(label + ': ' + title) + '">' + esc(label) + ': <b>' + esc(value) + '</b></div>';
  }
  function pct(n){ n = Number(n); return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null; }
  function api(path, body){ return fetch(path + '?token=' + encodeURIComponent(TOKEN), { method:'POST', headers:{'content-type':'application/json','x-codex-limit-watch-token':TOKEN}, body:JSON.stringify(body || {}) }).then(function(r){ return r.json().then(function(j){ if(!r.ok) throw new Error(j.error || r.statusText); return j; }); }); }
  function getState(){ return fetch('/api/state?token=' + encodeURIComponent(TOKEN), { headers:{'x-codex-limit-watch-token':TOKEN} }).then(function(r){return r.json();}).then(update); }
  function update(s){ snap = s; render(); }
  function render(){ if(!snap) return; renderHeader(); renderSessions(); renderApproval(); renderQueue(); renderOutput(); document.getElementById('debug').textContent = JSON.stringify(snap.debug || {}, null, 2); }
  function setButtonState(id, disabled, hidden){
    var btn = document.getElementById(id);
    if(!btn) return;
    btn.disabled = !!disabled;
    btn.classList.toggle('hidden', !!hidden);
  }
  function renderControls(app, counts){
    counts = counts || {};
    var state = app.state || '';
    var hasSession = !!app.sessionId;
    var pending = counts.pending || 0;
    var running = (counts.sending || 0) + (counts.sent || 0);
    var canPause = hasSession && !['paused','done','error','initializing','selecting-session','approval-required'].includes(state);
    var canResume = hasSession && state === 'paused';
    var canDone = hasSession && state !== 'done' && pending === 0 && running === 0 && !snap.approval;
    setButtonState('undoBtn', false, pending === 0);
    setButtonState('clearBtn', false, pending === 0);
    setButtonState('clearCompletedBtn', false, (counts.completed || 0) === 0);
    setButtonState('pauseBtn', !canPause, false);
    setButtonState('resumeBtn', !canResume, false);
    setButtonState('interruptBtn', false, !app.canInterrupt);
    setButtonState('doneBtn', !canDone, false);
    setButtonState('cancelSendBtn', false, false);
    var countdownNotice = document.getElementById('countdownNotice');
    if(countdownNotice) countdownNotice.classList.toggle('hidden', state !== 'countdown');
  }
  function renderHeader(){
    var app = snap.app || {}; var rl = snap.rateLimits || {}; var c = app.queueCounts || {};
    var stateBadge = document.getElementById('stateBadge'); stateBadge.textContent = app.state || 'unknown'; stateBadge.className = 'badge ' + (app.state === 'error' ? 'danger' : (app.state === 'paused' || app.state === 'waiting-limits' || app.state === 'approval-required' ? 'warn' : 'ok'));
    var limitBadge = document.getElementById('limitBadge'); limitBadge.textContent = rl.status === 'limited' ? 'limits waiting' : (rl.status === 'available' ? 'limits available' : 'limits unknown'); limitBadge.className = 'badge ' + (rl.status === 'available' ? 'ok' : (rl.status === 'limited' ? 'warn' : 'danger'));
    var model = app.model || '';
    var modelBtn = document.getElementById('modelBtn');
    if(modelBtn) { modelBtn.textContent = 'Model: ' + (model || 'default'); modelBtn.title = model ? 'Current model: ' + model : 'Current model: default Codex model'; }
    renderControls(app, c);
    var reset = rl.resetAt ? new Date(rl.resetAt * 1000) : null; var resetText = reset ? reset.toLocaleTimeString() + ' · in ' + Math.max(0, Math.ceil((reset.getTime()-Date.now())/60000)) + 'm' : '—';
    var sessionTitle = app.sessionTitle || 'not selected';
    var sessionId = app.sessionId || '—';
    document.getElementById('meta').innerHTML =
      metaItem('Project', app.projectDir) +
      metaItem('Session', sessionTitle) +
      metaItem('Session ID', sessionId) +
      metaItem('Queue', (c.pending||0) + ' pending, ' + ((c.sending||0)+(c.sent||0)) + ' running') +
      metaItem('Limits', rl.message || rl.status || 'unknown') +
      metaItem('Reset', resetText) +
      metaItem('Sandbox', (app.sandbox || '—') + ' · Network: ' + String(app.network)) +
      metaItem('Approval', (app.approvalPolicy || '—') + ' / ' + (app.approvalResponse || '—'));
    renderLimitStats();
  }
  function renderLimitStats(){
    var el = document.getElementById('limitStats'); var rl = snap.rateLimits || {}; var buckets = rl.buckets || [];
    var html = '';
    buckets.forEach(function(b){
      var windows = b.windows && b.windows.length ? b.windows : [{ name:'primary', usedPercent:b.usedPercent, remainingPercent:b.usedPercent == null ? null : 100 - b.usedPercent, windowDurationMins:b.windowDurationMins, resetsAt:b.resetsAt }];
      html += '<div class="limit-card"><div class="limit-card-title">' + esc(b.limitName || b.limitId || 'limit') + '</div>';
      windows.forEach(function(w){
        var used = pct(w.usedPercent);
        var remaining = pct(w.remainingPercent);
        if(remaining == null && used != null) remaining = Math.max(0, 100 - used);
        var barClass = remaining == null ? 'unknown' : (remaining > 60 ? 'ok' : (remaining >= 25 ? 'warn' : 'danger'));
        html += '<div class="limit-row" title="' + esc(windowLabel(w) + ': ' + (remaining == null ? 'remaining unknown' : Math.round(remaining) + '% left') + '; reset ' + fmtClock(w.resetsAt) + ' · in ' + fmtRelative(w.resetsAt)) + '">' +
          '<span class="limit-row-label">' + esc(windowLabel(w)) + '</span>' +
          '<div class="limit-bar ' + barClass + '"><span style="width:' + (remaining == null ? 0 : remaining) + '%"></span></div>' +
          '<b>' + (remaining == null ? '—' : Math.round(remaining) + '%') + '</b>' +
          '<span class="limit-row-reset">reset ' + esc(fmtClock(w.resetsAt)) + ' · ' + esc(fmtRelative(w.resetsAt)) + '</span>' +
        '</div>';
      });
      html += '</div>';
    });
    if(!html) html = '<div class="limit-card muted">Rate-limit data unavailable.</div>';
    el.innerHTML = html;
  }
  function renderSessions(){
    var picker = document.getElementById('sessionPicker'); var app = snap.app || {};
    if(app.state !== 'selecting-session'){ picker.classList.add('hidden'); return; }
    picker.classList.remove('hidden');
    var sessions = snap.sessions || [];
    var html = '<div class="panel-head"><h2>Select Codex session</h2><div class="panel-actions"><button id="createSessionBtn" class="primary">Create new session</button><button id="reloadSessionsBtn">Reload</button></div></div>';
    if(!sessions.length) html += '<div class="empty">No active sessions found for this project. Create a new session to start queueing prompts, or reload after starting Codex elsewhere.</div>';
    sessions.forEach(function(s){ html += '<div class="session"><div class="session-title">' + esc(s.title || s.id) + ' <span class="badge">' + esc(s.cwdMatch || 'other') + '</span></div><div class="session-meta">ID: ' + esc(s.id) + '</div><div class="session-meta">CWD: ' + esc(s.cwd || '—') + '</div><div class="session-meta">Updated: ' + esc(fmtTime(s.updatedAt)) + '</div><div class="session-meta">' + esc(s.preview || '') + '</div><div class="actions"><button data-session="' + esc(s.id) + '" class="primary">Select</button></div></div>'; });
    picker.innerHTML = html;
  }
  function renderApproval(){
    var box = document.getElementById('approvalBox'); var a = snap.approval;
    if(!a){ box.classList.add('hidden'); box.innerHTML=''; return; }
    var p = a.params || {}; var cmd = Array.isArray(p.command) ? p.command.join(' ') : (p.command || '');
    box.classList.remove('hidden');
    box.innerHTML = '<b>Approval required</b><pre>Method: ' + esc(a.method) + '\\nCommand: ' + esc(cmd || '—') + '\\nCWD: ' + esc(p.cwd || '—') + '\\nReason: ' + esc(p.reason || '—') + '</pre><div class="actions"><button data-approval="accept">Accept once</button><button data-approval="accept-for-session">Accept for session</button><button data-approval="decline">Decline</button><button data-approval="cancel" class="danger">Cancel turn</button></div>';
  }
  function renderQueue(){
    var q = snap.queue || []; var el = document.getElementById('queue'); var app = snap.app || {};
    if(!q.length){ el.innerHTML = '<div class="empty">Queue is empty.</div>'; return; }
    var html = '';
    q.forEach(function(item, i){
      var active = item.id === app.nextPendingId || item.status === 'sending' || item.status === 'sent';
      var completed = item.status === 'completed';
      var running = item.status === 'sending' || item.status === 'sent';
      var expanded = !!expandedQueueItems[item.id] && !completed;
      var text = expanded ? (item.text || item.preview || '') : (item.preview || item.text || '');
      var idAttr = esc(item.id);
      var toggleAttrs = completed ? '' : ' data-toggle-prompt="1" data-id="' + idAttr + '" role="button" tabindex="0" title="Click to ' + (expanded ? 'collapse' : 'expand') + ' prompt"';
      html += '<div class="queue-item ' + (active ? 'active ' : '') + (running ? 'running ' : '') + (completed ? 'completed ' : '') + (expanded ? 'expanded' : '') + '">' +
        '<div class="queue-top"><span>#' + (i+1) + ' <span class="status ' + esc(item.status) + '">' + esc(item.status) + '</span> · ' + item.lineCount + ' lines</span><span>' + esc(fmtTime(completed && item.finishedAt ? item.finishedAt : item.createdAt)) + '</span></div>' +
        '<div class="prompt-preview"' + toggleAttrs + '>' + esc(text || '') + '</div>';
      if(item.error) html += '<div class="prompt-error">' + esc(item.error) + '</div>';
      if(!completed && !running) {
        html += '<div class="actions queue-actions"><button data-act="edit" data-id="' + idAttr + '">Edit</button><button data-act="duplicate" data-id="' + idAttr + '">Duplicate</button><button data-act="up" data-id="' + idAttr + '">Up</button><button data-act="down" data-id="' + idAttr + '">Down</button><button data-act="sendNow" data-id="' + idAttr + '">Send</button><button data-act="remove" data-id="' + idAttr + '" class="danger">Remove</button>';
        if(item.status === 'unknown' || item.status === 'failed') html += '<button data-act="markCompleted" data-id="' + idAttr + '">Done</button><button data-act="retry" data-id="' + idAttr + '">Retry</button>';
        html += '</div>';
      }
      html += '</div>';
    });
    el.innerHTML = html;
  }
  function renderOutput(){
    var atBottom = outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight < 30;
    outputEl.innerHTML = (snap.output || []).map(function(l){ return '<div class="out-line ' + esc(l.type || '') + '">' + esc(l.text) + '</div>'; }).join('');
    if(atBottom) outputEl.scrollTop = outputEl.scrollHeight;
  }
  function updateCounter(){ var text = composer.value; var lines = text ? text.split(/\r?\n/).length : 0; document.getElementById('counter').textContent = 'Lines: ' + lines + ' · Chars: ' + text.length; setButtonState('addBtn', !text.trim(), false); }
  function addQueue(){ api('/api/queue/add', { text: composer.value }).then(function(r){ if(r.clearComposer) composer.value=''; if(r.composerText !== undefined) composer.value = r.composerText; if(r.message) alert(r.message); updateCounter(); }).catch(function(e){ alert(e.message); }); }
  document.addEventListener('click', function(ev){
    var t = ev.target;
    var promptToggle = t.closest && t.closest('[data-toggle-prompt]');
    if(promptToggle) {
      var promptId = promptToggle.dataset.id;
      var itemForToggle = (snap.queue || []).find(function(x){return x.id === promptId;});
      if(itemForToggle && itemForToggle.status !== 'completed') {
        expandedQueueItems[promptId] = !expandedQueueItems[promptId];
        renderQueue();
      }
      return;
    }
    if(t.id === 'addBtn') addQueue();
    else if(t.id === 'cancelSendBtn') api('/api/control/cancel-send');
    else if(t.id === 'pauseBtn') api('/api/control/pause');
    else if(t.id === 'resumeBtn') api('/api/control/resume');
    else if(t.id === 'interruptBtn') { if(confirm('Interrupt the current running prompt?')) api('/api/control/interrupt').then(function(r){ if(r.message) alert(r.message); }).catch(function(e){ alert(e.message); }); }
    else if(t.id === 'undoBtn') api('/api/queue/undo').then(function(r){ if(r.composerText !== undefined) composer.value = r.composerText; if(r.message) alert(r.message); updateCounter(); });
    else if(t.id === 'clearBtn') { if(confirm('Clear all pending prompts?')) api('/api/queue/clear'); }
    else if(t.id === 'clearCompletedBtn') { if(confirm('Clear all completed prompts?')) api('/api/queue/clear-completed'); }
    else if(t.id === 'doneBtn') api('/api/control/done').then(function(r){ if(r.message) alert(r.message); });
    else if(t.id === 'stopBtn') { if(confirm('Stop local server and app-server?')) api('/api/control/stop'); }
    else if(t.id === 'clearOutputBtn') api('/api/output/clear');
    else if(t.id === 'bottomBtn') outputEl.scrollTop = outputEl.scrollHeight;
    else if(t.id === 'modelBtn') {
      var currentModel = snap && snap.app ? (snap.app.model || '') : '';
      var nextModel = prompt('Model override. Leave empty to use the Codex default:', currentModel);
      if(nextModel !== null) api('/api/config/model', { model:nextModel }).catch(function(e){ alert(e.message); });
    }
    else if(t.id === 'createSessionBtn') api('/api/session/create').catch(function(e){ alert(e.message); });
    else if(t.id === 'reloadSessionsBtn') api('/api/session/reload');
    else if(t.dataset.session) api('/api/session/select', { sessionId:t.dataset.session }).catch(function(e){ alert(e.message); });
    else if(t.dataset.approval) api('/api/approval/respond', { decision:t.dataset.approval }).catch(function(e){ alert(e.message); });
    else if(t.dataset.act){
      var id = t.dataset.id; var act = t.dataset.act; var item = (snap.queue || []).find(function(x){return x.id === id;});
      if(act === 'remove') { if(confirm('Remove this prompt?')) api('/api/queue/remove', { id:id }); }
      else if(act === 'up' || act === 'down') api('/api/queue/reorder', { id:id, direction:act });
      else if(act === 'edit') { var text = prompt('Edit prompt:', item ? item.text : ''); if(text !== null) api('/api/queue/update', { id:id, action:'edit', text:text }); }
      else api('/api/queue/update', { id:id, action:act });
    }
  });
  document.addEventListener('keydown', function(ev){
    var t = ev.target;
    if(ev.key === 'Escape') {
      ev.preventDefault();
      api(snap && snap.app && snap.app.state === 'countdown' ? '/api/control/cancel-send' : '/api/control/pause');
      return;
    }
    if(t && t.dataset && t.dataset.togglePrompt && (ev.key === 'Enter' || ev.key === ' ')) {
      ev.preventDefault();
      var item = (snap.queue || []).find(function(x){return x.id === t.dataset.id;});
      if(item && item.status !== 'completed') {
        expandedQueueItems[t.dataset.id] = !expandedQueueItems[t.dataset.id];
        renderQueue();
      }
    }
  });
  composer.addEventListener('input', updateCounter);
  composer.addEventListener('keydown', function(ev){
    if((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter'){ ev.preventDefault(); addQueue(); }
  });
  updateCounter();
  setInterval(function(){ if(snap) renderHeader(); }, 30000);
  var es = new EventSource('/events?token=' + encodeURIComponent(TOKEN));
  es.addEventListener('state', function(ev){ update(JSON.parse(ev.data)); });
  es.addEventListener('output', function(ev){ if(!snap) return; snap.output = JSON.parse(ev.data); renderOutput(); });
  es.addEventListener('done', function(){ es.close(); });
  es.onerror = function(){ setTimeout(getState, 1000); };
  getState();
})();
