import { initDomRefs, state } from '#core/state';
import { getState, setStateUpdater } from '#core/api';
import { attachEventHandlers } from '#core/events';
import { sectionKey, update } from '#core/renderer';
import { updateCounter } from '#features/composer';
import { renderOutput } from '#features/output';
import { renderApproval } from '#ui/approval';
import { renderHeader } from '#ui/header';

const HEADER_REFRESH_MS = 30_000;
const APPROVAL_COUNTDOWN_REFRESH_MS = 1_000;
const STATE_RETRY_MS = 1_000;

function attachEventStream() {
  const stream = new EventSource(`/events?token=${encodeURIComponent(state.token)}`);

  stream.addEventListener('state', (event) => {
    update(JSON.parse(event.data));
  });

  stream.addEventListener('output', (event) => {
    if (!state.snap) return;
    state.snap.output = JSON.parse(event.data);
    state.renderKeys.output = sectionKey('output', state.snap);
    renderOutput();
  });

  stream.addEventListener('done', () => stream.close());
  stream.onerror = () => setTimeout(getState, STATE_RETRY_MS);

  return stream;
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
  attachEventHandlers();
  updateCounter();
  refreshLiveLabels();
  attachEventStream();
  getState();
}
