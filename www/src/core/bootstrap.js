import { initDomRefs, state } from '#core/state';
import { getState, setStateUpdater } from '#core/api';
import { attachEventHandlers } from '#core/events';
import { renderHeader } from '#ui/header';
import { renderApproval } from '#ui/approval';
import { updateCounter } from '#features/composer';
import { renderOutput } from '#features/output';
import { sectionKey, update } from '#core/renderer';

export function startApp(){
  initDomRefs();
  setStateUpdater(update);
  attachEventHandlers();
  updateCounter();

  setInterval(function(){ if(state.snap) renderHeader(); }, 30000);
  setInterval(function(){ if(state.snap && state.snap.approval) renderApproval(); }, 1000);

  var es = new EventSource('/events?token=' + encodeURIComponent(state.token));
  es.addEventListener('state', function(ev){ update(JSON.parse(ev.data)); });
  es.addEventListener('output', function(ev){
    if(!state.snap) return;
    state.snap.output = JSON.parse(ev.data);
    state.renderKeys.output = sectionKey('output', state.snap);
    renderOutput();
  });
  es.addEventListener('done', function(){ es.close(); });
  es.onerror = function(){ setTimeout(getState, 1000); };
  getState();
}
