import { state } from '#core/state';
import { esc, fmtClock, fmtRelative, fmtRunMeta, pct, windowLabel } from '#utils/format';
import { envChip, metaItem, queueTab, sessionMetaItem } from '#ui/html';

function isCompactHeader(){
  return !!(state.compactHeaderQuery && state.compactHeaderQuery.matches);
}

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

export function renderTheme(app){
  var theme = app.theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  var btn = document.getElementById('themeBtn');
  if(btn) {
    btn.textContent = theme === 'light' ? '☀' : '☾';
    btn.title = 'Switch to ' + (theme === 'light' ? 'dark' : 'light') + ' theme';
  }
}

export function setButtonState(id, disabled, hidden){
  var btn = document.getElementById(id);
  if(!btn) return;
  btn.disabled = !!disabled;
  btn.classList.toggle('hidden', !!hidden);
}

export function setQueueMenuOpen(open){
  var menu = document.getElementById('queueMenu');
  var btn = document.getElementById('queueMenuBtn');
  if(menu) menu.classList.toggle('hidden', !open);
  if(btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function renderControls(app, counts){
  counts = counts || {};
  var currentState = app.state || '';
  var hasSession = !!app.sessionId;
  var pending = counts.pending || 0;
  var canPause = hasSession && !!app.canPause;
  var canResume = hasSession && !!app.canResume;
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
  if(countdownNotice) countdownNotice.classList.toggle('hidden', currentState !== 'countdown');
}

export function renderHeader(){
  var snap = state.snap || {};
  var app = snap.app || {};
  var rl = snap.rateLimits || {};
  var c = app.queueCounts || {};
  renderTheme(app);

  var stateBadge = document.getElementById('stateBadge');
  if(stateBadge) {
    stateBadge.textContent = app.state || 'unknown';
    stateBadge.title = app.state || 'unknown';
    stateBadge.className = 'badge ' + (app.state === 'error' ? 'danger' : (app.state === 'paused' || app.state === 'scheduled' || app.state === 'waiting-limits' || app.state === 'approval-required' ? 'warn' : 'ok'));
  }

  var limitBadge = document.getElementById('limitBadge');
  if(limitBadge) {
    limitBadge.textContent = limitBadgeText(rl.status);
    limitBadge.title = fullLimitBadgeText(rl.status);
    limitBadge.className = 'badge ' + (rl.status === 'available' ? 'ok' : (rl.status === 'limited' ? 'warn' : 'danger'));
  }

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
    queueTab('all', 'All', queueTotal, state.activeQueueFilter === 'all') +
    queueTab('pending', 'Pending', c.pending || 0, state.activeQueueFilter === 'pending') +
    queueTab('running', 'Running', (c.sending || 0) + (c.sent || 0), state.activeQueueFilter === 'running') +
    queueTab('completed', 'Done', c.completed || 0, state.activeQueueFilter === 'completed');

  var env = document.getElementById('envMeta');
  if(env) env.innerHTML =
    envChip('Sandbox', app.sandbox || '—', true) +
    envChip('Approval', app.approvalPolicy || '—', true) +
    envChip('Network', String(app.network), !!app.network);

  var meta = document.getElementById('meta');
  if(meta) meta.innerHTML =
    metaItem('Project', app.projectDir) +
    sessionMetaItem(app, sessionTitle, sessionTitle) +
    metaItem('Session ID', sessionId) +
    metaItem(nextRun.label, nextRun.value);

  renderLimitStats();
  applyMobileCollapseState();
}

export function renderLimitStats(){
  var el = document.getElementById('limitStats');
  if(!el) return;
  var rl = (state.snap && state.snap.rateLimits) || {};
  var buckets = rl.buckets || [];
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

export function setMobileCollapsed(section, collapsed){
  state.mobileCollapsed[section] = !!collapsed;
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

export function applyMobileCollapseState(){
  document.body.classList.toggle('mobile-header-collapsed', state.mobileCollapsed.header);
  document.body.classList.toggle('mobile-limits-collapsed', state.mobileCollapsed.limits);
  document.body.classList.toggle('mobile-queue-collapsed', state.mobileCollapsed.queue);
  updateCollapseButton('headerCollapseBtn', state.mobileCollapsed.header, 'header');
  updateCollapseButton('limitsCollapseBtn', state.mobileCollapsed.limits, 'limits');
  updateCollapseButton('queueCollapseBtn', state.mobileCollapsed.queue, 'queue');
}
