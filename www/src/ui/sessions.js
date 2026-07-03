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
  const counts = session.queueCounts || {};
  const preview = String(session.preview || '').trim();
  const title = String(session.title || preview || 'Untitled session').trim();
  const showPreview = preview && preview !== title;
  const id = String(session.id || '').trim();
  const canSelect = Boolean(id);
  const selectAttrs = canSelect ? `data-session="${esc(id)}"` : 'disabled title="Session id unavailable"';
  const updated = fmtTime(session.updatedAt);
  const meta = [
    id ? `ID: ${esc(id)}` : '',
    session.cwd ? `CWD: ${esc(session.cwd)}` : '',
    updated ? `Updated: ${esc(updated)}` : '',
  ].filter(Boolean);
  return `
    <div class="session panel-item">
      <div class="session-main">
        <div class="session-title-row">
          <div class="session-title" title="${esc(title)}">${esc(title)}</div>
          <div class="session-queue-badges" aria-label="Saved queue records">
            <span class="badge warn session-queue-badge"><b>${Number(counts.pending || 0)}</b><span>pending</span></span>
            <span class="badge ok session-queue-badge"><b>${Number(counts.completed || 0)}</b><span>complete</span></span>
          </div>
        </div>
        ${meta.length ? `<div class="session-meta-row">${meta.map((item) => `<span class="session-meta">${item}</span>`).join('')}</div>` : ''}
        ${showPreview ? `<div class="session-preview">${esc(preview)}</div>` : ''}
      </div>
      <div class="session-actions">
        <button ${selectAttrs} class="primary">Select</button>
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
