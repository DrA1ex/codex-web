import { esc } from '#utils/format';

export function metaItem(label, value, title = value) {
  const displayValue = value == null || value === '' ? '—' : String(value);
  const displayTitle = title == null || title === '' ? displayValue : String(title);

  return `
    <div class="meta-item" aria-label="${esc(`${label}: ${displayTitle}`)}">
      <span>${esc(label)}</span>
      <b>${esc(displayValue)}</b>
    </div>
  `;
}

export function sessionMetaItem(app, value, title = value) {
  const displayValue = value == null || value === '' ? '—' : String(value);
  const displayTitle = title == null || title === '' ? displayValue : String(title);
  const changeButton = app.canChangeSession
    ? '<button id="changeSessionBtn" class="meta-action" title="Change session">Change</button>'
    : '';

  return `
    <div class="meta-item session-meta-item" aria-label="${esc(`Session: ${displayTitle}`)}">
      <span>Session</span>
      <div class="meta-value-row">
        <b>${esc(displayValue)}</b>
        ${changeButton}
      </div>
    </div>
  `;
}

export function envChip(label, value, ok, title, className = ok ? 'ok' : '') {
  const displayValue = value == null || value === '' ? '—' : String(value);
  const displayTitle = title == null || title === '' ? displayValue : String(title);
  const aria = esc(`${label}: ${displayTitle}`);

  return `
    <span class="env-chip ${esc(className)}" aria-label="${aria}" title="${aria}">
      <i></i>${esc(label)}: <b>${esc(displayValue)}</b>
    </span>
  `;
}

export function queueTab(filter, label, value, active) {
  return `
    <button type="button" class="queue-tab ${active ? 'active' : ''}" data-queue-filter="${esc(filter)}">
      ${esc(label)} <b>${Number(value || 0)}</b>
    </button>
  `;
}
