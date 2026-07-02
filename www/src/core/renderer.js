import { state } from '#core/state';
import { renderApproval } from '#ui/approval';
import { renderConfirm } from '#ui/confirm';
import { renderHeader } from '#ui/header';
import { renderScheduleModal } from '#ui/schedule';
import { renderSessions } from '#ui/sessions';
import { renderQueue } from '#features/queue';
import { renderOutput } from '#features/output';

function stableKey(value){
  try { return JSON.stringify(value == null ? null : value); } catch(e) { return String(Date.now()); }
}

export function sectionKey(name, s){
  var app = (s && s.app) || {};
  if(name === 'header') return stableKey({ app:app, rateLimits:s && s.rateLimits });
  if(name === 'sessions') return stableKey({ state:app.state, sessionId:app.sessionId, sessionError:app.sessionError, sessions:s && s.sessions });
  if(name === 'approval') return stableKey(s && s.approval);
  if(name === 'queue') return stableKey({
    queue:s && s.queue,
    counts:app.queueCounts,
    nextPendingId:app.nextPendingId,
    canInterrupt:app.canInterrupt,
    sendLocked: app.state === 'countdown' || app.isManualSend
  });
  if(name === 'output') return stableKey(s && s.output);
  if(name === 'debug') return stableKey(s && s.debug);
  return '';
}

function renderSection(name, fn, force){
  var key = sectionKey(name, state.snap);
  if(force || state.renderKeys[name] !== key) {
    state.renderKeys[name] = key;
    fn();
  }
}

export function update(s){
  var first = !state.snap;
  state.snap = s;
  render(first);
}

export function render(){
  if(!state.snap) return;
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
    if(debug) debug.textContent = JSON.stringify(state.snap.debug || {}, null, 2);
  }, force);
}
