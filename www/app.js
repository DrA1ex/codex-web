(function(){
  var TOKEN = window.CODEX_LIMIT_WATCH_TOKEN || '';
  var snap = null;
  var expandedQueueItems = Object.create(null);
  var editingQueueItemId = null;
  var editDrafts = Object.create(null);
  var pendingEditFocusId = null;
  var pendingQueueScrollId = null;
  var didInitialQueueScroll = false;
  var expandedDiffOutput = Object.create(null);
  var activeQueueFilter = 'all';
  var renderKeys = Object.create(null);
  var confirmAction = null;
  var scheduleOpen = false;
  var scheduleDraft = null;
  var mobileCollapsed = { header:false, limits:false, queue:false };
  var composer = document.getElementById('composer');
  var outputEl = document.getElementById('output');
  var compactHeaderQuery = window.matchMedia ? window.matchMedia('(max-width: 1679px)') : null;
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function fmtTime(iso){ if(!iso) return ''; try { return new Date(iso).toLocaleString(); } catch(e){ return iso; } }
  function fmtClock(ts){ if(!ts) return '—'; try { return new Date(ts * 1000).toLocaleTimeString(); } catch(e){ return '—'; } }
  function fmtRelative(ts){
    if(!ts) return 'unknown';
    var mins = Math.max(0, Math.ceil(((ts * 1000) - Date.now()) / 60000));
    return fmtCountdownMinutes(mins);
  }
  function fmtCountdownMinutes(mins){
    mins = Math.max(0, Math.ceil(Number(mins) || 0));
    if(mins <= 120) return mins + 'm';
    var hours = Math.ceil(mins / 60);
    if(hours <= 48) return hours + 'h';
    return Math.ceil(hours / 24) + 'd';
  }
  function isSameLocalDay(a, b){ return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  function fmtRunAt(iso){
    if(!iso) return '—';
    var d = new Date(iso);
    if(Number.isNaN(d.getTime())) return '—';
    var time = d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    if(isSameLocalDay(d, new Date())) return time;
    return d.toLocaleDateString([], { year:'numeric', month:'short', day:'numeric' }) + ', ' + time;
  }
  function fmtRunMeta(iso){
    if(!iso) return '—';
    var d = new Date(iso);
    if(Number.isNaN(d.getTime())) return '—';
    return fmtRunAt(iso) + ' · in ' + fmtCountdownMinutes(((d.getTime() - Date.now()) / 60000));
  }
  function localDateValue(iso){
    var d = iso ? new Date(iso) : new Date(Date.now() + 15 * 60000);
    if(Number.isNaN(d.getTime())) d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function localTimeValue(iso){
    var d = iso ? new Date(iso) : new Date(Date.now() + 15 * 60000);
    if(Number.isNaN(d.getTime())) d = new Date(Date.now() + 15 * 60000);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function scheduleInputIso(){
    var dateEl = document.getElementById('scheduleDateInput');
    var timeEl = document.getElementById('scheduleTimeInput');
    var date = dateEl && dateEl.value ? dateEl.value : localDateValue(null);
    var time = timeEl && timeEl.value ? timeEl.value : '';
    if(!time) return null;
    var d = new Date(date + 'T' + time + ':00');
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  function updateScheduleDraft(){
    scheduleDraft = scheduleDraft || {};
    scheduleDraft.date = document.getElementById('scheduleDateInput') ? document.getElementById('scheduleDateInput').value : localDateValue(null);
    scheduleDraft.time = document.getElementById('scheduleTimeInput') ? document.getElementById('scheduleTimeInput').value : '';
  }
  function fmtCountdown(iso){
    if(!iso) return '15:00';
    var ms = Math.max(0, new Date(iso).getTime() - Date.now());
    var total = Math.ceil(ms / 1000);
    var mins = Math.floor(total / 60);
    var secs = total % 60;
    return mins + ':' + String(secs).padStart(2, '0');
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
    return '<div class="meta-item" aria-label="' + esc(label + ': ' + title) + '"><span>' + esc(label) + '</span><b>' + esc(value) + '</b></div>';
  }
  function sessionMetaItem(app, value, title){
    value = value == null || value === '' ? '—' : String(value);
    title = title == null || title === '' ? value : String(title);
    var action = app.canChangeSession ? '<button id="changeSessionBtn" class="meta-action" title="Change session">Change</button>' : '';
    return '<div class="meta-item session-meta-item" aria-label="' + esc('Session: ' + title) + '"><span>Session</span><div class="meta-value-row"><b>' + esc(value) + '</b>' + action + '</div></div>';
  }
  function envChip(label, value, ok){
    value = value == null || value === '' ? '—' : String(value);
    return '<span class="env-chip ' + (ok ? 'ok' : '') + '" aria-label="' + esc(label + ': ' + value) + '" title="' + esc(label + ': ' + value) + '"><i></i>' + esc(label) + ': <b>' + esc(value) + '</b></span>';
  }
  function queueTab(filter, label, value, active){
    return '<button type="button" class="queue-tab ' + (active ? 'active' : '') + '" data-queue-filter="' + esc(filter) + '">' + esc(label) + ' <b>' + Number(value || 0) + '</b></button>';
  }
  function isRunningStatus(status){ return status === 'sending' || status === 'sent'; }
  function isDoneStatus(status){ return status === 'completed'; }
  function queueMatchesFilter(item){
    var status = item && item.status;
    if(activeQueueFilter === 'pending') return status === 'pending';
    if(activeQueueFilter === 'running') return isRunningStatus(status);
    if(activeQueueFilter === 'completed') return isDoneStatus(status);
    return true;
  }
  function canMoveQueueItem(q, index, direction){
    var item = q[index];
    if(!item || item.status !== 'pending') return false;
    var nextIndex = direction === 'up' ? index - 1 : index + 1;
    return !!(q[nextIndex] && q[nextIndex].status === 'pending');
  }
  function pct(n){ n = Number(n); return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null; }
  function isCompactHeader(){ return !!(compactHeaderQuery && compactHeaderQuery.matches); }
  function limitBadgeText(status){
    if(isCompactHeader()) return 'limits';
    return status === 'limited' ? 'limits waiting' : (status === 'available' ? 'limits available' : 'limits unknown');
  }
  function fullLimitBadgeText(status){
    return status === 'limited' ? 'limits waiting' : (status === 'available' ? 'limits available' : 'limits unknown');
  }
  function renderModelOptions(select, app){
    var options = app.modelOptions || [];
    var model = app.model || '';
    if(model && !options.some(function(o){ return o.value === model; })) options = options.concat([{ value:model, label:model }]);
    var html = options.map(function(o){ return '<option value="' + esc(o.value) + '">' + esc(o.label || o.value || ((app.defaultModel || 'default') + ' (default)')) + '</option>'; }).join('');
    if(select.innerHTML !== html) select.innerHTML = html;
    select.value = model;
    select.title = 'Current model: ' + (model || app.defaultModel || 'default');
  }
  function renderEffortOptions(select, app){
    var options = app.effortOptions || [];
    var effort = app.effort || '';
    var html = options.map(function(o){ return '<option value="' + esc(o.value) + '">' + esc(o.label || o.value || 'default') + '</option>'; }).join('');
    if(select.innerHTML !== html) select.innerHTML = html;
    select.value = effort;
    select.title = 'Current effort: ' + (effort || 'default');
  }
  function api(path, body){ return fetch(path + '?token=' + encodeURIComponent(TOKEN), { method:'POST', headers:{'content-type':'application/json','x-codex-limit-watch-token':TOKEN}, body:JSON.stringify(body || {}) }).then(function(r){ return r.json().then(function(j){ if(!r.ok) throw new Error(j.error || r.statusText); return j; }); }); }
  function getState(){ return fetch('/api/state?token=' + encodeURIComponent(TOKEN), { headers:{'x-codex-limit-watch-token':TOKEN} }).then(function(r){return r.json();}).then(update); }
  function stableKey(value){
    try { return JSON.stringify(value == null ? null : value); } catch(e) { return String(Date.now()); }
  }
  function sectionKey(name, s){
    var app = (s && s.app) || {};
    if(name === 'header') return stableKey({ app:app, rateLimits:s && s.rateLimits });
    if(name === 'sessions') return stableKey({ state:app.state, sessionId:app.sessionId, sessionError:app.sessionError, sessions:s && s.sessions });
    if(name === 'approval') return stableKey(s && s.approval);
    if(name === 'queue') return stableKey({ queue:s && s.queue, counts:app.queueCounts, nextPendingId:app.nextPendingId, canInterrupt:app.canInterrupt });
    if(name === 'output') return stableKey(s && s.output);
    if(name === 'debug') return stableKey(s && s.debug);
    return '';
  }
  function renderSection(name, fn, force){
    var key = sectionKey(name, snap);
    if(force || renderKeys[name] !== key) {
      renderKeys[name] = key;
      fn();
    }
  }
  function update(s){
    var first = !snap;
    snap = s;
    render(first);
  }
  function render(){
    if(!snap) return;
    var force = arguments.length ? !!arguments[0] : false;
    renderSection('header', renderHeader, force);
    renderSection('sessions', renderSessions, force);
    renderSection('approval', renderApproval, force);
    renderConfirm();
    renderScheduleModal();
    renderSection('queue', renderQueue, force);
    renderSection('output', renderOutput, force);
    renderSection('debug', function(){
      var debug = document.getElementById('debug');
      if(debug) debug.textContent = JSON.stringify(snap.debug || {}, null, 2);
    }, force);
  }
  function setMobileCollapsed(section, collapsed){
    mobileCollapsed[section] = !!collapsed;
    applyMobileCollapseState();
  }
  function updateCollapseButton(id, collapsed, label){
    var btn = document.getElementById(id);
    if(!btn) return;
    btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    btn.title = (collapsed ? 'Expand ' : 'Collapse ') + label;
    if(id === 'limitsCollapseBtn') {
      var icon = btn.querySelector('i');
      if(icon) icon.textContent = collapsed ? '⌄' : '⌃';
    } else {
      btn.textContent = collapsed ? '⌄' : '⌃';
    }
  }
  function applyMobileCollapseState(){
    document.body.classList.toggle('mobile-header-collapsed', mobileCollapsed.header);
    document.body.classList.toggle('mobile-limits-collapsed', mobileCollapsed.limits);
    document.body.classList.toggle('mobile-queue-collapsed', mobileCollapsed.queue);
    updateCollapseButton('headerCollapseBtn', mobileCollapsed.header, 'header');
    updateCollapseButton('limitsCollapseBtn', mobileCollapsed.limits, 'limits');
    updateCollapseButton('queueCollapseBtn', mobileCollapsed.queue, 'queue');
  }
  function renderTheme(app){
    var theme = app.theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    var btn = document.getElementById('themeBtn');
    if(btn) { btn.textContent = theme === 'light' ? '☀' : '☾'; btn.title = 'Switch to ' + (theme === 'light' ? 'dark' : 'light') + ' theme'; }
  }
  function setButtonState(id, disabled, hidden){
    var btn = document.getElementById(id);
    if(!btn) return;
    btn.disabled = !!disabled;
    btn.classList.toggle('hidden', !!hidden);
  }
  function setQueueMenuOpen(open){
    var menu = document.getElementById('queueMenu');
    var btn = document.getElementById('queueMenuBtn');
    if(menu) menu.classList.toggle('hidden', !open);
    if(btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function renderControls(app, counts){
    counts = counts || {};
    var state = app.state || '';
    var hasSession = !!app.sessionId;
    var pending = counts.pending || 0;
    var running = (counts.sending || 0) + (counts.sent || 0);
    var canPause = hasSession && !!app.canPause;
    var canResume = hasSession && state === 'paused';
    setButtonState('undoBtn', false, pending === 0);
    setButtonState('clearBtn', false, pending === 0);
    setButtonState('clearCompletedBtn', false, (counts.completed || 0) === 0);
    setButtonState('queueMenuBtn', pending === 0 && (counts.completed || 0) === 0, false);
    setButtonState('pauseBtn', !canPause, false);
    setButtonState('resumeBtn', !canResume, false);
    setButtonState('scheduleBtn', !app.canScheduleQueue, false);
    setButtonState('interruptBtn', false, !app.canInterrupt);
    setButtonState('cancelSendBtn', false, false);
    var countdownNotice = document.getElementById('countdownNotice');
    if(countdownNotice) countdownNotice.classList.toggle('hidden', state !== 'countdown');
  }
  function renderHeader(){
    var app = snap.app || {}; var rl = snap.rateLimits || {}; var c = app.queueCounts || {};
    renderTheme(app);
    var stateBadge = document.getElementById('stateBadge'); stateBadge.textContent = app.state || 'unknown'; stateBadge.title = app.state || 'unknown'; stateBadge.className = 'badge ' + (app.state === 'error' ? 'danger' : (app.state === 'paused' || app.state === 'scheduled' || app.state === 'waiting-limits' || app.state === 'approval-required' ? 'warn' : 'ok'));
    var limitBadge = document.getElementById('limitBadge'); limitBadge.textContent = limitBadgeText(rl.status); limitBadge.title = fullLimitBadgeText(rl.status); limitBadge.className = 'badge ' + (rl.status === 'available' ? 'ok' : (rl.status === 'limited' ? 'warn' : 'danger'));
    var mobileLimitsSummary = document.getElementById('mobileLimitsSummary');
    if(mobileLimitsSummary) mobileLimitsSummary.textContent = limitBadgeText(rl.status);
    var modelSelect = document.getElementById('modelSelect');
    if(modelSelect) renderModelOptions(modelSelect, app);
    var effortSelect = document.getElementById('effortSelect');
    if(effortSelect) renderEffortOptions(effortSelect, app);
    renderControls(app, c);
    var nextRun = { label:'Next run', value:'—' };
    if(app.scheduledRunAt) nextRun = { label:'Schedule', value:fmtRunMeta(app.scheduledRunAt) };
    else if(app.state === 'waiting-limits') nextRun = { label:'Limit reset', value:rl.resetAt ? fmtRunMeta(new Date(rl.resetAt * 1000).toISOString()) : '—' };
    var sessionTitle = app.sessionTitle || 'not selected';
    var sessionId = app.sessionId || '—';
    var queueTotal = (c.pending || 0) + (c.sending || 0) + (c.sent || 0) + (c.completed || 0) + (c.failed || 0) + (c.unknown || 0);
    var queueCountBadge = document.getElementById('queueCountBadge');
    if(queueCountBadge) queueCountBadge.textContent = queueTotal;
    var tabs = document.getElementById('queueTabs');
    if(tabs) tabs.innerHTML =
      queueTab('all', 'All', queueTotal, activeQueueFilter === 'all') +
      queueTab('pending', 'Pending', c.pending || 0, activeQueueFilter === 'pending') +
      queueTab('running', 'Running', (c.sending || 0) + (c.sent || 0), activeQueueFilter === 'running') +
      queueTab('completed', 'Done', c.completed || 0, activeQueueFilter === 'completed');
    var env = document.getElementById('envMeta');
    if(env) env.innerHTML =
      envChip('Sandbox', app.sandbox || '—', true) +
      envChip('Approval', app.approvalPolicy || '—', true) +
      envChip('Network', String(app.network), !!app.network);
    document.getElementById('meta').innerHTML =
      metaItem('Project', app.projectDir) +
      sessionMetaItem(app, sessionTitle, sessionTitle) +
      metaItem('Session ID', sessionId) +
      metaItem(nextRun.label, nextRun.value);
    renderLimitStats();
    applyMobileCollapseState();
  }
  function renderLimitStats(){
    var el = document.getElementById('limitStats'); var rl = snap.rateLimits || {}; var buckets = rl.buckets || [];
    var html = '';
    buckets.forEach(function(b){
      var windows = b.windows && b.windows.length ? b.windows : [{ name:'primary', usedPercent:b.usedPercent, remainingPercent:b.usedPercent == null ? null : 100 - b.usedPercent, windowDurationMins:b.windowDurationMins, resetsAt:b.resetsAt }];
      html += '<div class="limit-card"><div class="limit-card-head"><span>Limits</span><b>' + esc(b.limitName || b.limitId || 'limit') + '</b></div>';
      windows.forEach(function(w){
        var used = pct(w.usedPercent);
        var remaining = pct(w.remainingPercent);
        if(remaining == null && used != null) remaining = Math.max(0, 100 - used);
        var barClass = remaining == null ? 'unknown' : (remaining > 60 ? 'ok' : (remaining >= 25 ? 'warn' : 'danger'));
        html += '<div class="limit-row" title="' + esc(windowLabel(w) + ': ' + (remaining == null ? 'remaining unknown' : Math.round(remaining) + '% left') + '; reset ' + fmtClock(w.resetsAt) + ' · in ' + fmtRelative(w.resetsAt)) + '">' +
          '<span class="limit-row-label">' + esc(windowLabel(w)) + '</span>' +
          '<div class="limit-bar ' + barClass + '"><span style="width:' + (remaining == null ? 0 : remaining) + '%"></span></div>' +
          '<b>' + (remaining == null ? '—' : Math.round(remaining) + '%') + '</b>' +
          '<span class="limit-row-reset">' + esc(fmtRelative(w.resetsAt)) + '</span>' +
        '</div>';
      });
      html += '</div>';
    });
    if(!html) html = '<div class="limit-card muted"><div class="limit-card-head">Limits</div><p>Rate-limit data unavailable.</p></div>';
    el.innerHTML = html;
  }
  function renderSessions(){
    var picker = document.getElementById('sessionPicker'); var app = snap.app || {};
    if(app.state !== 'selecting-session'){ picker.classList.add('hidden'); return; }
    picker.classList.remove('hidden');
    if(app.sessionError) {
      picker.innerHTML = '<div class="session-modal session-error-modal" role="dialog" aria-modal="true" aria-labelledby="sessionErrorTitle">' +
        '<div class="panel-head"><h2 id="sessionErrorTitle">Session unavailable</h2></div>' +
        '<div class="session-list-body"><div class="empty">' + esc(app.sessionError.message || 'This session is currently used by another codex-web instance.') + '</div>' +
        '<div class="actions"><button id="reloadSessionsBtn" class="primary">Change / refresh</button></div></div>' +
      '</div>';
      return;
    }
    var sessions = snap.sessions || [];
    var canCancel = !!app.sessionId;
    var html = '<div class="session-modal" role="dialog" aria-modal="true" aria-labelledby="sessionModalTitle">' +
      '<div class="panel-head"><h2 id="sessionModalTitle">Select Codex session</h2><div class="panel-actions"><button id="createSessionBtn" class="primary">Create new session</button><button id="reloadSessionsBtn">Reload</button>' + (canCancel ? '<button id="cancelSessionChangeBtn">Cancel</button>' : '') + '</div></div>' +
      '<div class="session-list-body">';
    if(!sessions.length) html += '<div class="empty">No active sessions found for this project. Create a new session to start queueing prompts, or reload after starting Codex elsewhere.</div>';
    sessions.forEach(function(s){ html += '<div class="session panel-item"><div class="session-main"><div class="session-title">' + esc(s.title || s.id) + ' <span class="badge">' + esc(s.cwdMatch || 'other') + '</span></div><div class="session-meta">ID: ' + esc(s.id) + '</div><div class="session-meta">CWD: ' + esc(s.cwd || '—') + '</div><div class="session-meta">Updated: ' + esc(fmtTime(s.updatedAt)) + '</div><div class="session-preview">' + esc(s.preview || '') + '</div></div><div class="session-actions"><button data-session="' + esc(s.id) + '" class="primary">Select</button></div></div>'; });
    html += '</div></div>';
    picker.innerHTML = html;
  }
  function renderApproval(){
    var box = document.getElementById('approvalBox'); var a = snap.approval;
    if(!a){ box.classList.add('hidden'); box.innerHTML=''; return; }
    var p = a.params || {}; var cmd = Array.isArray(p.command) ? p.command.join(' ') : (p.command || '');
    box.classList.remove('hidden');
    box.innerHTML = '<div class="approval-modal"><div class="approval-head"><b>Approval required</b><span>Auto-decline in <b>' + esc(fmtCountdown(a.expiresAt)) + '</b></span></div><pre>Method: ' + esc(a.method) + '\\nCommand: ' + esc(cmd || '—') + '\\nCWD: ' + esc(p.cwd || '—') + '\\nReason: ' + esc(p.reason || '—') + '</pre><div class="actions"><button data-approval="accept" class="primary">Accept once</button><button data-approval="accept-for-session">Accept for session</button><button data-approval="decline">Decline</button><button data-approval="cancel" class="danger">Cancel turn</button></div></div>';
  }
  function openConfirm(action, title, message, yesText, danger, data){
    confirmAction = { action:action, title:title, message:message, yesText:yesText, danger:!!danger, data:data || {} };
    renderConfirm();
  }
  function closeConfirm(){
    confirmAction = null;
    renderConfirm();
  }
  function renderConfirm(){
    var box = document.getElementById('confirmBox');
    if(!box) return;
    if(!confirmAction) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    box.innerHTML = '<div class="confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirmTitle"><div class="confirm-head"><b id="confirmTitle">' + esc(confirmAction.title) + '</b></div><p>' + esc(confirmAction.message) + '</p><div class="actions"><button id="confirmYesBtn" class="' + (confirmAction.danger ? 'danger' : 'primary') + '">' + esc(confirmAction.yesText || 'Yes') + '</button><button id="confirmCancelBtn">Cancel</button></div></div>';
  }
  function confirmCurrentAction(){
    var action = confirmAction && confirmAction.action;
    var data = confirmAction && confirmAction.data || {};
    closeConfirm();
    if(action === 'interrupt') api('/api/control/interrupt').then(function(r){ if(r.message) alert(r.message); }).catch(function(e){ alert(e.message); });
    else if(action === 'stop') api('/api/control/stop').catch(function(e){ alert(e.message); });
    else if(action === 'remove') api('/api/queue/remove', { id:data.id }).catch(function(e){ alert(e.message); });
  }
  function openScheduleModal(){
    var app = snap && snap.app || {};
    scheduleDraft = {
      date: localDateValue(app.scheduledRunAt || null),
      time: localTimeValue(app.scheduledRunAt || null)
    };
    scheduleOpen = true;
    renderScheduleModal();
  }
  function closeScheduleModal(){
    scheduleOpen = false;
    scheduleDraft = null;
    renderScheduleModal();
  }
  function renderScheduleModal(){
    var box = document.getElementById('scheduleBox');
    if(!box) return;
    if(!scheduleOpen) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    var app = snap && snap.app || {};
    var scheduled = app.scheduledRunAt || '';
    box.classList.remove('hidden');
    box.innerHTML = '<div class="confirm-modal schedule-modal" role="dialog" aria-modal="true" aria-labelledby="scheduleTitle">' +
      '<div class="modal-head"><b id="scheduleTitle">Schedule queue</b><button id="scheduleCloseBtn" class="icon-only" title="Close">×</button></div>' +
      '<div class="schedule-fields">' +
        '<label><span>Date</span><input id="scheduleDateInput" type="date" value="' + esc(scheduleDraft ? scheduleDraft.date : localDateValue(scheduled)) + '"></label>' +
        '<label><span>Time</span><input id="scheduleTimeInput" type="time" value="' + esc(scheduleDraft ? scheduleDraft.time : localTimeValue(scheduled)) + '"></label>' +
      '</div>' +
      (scheduled ? '<div class="schedule-current">Current: ' + esc(fmtRunMeta(scheduled)) + '</div>' : '') +
      '<div class="actions schedule-actions">' +
        '<button id="scheduleSaveBtn" class="primary">Save</button>' +
        (scheduled ? '<button id="scheduleResetBtn">Reset</button>' : '') +
        '<button id="scheduleCancelQueueBtn" class="danger">Cancel queue</button>' +
      '</div>' +
    '</div>';
  }
  function renderQueue(){
    var q = snap.queue || []; var el = document.getElementById('queue'); var app = snap.app || {};
    if(!q.length){ el.innerHTML = '<div class="empty">Queue is empty.</div>'; return; }
    var filtered = q.filter(queueMatchesFilter);
    if(!filtered.length){ el.innerHTML = '<div class="empty">No items match this filter.</div>'; return; }
    var html = '';
    filtered.forEach(function(item){
      var i = q.indexOf(item);
      var active = item.status === 'sending' || item.status === 'sent';
      var completed = item.status === 'completed';
      var running = item.status === 'sending' || item.status === 'sent';
      var canMoveUp = canMoveQueueItem(q, i, 'up');
      var canMoveDown = canMoveQueueItem(q, i, 'down');
      var editing = editingQueueItemId === item.id && !completed && !running;
      var expanded = !!expandedQueueItems[item.id] || editing;
      var text = expanded ? (item.text || item.preview || '') : (item.preview || item.text || '');
      var idAttr = esc(item.id);
      var toggleAttrs = editing ? '' : ' data-toggle-prompt="1" data-id="' + idAttr + '" role="button" tabindex="0" title="Click to ' + (expanded ? 'collapse' : 'expand') + ' prompt"';
      html += '<div class="queue-item ' + (active ? 'active ' : '') + (running ? 'running ' : '') + (completed ? 'completed ' : '') + (expanded ? 'expanded ' : '') + (editing ? 'editing' : '') + '" data-queue-id="' + idAttr + '">' +
        '<div class="queue-top"><span>#' + (i+1) + ' <span class="status ' + esc(item.status) + '">' + esc(item.status) + '</span> · ' + item.lineCount + ' lines</span><span>' + esc(fmtTime(completed && item.finishedAt ? item.finishedAt : item.createdAt)) + '</span></div>';
      if(editing) {
        var draft = Object.prototype.hasOwnProperty.call(editDrafts, item.id) ? editDrafts[item.id] : (item.text || '');
        html += '<textarea class="queue-edit" data-edit-text="' + idAttr + '" spellcheck="false">' + esc(draft) + '</textarea>';
      } else {
        html += '<div class="prompt-preview" aria-label="' + esc(item.text || item.preview || '') + '"' + toggleAttrs + '>' + esc(text || '') + '</div>';
      }
      if(item.error) html += '<div class="prompt-error">' + esc(item.error) + '</div>';
      if(editing) {
        html += '<div class="actions queue-actions"><button data-act="saveEdit" data-id="' + idAttr + '" class="primary">Save</button><button data-act="cancelEdit" data-id="' + idAttr + '">Cancel</button></div>';
      } else if(!completed && !running) {
        html += '<div class="actions queue-actions"><button data-act="edit" data-id="' + idAttr + '">Edit</button><button data-act="duplicate" data-id="' + idAttr + '">Duplicate</button><button data-act="up" data-id="' + idAttr + '"' + (canMoveUp ? '' : ' disabled') + '>Up</button><button data-act="down" data-id="' + idAttr + '"' + (canMoveDown ? '' : ' disabled') + '>Down</button><button data-act="sendNow" data-id="' + idAttr + '">Send</button><button data-act="remove" data-id="' + idAttr + '" class="danger">Remove</button>';
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
    if(activeEditId) editDrafts[activeEditId] = activeEdit.value;
    el.innerHTML = html;
    if(pendingQueueScrollId) {
      var target = Array.prototype.find.call(el.querySelectorAll('[data-queue-id]'), function(node){ return node.dataset.queueId === pendingQueueScrollId; });
      if(target) {
        pendingQueueScrollId = null;
        target.scrollIntoView({ behavior:'smooth', block:'center' });
      }
    } else if(!didInitialQueueScroll) {
      didInitialQueueScroll = true;
      var firstOpenItem = q.find(function(item){ return item.status !== 'completed'; });
      if(firstOpenItem) {
        var firstTarget = Array.prototype.find.call(el.querySelectorAll('[data-queue-id]'), function(node){ return node.dataset.queueId === firstOpenItem.id; });
        if(firstTarget) firstTarget.scrollIntoView({ block:'center' });
      }
    }
    if(editingQueueItemId) {
      var editor = el.querySelector('[data-edit-text]');
      if(editor && (pendingEditFocusId === editingQueueItemId || activeEditId === editingQueueItemId)) {
        if(activeEditSelection && activeEditId === editingQueueItemId) {
          editor.value = activeEditSelection.value;
          editDrafts[editingQueueItemId] = activeEditSelection.value;
        }
        editor.focus();
        if(pendingEditFocusId === editingQueueItemId) {
          editor.selectionStart = editor.selectionEnd = editor.value.length;
          pendingEditFocusId = null;
        } else if(activeEditSelection && activeEditId === editingQueueItemId) {
          editor.selectionStart = activeEditSelection.start;
          editor.selectionEnd = activeEditSelection.end;
          editor.scrollTop = activeEditSelection.scrollTop;
        }
      }
    }
  }
  function outputLabel(type, text){
    var labels = { error:'Error', stderr:'Stderr', system:'System', turn:'Turn', send:'Send', prompt:'Prompt', tool:'Tool', 'tool-delta':'Tool', reasoning:'Reasoning', 'reasoning-delta':'Reasoning', plan:'Plan', diff:'Diff', item:'Item', event:'Event', delta:'Assistant', 'context-delta':'Context' };
    var label = labels[type] || 'Output';
    var body = String(text == null ? '' : text);
    var m = body.match(/^\[([^\]]+)\]\s*/);
    if(m && type !== 'diff') {
      label = labels[m[1]] || (m[1].charAt(0).toUpperCase() + m[1].slice(1));
      body = body.slice(m[0].length);
    }
    return { label:label, body:body };
  }
  function renderOutputLine(l){
    var type = l.type || 'text';
    var meta = outputLabel(type, l.text);
    if(type === 'diff') {
      var diffId = esc(l.id || '');
      var expanded = !!expandedDiffOutput[l.id];
      var lineCount = String(meta.body || '').split(/\r?\n/).length;
      var firstLine = String(meta.body || '').split(/\r?\n/).find(function(line){ return line.trim(); }) || 'Diff updated';
      return '<div class="out-line diff ' + (expanded ? 'expanded' : 'collapsed') + '"><div class="out-diff-card"><button type="button" class="out-diff-toggle" data-output-diff="' + diffId + '"><span>' + (expanded ? 'Collapse' : 'Expand') + ' diff</span><b>' + lineCount + ' lines</b><em>' + esc(firstLine) + '</em></button>' + (expanded ? '<pre class="out-body">' + esc(meta.body) + '</pre>' : '') + '</div></div>';
    }
    var block = type === 'diff' || type === 'prompt' || type === 'plan' || type === 'tool-delta' || type === 'delta' || type === 'reasoning-delta' || type === 'context-delta';
    return '<div class="out-line ' + esc(type) + '"><span class="out-label">' + esc(meta.label) + '</span>' + (block ? '<pre class="out-body">' + esc(meta.body) + '</pre>' : '<span class="out-body">' + esc(meta.body) + '</span>') + '</div>';
  }
  function renderOutput(){
    var atBottom = outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight < 30;
    outputEl.innerHTML = (snap.output || []).map(renderOutputLine).join('');
    if(atBottom) outputEl.scrollTop = outputEl.scrollHeight;
  }
  function updateCounter(){ var text = composer.value; var lines = text ? text.split(/\r?\n/).length : 0; document.getElementById('counter').textContent = 'Lines: ' + lines + ' · Chars: ' + text.length; setButtonState('addBtn', !text.trim(), false); }
  function addQueue(){ api('/api/queue/add', { text: composer.value }).then(function(r){ if(r.item && r.item.id) pendingQueueScrollId = r.item.id; if(r.clearComposer) composer.value=''; if(r.composerText !== undefined) composer.value = r.composerText; if(r.message) alert(r.message); updateCounter(); getState(); }).catch(function(e){ alert(e.message); }); }
  function sendComposerNow(){ api('/api/queue/send-composer', { text: composer.value }).then(function(r){ if(r.clearComposer) composer.value=''; if(r.composerText !== undefined) composer.value = r.composerText; if(r.message) alert(r.message); updateCounter(); getState(); }).catch(function(e){ alert(e.message); }); }
  document.addEventListener('click', function(ev){
    var rawTarget = ev.target && ev.target.nodeType === 3 ? ev.target.parentElement : ev.target;
    var t = rawTarget && rawTarget.closest ? (rawTarget.closest('button,[data-act],[data-session],[data-approval],[data-queue-filter],[data-output-diff],[data-toggle-prompt]') || rawTarget) : rawTarget;
    var queueMenuWrap = t.closest && t.closest('.menu-wrap');
    if(!queueMenuWrap) setQueueMenuOpen(false);
    var promptToggle = t.closest && t.closest('[data-toggle-prompt]');
    if(promptToggle) {
      var promptId = promptToggle.dataset.id;
      var itemForToggle = (snap.queue || []).find(function(x){return x.id === promptId;});
      if(itemForToggle) {
        expandedQueueItems[promptId] = !expandedQueueItems[promptId];
        renderQueue();
      }
      return;
    }
    var queueFilter = t.closest && t.closest('[data-queue-filter]');
    if(queueFilter) {
      activeQueueFilter = queueFilter.dataset.queueFilter;
      renderHeader();
      renderQueue();
      return;
    }
    var diffToggle = t.closest && t.closest('[data-output-diff]');
    if(diffToggle) {
      expandedDiffOutput[diffToggle.dataset.outputDiff] = !expandedDiffOutput[diffToggle.dataset.outputDiff];
      renderOutput();
      return;
    }
    var mobileCollapseBtn = t.closest && t.closest('#headerCollapseBtn, #limitsCollapseBtn, #queueCollapseBtn');
    if(mobileCollapseBtn) {
      if(mobileCollapseBtn.id === 'headerCollapseBtn') setMobileCollapsed('header', !mobileCollapsed.header);
      else if(mobileCollapseBtn.id === 'limitsCollapseBtn') setMobileCollapsed('limits', !mobileCollapsed.limits);
      else if(mobileCollapseBtn.id === 'queueCollapseBtn') setMobileCollapsed('queue', !mobileCollapsed.queue);
    }
    else if(t.id === 'addBtn') addQueue();
    else if(t.id === 'cancelSendBtn') api('/api/control/cancel-send');
    else if(t.id === 'pauseBtn') api('/api/control/pause');
    else if(t.id === 'resumeBtn') api('/api/control/resume');
    else if(t.id === 'scheduleBtn') openScheduleModal();
    else if(t.id === 'interruptBtn') openConfirm('interrupt', 'Interrupt prompt?', 'The current running prompt will be interrupted. The queue will remain available after the turn stops.', 'Yes, interrupt', true);
    else if(t.id === 'undoBtn') api('/api/queue/undo').then(function(r){ if(r.composerText !== undefined) composer.value = r.composerText; if(r.message) alert(r.message); updateCounter(); });
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
    else if(t.id === 'scheduleResetBtn') api('/api/queue/schedule-reset').then(function(){ closeScheduleModal(); getState(); }).catch(function(e){ alert(e.message); });
    else if(t.id === 'scheduleCancelQueueBtn') api('/api/queue/cancel-run').then(function(){ closeScheduleModal(); getState(); }).catch(function(e){ alert(e.message); });
    else if(t.id === 'clearOutputBtn') api('/api/output/clear');
    else if(t.id === 'bottomBtn') outputEl.scrollTop = outputEl.scrollHeight;
    else if(t.id === 'themeBtn') {
      var nextTheme = snap && snap.app && snap.app.theme === 'light' ? 'dark' : 'light';
      api('/api/config/theme', { theme:nextTheme }).catch(function(e){ alert(e.message); });
    }
    else if(t.id === 'createSessionBtn') api('/api/session/create').catch(function(e){ alert(e.message); });
    else if(t.id === 'reloadSessionsBtn') api('/api/session/reload');
    else if(t.id === 'changeSessionBtn') api('/api/session/reload').catch(function(e){ alert(e.message); });
    else if(t.id === 'cancelSessionChangeBtn') api('/api/session/cancel-change').catch(function(e){ alert(e.message); });
    else if(t.dataset.session) api('/api/session/select', { sessionId:t.dataset.session }).catch(function(e){ alert(e.message); });
    else if(t.dataset.approval) api('/api/approval/respond', { decision:t.dataset.approval }).catch(function(e){ alert(e.message); });
    else if(t.dataset.act){
      var id = t.dataset.id; var act = t.dataset.act; var itemIndex = (snap.queue || []).findIndex(function(x){return x.id === id;}); var item = itemIndex >= 0 ? snap.queue[itemIndex] : null;
      if(act === 'remove') openConfirm('remove', 'Remove prompt?', 'This prompt will be removed from the queue.', 'Yes, remove', true, { id:id });
      else if(act === 'up' || act === 'down') {
        if(canMoveQueueItem(snap.queue || [], itemIndex, act)) api('/api/queue/reorder', { id:id, direction:act });
      }
      else if(act === 'edit') { editingQueueItemId = id; editDrafts[id] = item ? item.text || '' : ''; pendingEditFocusId = id; expandedQueueItems[id] = true; renderQueue(); }
      else if(act === 'cancelEdit') { delete editDrafts[id]; editingQueueItemId = null; renderQueue(); }
      else if(act === 'saveEdit') {
        var editor = document.querySelector('[data-edit-text="' + id + '"]');
        api('/api/queue/update', { id:id, action:'edit', text:editor ? editor.value : '' }).then(function(){ delete editDrafts[id]; editingQueueItemId = null; getState(); }).catch(function(e){ alert(e.message); });
      }
      else api('/api/queue/update', { id:id, action:act });
    }
  });
  document.addEventListener('input', function(ev){
    var t = ev.target;
    if(t && t.dataset && t.dataset.editText) editDrafts[t.dataset.editText] = t.value;
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
      if(scheduleOpen) {
        ev.preventDefault();
        closeScheduleModal();
        return;
      }
      if(confirmAction) {
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
      if(editingQueueItemId) { delete editDrafts[editingQueueItemId]; editingQueueItemId = null; renderQueue(); return; }
      api(snap && snap.app && snap.app.state === 'countdown' ? '/api/control/cancel-send' : '/api/control/pause');
      return;
    }
    if(scheduleOpen && ev.key === 'Enter' && !(t && t.tagName === 'BUTTON')) {
      ev.preventDefault();
      var scheduledRunAt = scheduleInputIso();
      if(!scheduledRunAt) { alert('Select a valid time.'); return; }
      api('/api/queue/schedule', { scheduledRunAt:scheduledRunAt }).then(function(){ closeScheduleModal(); getState(); }).catch(function(e){ alert(e.message); });
      return;
    }
    if(confirmAction && ev.key === 'Enter') {
      ev.preventDefault();
      confirmCurrentAction();
      return;
    }
    if(t && t.dataset && t.dataset.editText && (ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
      ev.preventDefault();
      api('/api/queue/update', { id:t.dataset.editText, action:'edit', text:t.value }).then(function(){ delete editDrafts[t.dataset.editText]; editingQueueItemId = null; getState(); }).catch(function(e){ alert(e.message); });
      return;
    }
    if(t && t.dataset && t.dataset.togglePrompt && (ev.key === 'Enter' || ev.key === ' ')) {
      ev.preventDefault();
      var item = (snap.queue || []).find(function(x){return x.id === t.dataset.id;});
      if(item) {
        expandedQueueItems[t.dataset.id] = !expandedQueueItems[t.dataset.id];
        renderQueue();
      }
    }
  });
  composer.addEventListener('input', updateCounter);
  composer.addEventListener('keydown', function(ev){
    if((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter'){ ev.preventDefault(); sendComposerNow(); }
  });
  if(compactHeaderQuery) {
    if(compactHeaderQuery.addEventListener) compactHeaderQuery.addEventListener('change', function(){ if(snap) renderHeader(); });
    else if(compactHeaderQuery.addListener) compactHeaderQuery.addListener(function(){ if(snap) renderHeader(); });
  }
  updateCounter();
  setInterval(function(){ if(snap) renderHeader(); }, 30000);
  setInterval(function(){ if(snap && snap.approval) renderApproval(); }, 1000);
  var es = new EventSource('/events?token=' + encodeURIComponent(TOKEN));
  es.addEventListener('state', function(ev){ update(JSON.parse(ev.data)); });
  es.addEventListener('output', function(ev){ if(!snap) return; snap.output = JSON.parse(ev.data); renderKeys.output = sectionKey('output', snap); renderOutput(); });
  es.addEventListener('done', function(){ es.close(); });
  es.onerror = function(){ setTimeout(getState, 1000); };
  getState();
})();
