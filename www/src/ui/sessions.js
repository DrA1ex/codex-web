import { state } from '#core/state';
import { esc, fmtTime } from '#utils/format';
import { byId, setHidden } from '#utils/dom';

function renderSessionError(app) {
  return `
    <div class="session-modal session-error-modal" role="dialog" aria-modal="true" aria-labelledby="sessionErrorTitle">
      <div class="panel-head"><h2 id="sessionErrorTitle">Session unavailable</h2></div>
      <div class="session-list-body">
        <div class="empty">${esc(app.sessionError.message || 'This session is currently used by another codex-web instance.')}</div>
        <div class="actions"><button id="reloadSessionsBtn" class="primary">Change / refresh</button></div>
      </div>
    </div>
  `;
}

function renderSessionRow(session) {
  return `
    <div class="session panel-item">
      <div class="session-main">
        <div class="session-title">
          ${esc(session.title || session.id)} <span class="badge">${esc(session.cwdMatch || 'other')}</span>
        </div>
        <div class="session-meta">ID: ${esc(session.id)}</div>
        <div class="session-meta">CWD: ${esc(session.cwd || '—')}</div>
        <div class="session-meta">Updated: ${esc(fmtTime(session.updatedAt))}</div>
        <div class="session-preview">${esc(session.preview || '')}</div>
      </div>
      <div class="session-actions">
        <button data-session="${esc(session.id)}" class="primary">Select</button>
      </div>
    </div>
  `;
}

function renderSessionPicker(app, sessions) {
  const canCancel = Boolean(app.sessionId);
  const cancelButton = canCancel ? '<button id="cancelSessionChangeBtn">Cancel</button>' : '';
  const body = sessions.length
    ? sessions.map(renderSessionRow).join('')
    : '<div class="empty">No active sessions found for this project. Create a new session to start queueing prompts, or reload after starting Codex elsewhere.</div>';

  return `
    <div class="session-modal" role="dialog" aria-modal="true" aria-labelledby="sessionModalTitle">
      <div class="panel-head">
        <h2 id="sessionModalTitle">Select Codex session</h2>
        <div class="panel-actions">
          <button id="createSessionBtn" class="primary">Create new session</button>
          <button id="reloadSessionsBtn">Reload</button>
          ${cancelButton}
        </div>
      </div>
      <div class="session-list-body">${body}</div>
    </div>
  `;
}

export function renderSessions() {
  const picker = byId('sessionPicker');
  const app = state.snap?.app || {};
  if (!picker) return;

  if (app.state !== 'selecting-session') {
    setHidden(picker, true);
    return;
  }

  setHidden(picker, false);
  picker.innerHTML = app.sessionError
    ? renderSessionError(app)
    : renderSessionPicker(app, state.snap?.sessions || []);
}
