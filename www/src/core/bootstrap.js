import { initDomRefs, state } from '#core/state';
import {
  getState,
  markNetworkOffline,
  markNetworkOnline,
  markNetworkReconnecting,
  setNetworkStatusRenderer,
  setStateUpdater,
} from '#core/api';
import { attachEventHandlers } from '#core/events';
import { sectionKey, update } from '#core/renderer';
import { updateCounter } from '#features/composer';
import { renderOutput } from '#features/output';
import { renderApproval } from '#ui/approval';
import { renderHeader } from '#ui/header';

const HEADER_REFRESH_MS = 30_000;
const APPROVAL_COUNTDOWN_REFRESH_MS = 1_000;
const STATE_RETRY_MS = 1_000;

function refreshStateSilently() {
  getState().catch(() => {
    // Network errors are reflected in the Network badge by the API layer.
  });
}

function attachEventStream() {
  let stream;

  try {
    stream = new EventSource(`/events?token=${encodeURIComponent(state.token)}`);
  } catch (error) {
    markNetworkOffline(error);
    return null;
  }

  stream.addEventListener('open', () => {
    markNetworkOnline();
  });

  stream.addEventListener('state', (event) => {
    markNetworkOnline();
    update(JSON.parse(event.data));
  });

  stream.addEventListener('output', (event) => {
    markNetworkOnline();
    if (!state.snap) return;
    state.snap.output = JSON.parse(event.data);
    state.renderKeys.output = sectionKey('output', state.snap);
    renderOutput();
  });

  stream.addEventListener('done', () => {
    showShutdownOverlay();
    stream.close();
  });
  stream.onerror = () => {
    markNetworkReconnecting();
    setTimeout(refreshStateSilently, STATE_RETRY_MS);
  };

  return stream;
}

function showShutdownOverlay() {
  const overlay = document.getElementById('shutdownOverlay');
  if (overlay) overlay.classList.remove('hidden');
  markNetworkOffline(new Error('codex web exited'));
}

function refreshLiveLabels() {
  setInterval(() => {
    if (state.snap) renderHeader();
  }, HEADER_REFRESH_MS);

  setInterval(() => {
    if (state.snap?.approval) renderApproval();
  }, APPROVAL_COUNTDOWN_REFRESH_MS);
}

export function startApp() {
  initDomRefs();
  setStateUpdater(update);
  setNetworkStatusRenderer(renderHeader);
  attachEventHandlers();
  updateCounter();
  refreshLiveLabels();
  attachEventStream();
  refreshStateSilently();
}
