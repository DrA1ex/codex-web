import { state } from '#core/state';
import { esc, fmtTime } from '#utils/format';

export function renderSessions(){
  var picker = document.getElementById('sessionPicker');
  var app = (state.snap && state.snap.app) || {};
  if(!picker) return;
  if(app.state !== 'selecting-session'){
    picker.classList.add('hidden');
    return;
  }
  picker.classList.remove('hidden');
  if(app.sessionError) {
    picker.innerHTML = '<div class="session-modal session-error-modal" role="dialog" aria-modal="true" aria-labelledby="sessionErrorTitle">' +
      '<div class="panel-head"><h2 id="sessionErrorTitle">Session unavailable</h2></div>' +
      '<div class="session-list-body"><div class="empty">' + esc(app.sessionError.message || 'This session is currently used by another codex-web instance.') + '</div>' +
      '<div class="actions"><button id="reloadSessionsBtn" class="primary">Change / refresh</button></div></div>' +
    '</div>';
    return;
  }
  var sessions = (state.snap && state.snap.sessions) || [];
  var canCancel = !!app.sessionId;
  var html = '<div class="session-modal" role="dialog" aria-modal="true" aria-labelledby="sessionModalTitle">' +
    '<div class="panel-head"><h2 id="sessionModalTitle">Select Codex session</h2><div class="panel-actions"><button id="createSessionBtn" class="primary">Create new session</button><button id="reloadSessionsBtn">Reload</button>' + (canCancel ? '<button id="cancelSessionChangeBtn">Cancel</button>' : '') + '</div></div>' +
    '<div class="session-list-body">';
  if(!sessions.length) html += '<div class="empty">No active sessions found for this project. Create a new session to start queueing prompts, or reload after starting Codex elsewhere.</div>';
  sessions.forEach(function(s){
    html += '<div class="session panel-item"><div class="session-main"><div class="session-title">' + esc(s.title || s.id) + ' <span class="badge">' + esc(s.cwdMatch || 'other') + '</span></div><div class="session-meta">ID: ' + esc(s.id) + '</div><div class="session-meta">CWD: ' + esc(s.cwd || '—') + '</div><div class="session-meta">Updated: ' + esc(fmtTime(s.updatedAt)) + '</div><div class="session-preview">' + esc(s.preview || '') + '</div></div><div class="session-actions"><button data-session="' + esc(s.id) + '" class="primary">Select</button></div></div>';
  });
  html += '</div></div>';
  picker.innerHTML = html;
}
