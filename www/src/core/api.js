import { state } from '#core/state';

let stateUpdater = null;

export function setStateUpdater(fn) {
  stateUpdater = fn;
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

export async function api(path, body = {}) {
  const response = await fetch(withToken(path), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-codex-limit-watch-token': state.token,
    },
    body: JSON.stringify(body),
  });

  return parseJsonResponse(response);
}

export async function getState() {
  const response = await fetch(withToken('/api/state'), {
    headers: { 'x-codex-limit-watch-token': state.token },
  });
  const snapshot = await parseJsonResponse(response);
  return stateUpdater ? stateUpdater(snapshot) : snapshot;
}
