import { state } from '#core/state';
import { esc, fmtClock, fmtRelative, fmtRunMeta, pct, windowLabel } from '#utils/format';
import { byId, setText } from '#utils/dom';
import { envChip, metaItem, queueTab, sessionMetaItem } from '#ui/html';

const WARNING_STATES = new Set(['paused', 'scheduled', 'waiting-limits', 'approval-required']);
const STATE_BADGE_LABELS = {
  'waiting-limits': 'waiting',
};
const RUNNING_COUNT_KEYS = ['sending', 'sent'];
const PENDING_TAB_COUNT_KEYS = ['pending', ...RUNNING_COUNT_KEYS];
const TOTAL_COUNT_KEYS = ['pending', 'sending', 'sent', 'completed', 'failed', 'unknown'];

function isCompactHeader() {
  return Boolean(state.compactHeaderQuery?.matches);
}

function fullLimitBadgeText(status) {
  if (status === 'limited') return 'limits waiting';
  if (status === 'available') return 'limits available';
  return 'unknown';
}

function limitBadgeText(status) {
  return isCompactHeader() ? 'limits' : fullLimitBadgeText(status);
}

function countByKeys(counts, keys) {
  return keys.reduce((sum, key) => sum + (counts[key] || 0), 0);
}

function setBadge(element, text, title, className) {
  if (!element) return;
  element.textContent = text;
  element.title = title;
  element.className = `badge ${className}`;
}

function stateBadgeText(appState) {
  return STATE_BADGE_LABELS[appState] || appState || 'unknown';
}

function networkStatusBadge(appNetwork) {
  const clientNetwork = state.clientNetwork || {};

  if (clientNetwork.status === 'offline') {
    return { text: 'offline', className: 'danger', ok: false, title: clientNetwork.message || 'server unavailable' };
  }

  if (clientNetwork.status === 'reconnecting') {
    return { text: 'reconnecting', className: 'warn', ok: false, title: clientNetwork.message || 'reconnecting to server' };
  }

  if (clientNetwork.status === 'connecting') {
    return { text: 'connecting', className: 'warn', ok: false, title: clientNetwork.message || 'connecting to server' };
  }

  const serverNetwork = appNetwork == null || appNetwork === '' ? '—' : String(appNetwork);
  return {
    text: 'connected',
    className: 'ok',
    ok: true,
    title: `connected; app network: ${serverNetwork}`,
  };
}

function renderOptions(select, options, value, fallbackLabel) {
  const html = options
    .map((option) => `<option value="${esc(option.value)}">${esc(option.label || option.value || fallbackLabel)}</option>`)
    .join('');

  if (select.innerHTML !== html) select.innerHTML = html;
  select.value = value;
}

function renderModelOptions(select, app) {
  const model = app.model || '';
  const existingOptions = app.modelOptions || [];
  const options = model && !existingOptions.some((option) => option.value === model)
    ? [...existingOptions, { value: model, label: model }]
    : existingOptions;

  renderOptions(select, options, model, `${app.defaultModel || 'default'} (default)`);
  select.title = `Current model: ${model || app.defaultModel || 'default'}`;
}

function renderEffortOptions(select, app) {
  const effort = app.effort || '';
  renderOptions(select, app.effortOptions || [], effort, 'default');
  select.title = `Current effort: ${effort || 'default'}`;
}

export function renderTheme(app) {
  const theme = app.theme === 'light' ? 'light' : 'dark';
  const themeButton = byId('themeBtn');

  document.documentElement.dataset.theme = theme;

  if (themeButton) {
    themeButton.textContent = theme === 'light' ? '☀' : '☾';
    themeButton.title = `Switch to ${theme === 'light' ? 'dark' : 'light'} theme`;
  }
}

export function setButtonState(id, disabled, hidden) {
  const button = byId(id);
  if (!button) return;

  button.disabled = Boolean(disabled);
  button.classList.toggle('hidden', Boolean(hidden));
}

export function setQueueMenuOpen(open) {
  const menu = byId('queueMenu');
  const button = byId('queueMenuBtn');

  if (menu) menu.classList.toggle('hidden', !open);
  if (button) button.setAttribute('aria-expanded', open ? 'true' : 'false');
}

export function setOutputMenuOpen(open) {
  const menu = byId('outputMenu');
  const button = byId('outputMenuBtn');

  if (menu) menu.classList.toggle('hidden', !open);
  if (button) button.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function renderControlState(app, counts = {}) {
  const hasSession = Boolean(app.sessionId);
  const pending = counts.pending || 0;
  const completed = counts.completed || 0;

  setButtonState('undoBtn', false, pending === 0);
  setButtonState('undoMenuBtn', false, pending === 0);
  setButtonState('clearBtn', false, pending === 0);
  setButtonState('clearCompletedBtn', false, completed === 0);
  setButtonState('queueMenuBtn', pending === 0 && completed === 0, false);
  setButtonState('pauseBtn', !(hasSession && app.canPause), false);
  setButtonState('resumeBtn', !(hasSession && app.canResume), false);
  setButtonState('scheduleBtn', !app.canScheduleQueue, false);
  setButtonState('interruptBtn', false, !app.canInterrupt);
  setButtonState('cancelSendBtn', false, false);

  const countdownNotice = byId('countdownNotice');
  if (countdownNotice) countdownNotice.classList.toggle('hidden', app.state !== 'countdown');

  renderStatusNotice(app, counts);
}

export function hideStatusNotice() {
  const notice = byId('statusNotice');
  if (state.noticeTimer) {
    clearTimeout(state.noticeTimer);
    state.noticeTimer = null;
  }
  if (notice) notice.classList.add('hidden');
}

function showStatusNotice(text, key) {
  const notice = byId('statusNotice');
  if (!notice || !text || state.lastNoticeKey === key) return;

  state.lastNoticeKey = key;
  notice.textContent = text;
  notice.classList.remove('hidden');

  if (state.noticeTimer) clearTimeout(state.noticeTimer);
  state.noticeTimer = setTimeout(() => {
    notice.classList.add('hidden');
    state.noticeTimer = null;
  }, 4500);
}

function renderStatusNotice(app, counts = {}) {
  const snapshot = {
    appState: app.state || '',
    pending: counts.pending || 0,
    sending: counts.sending || 0,
    sent: counts.sent || 0,
    completed: counts.completed || 0,
    failed: counts.failed || 0,
    unknown: counts.unknown || 0,
  };
  const previous = state.previousNoticeSnapshot;
  state.previousNoticeSnapshot = snapshot;

  if (snapshot.sending + snapshot.sent > 0 || ['countdown', 'sending', 'streaming'].includes(snapshot.appState)) {
    state.noticeArmed = true;
  }

  if (snapshot.appState === 'countdown') {
    hideStatusNotice();
    return;
  }

  if (!previous || !state.noticeArmed) return;

  if (snapshot.appState === 'done' && previous.appState !== 'done') {
    showStatusNotice('Queue is done!', `done:${snapshot.completed}:${snapshot.failed}:${snapshot.unknown}`);
    state.noticeArmed = false;
    return;
  }

  const hadRunningPrompt = previous.sending + previous.sent > 0 || ['sending', 'streaming'].includes(previous.appState);
  const noRunningPrompt = snapshot.sending + snapshot.sent === 0;
  const hasPendingQueue = snapshot.pending > 0;
  if (snapshot.appState === 'paused' && hasPendingQueue && noRunningPrompt && hadRunningPrompt) {
    showStatusNotice('Prompt is finished', `prompt:${snapshot.completed}:${snapshot.failed}:${snapshot.unknown}:${snapshot.pending}`);
    state.noticeArmed = false;
  }
}

function renderStateBadges(app, rateLimits) {
  const appState = app.state || 'unknown';
  const stateClass = appState === 'error' ? 'danger' : WARNING_STATES.has(appState) ? 'warn' : 'ok';
  const limitsClass = rateLimits.status === 'available' ? 'ok' : rateLimits.status === 'limited' ? 'warn' : 'danger';

  setBadge(byId('stateBadge'), stateBadgeText(appState), appState, stateClass);
  setBadge(byId('limitBadge'), limitBadgeText(rateLimits.status), fullLimitBadgeText(rateLimits.status), limitsClass);
}

function nextRunMeta(app, rateLimits) {
  if (app.scheduledRunAt) return { label: 'Schedule', value: fmtRunMeta(app.scheduledRunAt) };
  if (app.state === 'waiting-limits') {
    return {
      label: 'Limit reset',
      value: rateLimits.resetAt ? fmtRunMeta(new Date(rateLimits.resetAt * 1000).toISOString()) : '—',
    };
  }
  return { label: 'Next run', value: '—' };
}

function renderQueueTabs(counts, total) {
  const tabs = byId('queueTabs');
  if (!tabs) return;

  if (state.activeQueueFilter === 'running') {
    state.activeQueueFilter = 'pending';
  }

  tabs.innerHTML = [
    queueTab('all', 'All', total, state.activeQueueFilter === 'all'),
    queueTab('pending', 'Pending', countByKeys(counts, PENDING_TAB_COUNT_KEYS), state.activeQueueFilter === 'pending'),
    queueTab('completed', 'Done', counts.completed || 0, state.activeQueueFilter === 'completed'),
  ].join('');
}

function renderEnvMeta(app) {
  const env = byId('envMeta');
  if (!env) return;

  const networkBadge = networkStatusBadge(app.network);

  env.innerHTML = [
    envChip('Sandbox', app.sandbox || '—', true),
    envChip('Approval', app.approvalPolicy || '—', true),
    envChip('Network', networkBadge.text, networkBadge.ok, networkBadge.title, networkBadge.className),
  ].join('');
}

function renderProjectMeta(app, nextRun) {
  const meta = byId('meta');
  if (!meta) return;

  const sessionTitle = app.sessionTitle || 'not selected';
  const sessionId = app.sessionId || '—';

  meta.innerHTML = [
    metaItem('Project', app.projectDir),
    sessionMetaItem(app, sessionTitle, sessionTitle, app.projectDir),
    metaItem('Session ID', sessionId),
    metaItem(nextRun.label, nextRun.value),
  ].join('');
}

function renderLimitWindow(windowInfo) {
  const used = pct(windowInfo.usedPercent);
  const remaining = pct(windowInfo.remainingPercent) ?? (used == null ? null : Math.max(0, 100 - used));
  const barClass = remaining == null ? 'unknown' : remaining > 60 ? 'ok' : remaining >= 25 ? 'warn' : 'danger';
  const label = windowLabel(windowInfo);
  const resetText = fmtRelative(windowInfo.resetsAt);
  const title = `${label}: ${remaining == null ? 'remaining unknown' : `${Math.round(remaining)}% left`}; reset ${fmtClock(windowInfo.resetsAt)} · in ${resetText}`;

  return `
    <div class="limit-row" title="${esc(title)}">
      <span class="limit-row-label">${esc(label)}</span>
      <div class="limit-bar ${barClass}"><span style="width:${remaining == null ? 0 : remaining}%"></span></div>
      <b>${remaining == null ? '—' : `${Math.round(remaining)}%`}</b>
      <span class="limit-row-reset">${esc(resetText)}</span>
    </div>
  `;
}

function windowsForBucket(bucket) {
  if (bucket.windows?.length) return bucket.windows;

  return [{
    name: 'primary',
    usedPercent: bucket.usedPercent,
    remainingPercent: bucket.usedPercent == null ? null : 100 - bucket.usedPercent,
    windowDurationMins: bucket.windowDurationMins,
    resetsAt: bucket.resetsAt,
  }];
}

function rateLimitsRefreshStatus(show) {
  return show
    ? '<em class="limit-refresh-status" title="Refreshing rate-limit data">(refreshing)</em>'
    : '';
}

function resetCreditCount(rateLimits) {
  return Number(rateLimits?.resetCredits?.availableCount || 0) || 0;
}

function limitResetButton(rateLimits) {
  const count = resetCreditCount(rateLimits);
  return count > 0
    ? `<div class="limit-reset-action"><button id="limitResetOpenBtn" type="button">Use limit Reset</button></div>`
    : '';
}

function limitsCollapseButton() {
  return '<button id="limitsCollapseBtn" class="mobile-collapse-btn icon-only" title="Collapse limits" aria-expanded="true">⌃</button>';
}

function renderLimitCard(bucket, showRefreshStatus = false, showCollapseButton = false) {
  return `
    <div class="limit-card">
      <div class="limit-card-head"><span>Limits</span>
        <b>${esc(bucket.limitName || bucket.limitId || 'limit')}</b>
        ${rateLimitsRefreshStatus(showRefreshStatus)}
        ${showCollapseButton ? limitsCollapseButton() : ''}
      </div>
      ${windowsForBucket(bucket).map(renderLimitWindow).join('')}
    </div>
  `;
}

export function renderLimitStats() {
  const element = byId('limitStats');
  if (!element) return;

  const rateLimits = state.snap?.rateLimits || {};
  const buckets = rateLimits.buckets || [];
  const isRefreshing = rateLimits.refreshing === true;

  element.innerHTML = buckets.length
    ? buckets.map((bucket, index) => renderLimitCard(bucket, index === 0 && isRefreshing, index === 0)).join('')
    : `<div class="limit-card muted"><div class="limit-card-head"><span>Limits</span>${rateLimitsRefreshStatus(isRefreshing)}${limitsCollapseButton()}</div><p>Rate-limit data unavailable.</p>${limitResetButton(rateLimits)}</div>`;
}

export function renderHeader() {
  const snapshot = state.snap || {};
  const app = snapshot.app || {};
  const rateLimits = snapshot.rateLimits || {};
  const counts = app.queueCounts || {};
  const queueTotal = countByKeys(counts, TOTAL_COUNT_KEYS);
  const nextRun = nextRunMeta(app, rateLimits);

  renderTheme(app);
  renderStateBadges(app, rateLimits);
  renderControlState(app, counts);
  renderQueueTabs(counts, queueTotal);
  renderEnvMeta(app);
  renderProjectMeta(app, nextRun);
  renderLimitStats();
  applyMobileCollapseState();

  setText(byId('queueCountBadge'), queueTotal);

  const modelSelect = byId('modelSelect');
  if (modelSelect) renderModelOptions(modelSelect, app);

  const effortSelect = byId('effortSelect');
  if (effortSelect) renderEffortOptions(effortSelect, app);
}

export function setMobileCollapsed(section, collapsed) {
  state.mobileCollapsed[section] = Boolean(collapsed);
  applyMobileCollapseState();
}

function updateCollapseButton(id, collapsed, label) {
  const button = byId(id);
  if (!button) return;

  button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  button.title = `${collapsed ? 'Expand' : 'Collapse'} ${label}`;

  if (id === 'limitsCollapseBtn') {
    button.textContent = collapsed ? '⌄' : '⌃';
    return;
  }

  button.textContent = collapsed ? '⌄' : '⌃';
}

export function applyMobileCollapseState() {
  document.body.classList.toggle('mobile-header-collapsed', state.mobileCollapsed.header);
  document.body.classList.toggle('mobile-limits-collapsed', state.mobileCollapsed.limits);
  document.body.classList.toggle('mobile-queue-collapsed', state.mobileCollapsed.queue);
  document.body.classList.toggle('mobile-output-collapsed', state.mobileCollapsed.output);

  updateCollapseButton('headerCollapseBtn', state.mobileCollapsed.header, 'header');
  updateCollapseButton('limitsCollapseBtn', state.mobileCollapsed.limits, 'limits');
  updateCollapseButton('queueCollapseBtn', state.mobileCollapsed.queue, 'queue');
  updateCollapseButton('outputCollapseBtn', state.mobileCollapsed.output, 'output');
}
