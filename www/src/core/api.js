import { state } from '#core/state';

let stateUpdater = null;
let networkStatusRenderer = null;

const NETWORK_ERROR_HINTS = [
  'failed to fetch',
  'fetch failed',
  'networkerror',
  'load failed',
  'connection',
];

export function setStateUpdater(fn) {
  stateUpdater = fn;
}

export function setNetworkStatusRenderer(fn) {
  networkStatusRenderer = fn;
}

function renderNetworkStatus() {
  if (typeof networkStatusRenderer === 'function') networkStatusRenderer();
}

function setClientNetworkStatus(status, message) {
  const nextMessage = message || '';
  if (state.clientNetwork.status === status && state.clientNetwork.message === nextMessage) return;

  state.clientNetwork = {
    status,
    message: nextMessage,
    updatedAt: Date.now(),
  };

  renderNetworkStatus();
}

function networkErrorMessage(error) {
  const rawMessage = String(error?.message || 'Fetch failed');
  const normalized = rawMessage.toLowerCase();

  if (NETWORK_ERROR_HINTS.some((hint) => normalized.includes(hint))) {
    return 'server unavailable';
  }

  return rawMessage;
}

function networkError(error) {
  const wrapped = new Error(networkErrorMessage(error));
  wrapped.isNetworkError = true;
  wrapped.cause = error;
  return wrapped;
}

export function isNetworkError(error) {
  return Boolean(error?.isNetworkError);
}

export function markNetworkOnline(message = 'connected') {
  setClientNetworkStatus('online', message);
}

export function markNetworkReconnecting(message = 'reconnecting') {
  if (state.clientNetwork.status === 'offline') return;
  setClientNetworkStatus('reconnecting', message);
}

export function markNetworkOffline(error) {
  const wrapped = isNetworkError(error) ? error : networkError(error);
  setClientNetworkStatus('offline', wrapped.message);
  return wrapped;
}

function withToken(path) {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}token=${encodeURIComponent(state.token)}`;
}

async function parseJsonResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || response.statusText || 'Request failed');
  }
  return payload;
}

async function fetchJson(path, options = {}) {
  let response;

  try {
    response = await fetch(withToken(path), options);
  } catch (error) {
    throw markNetworkOffline(error);
  }

  markNetworkOnline();
  return parseJsonResponse(response);
}

export async function api(path, body = {}) {
  return fetchJson(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-codex-limit-watch-token': state.token,
    },
    body: JSON.stringify(body),
  });
}

export async function getState() {
  const snapshot = await fetchJson('/api/state', {
    headers: { 'x-codex-limit-watch-token': state.token },
  });
  return stateUpdater ? stateUpdater(snapshot) : snapshot;
}


export async function getCommandMetadata() {
  return fetchJson('/api/commands', {
    headers: { 'x-codex-limit-watch-token': state.token },
  });
}
