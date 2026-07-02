import { state } from '#core/state';
import { api, getState } from '#core/api';
import { setButtonState } from '#ui/header';
import { requestQueueScroll } from '#features/queue';

export function updateCounter(){
  var composer = state.composer;
  if(!composer) return;
  var text = composer.value;
  var lines = text ? text.split(/\r?\n/).length : 0;
  var counter = document.getElementById('counter');
  if(counter) counter.textContent = 'Lines: ' + lines + ' · Chars: ' + text.length;
  setButtonState('addBtn', !text.trim(), false);
}

export function addQueue(){
  var composer = state.composer;
  api('/api/queue/add', { text: composer ? composer.value : '' }).then(function(r){
    if(r.item && r.item.id) requestQueueScroll(r.item.id, '', true);
    if(composer) {
      if(r.clearComposer) composer.value = '';
      if(r.composerText !== undefined) composer.value = r.composerText;
    }
    if(r.message) alert(r.message);
    updateCounter();
    getState();
  }).catch(function(e){ alert(e.message); });
}

export function sendComposerNow(){
  var composer = state.composer;
  api('/api/queue/send-composer', { text: composer ? composer.value : '' }).then(function(r){
    if(composer) {
      if(r.clearComposer) composer.value = '';
      if(r.composerText !== undefined) composer.value = r.composerText;
    }
    if(r.message) alert(r.message);
    updateCounter();
    getState();
  }).catch(function(e){ alert(e.message); });
}
