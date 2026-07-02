import { state } from '#core/state';

var stateUpdater = null;

export function setStateUpdater(fn){
  stateUpdater = fn;
}

export function api(path, body){
  return fetch(path + '?token=' + encodeURIComponent(state.token), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-codex-limit-watch-token': state.token
    },
    body: JSON.stringify(body || {})
  }).then(function(r){
    return r.json().then(function(j){
      if(!r.ok) throw new Error(j.error || r.statusText);
      return j;
    });
  });
}

export function getState(){
  return fetch('/api/state?token=' + encodeURIComponent(state.token), {
    headers: { 'x-codex-limit-watch-token': state.token }
  }).then(function(r){ return r.json(); }).then(function(s){
    return stateUpdater ? stateUpdater(s) : s;
  });
}
