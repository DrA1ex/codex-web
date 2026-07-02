import { state } from '#core/state';
import { esc, fmtClock, fmtRelative, fmtRunMeta, pct, windowLabel } from '#utils/format';
import { byId, setText } from '#utils/dom';
import { envChip, metaItem, queueTab, sessionMetaItem } from '#ui/html';

const WARNING_STATES = new Set(['paused', 'scheduled', 'waiting-limits', 'approval-required']);
const RUNNING_COUNT_KEYS = ['sending', 'sent'];
const PENDING_TAB_COUNT_KEYS = ['pending', ...RUNNING_COUNT_KEYS];
const TOTAL_COUNT_KEYS = ['pending', 'sending', 'sent', 'completed', 'failed', 'unknown'];

function isCompactHeader() {
  return Boolean(state.compactHeaderQuery?.matches);
}

function fullLimitBadgeText(status) {
  if (status === 'limited') return 'limits waiting';
  if (status === 'available') return 'limits available';
  return 'limits unknown';
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

function renderControlState(app, counts = {}) {
  const hasSession = Boolean(app.sessionId);
  const pending = counts.pending || 0;
  const completed = counts.completed || 0;

  setButtonState('undoBtn', false, pending === 0);
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
}

function renderStateBadges(app, rateLimits) {
  const stateClass = app.state === 'error' ? 'danger' : WARNING_STATES.has(app.state) ? 'warn' : 'ok';
  const limitsClass = rateLimits.status === 'available' ? 'ok' : rateLimits.status === 'limited' ? 'warn' : 'danger';

  setBadge(byId('stateBadge'), app.state || 'unknown', app.state || 'unknown', stateClass);
  setBadge(byId('limitBadge'), limitBadgeText(rateLimits.status), fullLimitBadgeText(rateLimits.status), limitsClass);
  setText(byId('mobileLimitsSummary'), limitBadgeText(rateLimits.status));
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

  env.innerHTML = [
    envChip('Sandbox', app.sandbox || '—', true),
    envChip('Approval', app.approvalPolicy || '—', true),
    envChip('Network', String(app.network), Boolean(app.network)),
  ].join('');
}

function renderProjectMeta(app, nextRun) {
  const meta = byId('meta');
  if (!meta) return;

  const sessionTitle = app.sessionTitle || 'not selected';
  const sessionId = app.sessionId || '—';

  meta.innerHTML = [
    metaItem('Project', app.projectDir),
    sessionMetaItem(app, sessionTitle, sessionTitle),
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

function renderLimitCard(bucket) {
  return `
    <div class="limit-card">
      <div class="limit-card-head"><span>Limits</span><b>${esc(bucket.limitName || bucket.limitId || 'limit')}</b></div>
      ${windowsForBucket(bucket).map(renderLimitWindow).join('')}
    </div>
  `;
}

export function renderLimitStats() {
  const element = byId('limitStats');
  if (!element) return;

  const buckets = state.snap?.rateLimits?.buckets || [];
  element.innerHTML = buckets.length
    ? buckets.map(renderLimitCard).join('')
    : '<div class="limit-card muted"><div class="limit-card-head">Limits</div><p>Rate-limit data unavailable.</p></div>';
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
    const icon = button.querySelector('i');
    if (icon) icon.textContent = collapsed ? '⌄' : '⌃';
    return;
  }

  button.textContent = collapsed ? '⌄' : '⌃';
}

export function applyMobileCollapseState() {
  document.body.classList.toggle('mobile-header-collapsed', state.mobileCollapsed.header);
  document.body.classList.toggle('mobile-limits-collapsed', state.mobileCollapsed.limits);
  document.body.classList.toggle('mobile-queue-collapsed', state.mobileCollapsed.queue);

  updateCollapseButton('headerCollapseBtn', state.mobileCollapsed.header, 'header');
  updateCollapseButton('limitsCollapseBtn', state.mobileCollapsed.limits, 'limits');
  updateCollapseButton('queueCollapseBtn', state.mobileCollapsed.queue, 'queue');
}
