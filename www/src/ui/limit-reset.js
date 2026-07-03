import { api, getState, isNetworkError } from '#core/api';
import { state } from '#core/state';
import { esc, fmtRelative } from '#utils/format';
import { byId, setHidden } from '#utils/dom';

function resetState(patch = {}) {
  state.limitReset = {
    open: false,
    loading: false,
    error: '',
    request: null,
    ...patch,
  };
}

function clearLimitResetTimer() {
  if (state.limitResetTimer) clearInterval(state.limitResetTimer);
  state.limitResetTimer = null;
}

function ensureLimitResetTimer() {
  if (state.limitResetTimer) return;
  state.limitResetTimer = setInterval(() => {
    if (!state.limitReset.open) {
      clearLimitResetTimer();
      return;
    }
    renderLimitResetModal();
  }, 250);
}

function requestTimes(request) {
  const now = Date.now();
  const availableAtMs = Date.parse(request?.availableAt || '');
  const expiresAtMs = Date.parse(request?.expiresAt || '');
  return {
    now,
    availableAtMs,
    expiresAtMs,
    readyInSeconds: Math.max(0, Math.ceil((availableAtMs - now) / 1000)),
    expiresInSeconds: Math.max(0, Math.ceil((expiresAtMs - now) / 1000)),
    ready: Number.isFinite(availableAtMs) && now >= availableAtMs,
    expired: Number.isFinite(expiresAtMs) && now > expiresAtMs,
  };
}

function creditExpiryText(request) {
  const expiresAt = Number(request?.creditExpiresAt || 0);
  if (!expiresAt) return 'Expiration unknown';
  return `${new Date(expiresAt * 1000).toLocaleString()} (${fmtRelative(expiresAt)})`;
}

function renderActions(current) {
  const request = current.request;
  const times = requestTimes(request);
  if (!request || times.expired) {
    return `
      <button id="limitResetCancelBtn">Cancel</button>
      <button id="limitResetRequestBtn" class="primary" ${current.loading ? 'disabled' : ''}>Request reset</button>
    `;
  }

  const label = times.ready ? 'Reset' : `Reset (${times.readyInSeconds}s)`;
  return `
    <button id="limitResetCancelBtn">Cancel</button>
    <button id="limitResetConfirmBtn" class="danger" ${current.loading || !times.ready ? 'disabled' : ''}>${esc(label)}</button>
  `;
}

function renderBody(current) {
  if (current.loading && !current.request) {
    return '<p>Requesting reset authorization…</p>';
  }

  const request = current.request;
  const times = requestTimes(request);
  const availableCount = Number(request?.availableCount || 0);
  const status = request
    ? (times.expired
      ? 'The reset request expired. Request reset again to continue.'
      : times.ready
        ? `Reset is ready. This authorization expires in ${times.expiresInSeconds}s.`
        : `Reset unlocks in ${times.readyInSeconds}s.`)
    : 'Request reset authorization before consuming a reset.';

  return `
    <p>Reset your current 5-hour and weekly usage limits. Are you sure?</p>
    <div class="limit-reset-details">
      <div><span>Available resets</span><b>${availableCount || '—'}</b></div>
      <div><span>Reset credit expires</span><b>${esc(creditExpiryText(request))}</b></div>
      <div><span>Request status</span><b>${esc(status)}</b></div>
    </div>
    ${current.error ? `<p class="limit-reset-error">${esc(current.error)}</p>` : ''}
  `;
}

async function requestLimitResetAuthorization() {
  const serial = ++state.limitResetSerial;
  resetState({ ...state.limitReset, open: true, loading: true, error: '' });
  renderLimitResetModal();
  try {
    const response = await api('/api/limits/reset-request');
    if (!state.limitReset.open || serial !== state.limitResetSerial) return;
    resetState({
      open: true,
      loading: false,
      error: '',
      request: response.resetRequest || null,
    });
    ensureLimitResetTimer();
  } catch (error) {
    if (!state.limitReset.open || serial !== state.limitResetSerial) return;
    resetState({
      open: true,
      loading: false,
      error: error.message,
      request: null,
    });
  }
  renderLimitResetModal();
}

export function openLimitResetModal() {
  resetState({ open: true, loading: true, error: '', request: state.snap?.limitResetRequest || null });
  renderLimitResetModal();
  requestLimitResetAuthorization();
}

export function closeLimitResetModal() {
  clearLimitResetTimer();
  state.limitResetSerial += 1;
  resetState();
  renderLimitResetModal();
}

export function requestLimitResetAgain() {
  requestLimitResetAuthorization();
}

export async function confirmLimitReset() {
  const request = state.limitReset.request;
  const times = requestTimes(request);
  if (!request || times.expired) {
    requestLimitResetAuthorization();
    return;
  }
  if (!times.ready || state.limitReset.loading) return;

  resetState({ ...state.limitReset, loading: true, error: '' });
  renderLimitResetModal();
  try {
    await api('/api/limits/reset', { requestId: request.requestId });
    closeLimitResetModal();
    getState().catch(() => {});
  } catch (error) {
    resetState({
      ...state.limitReset,
      loading: false,
      error: error.message,
      request: /expired/i.test(error.message) ? null : request,
    });
    renderLimitResetModal();
    if (isNetworkError(error)) closeLimitResetModal();
  }
}

export function renderLimitResetModal() {
  const box = byId('limitResetBox');
  if (!box) return;

  const current = state.limitReset;
  if (!current.open) {
    setHidden(box, true);
    box.innerHTML = '';
    return;
  }

  setHidden(box, false);
  box.innerHTML = `
    <div class="confirm-modal limit-reset-modal" role="dialog" aria-modal="true" aria-labelledby="limitResetTitle">
      <div class="confirm-head"><b id="limitResetTitle">Use limit reset</b></div>
      ${renderBody(current)}
      <div class="actions">${renderActions(current)}</div>
    </div>
  `;
}
