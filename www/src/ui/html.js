import { esc } from '#utils/format';

export function metaItem(label, value, title){
  value = value == null || value === '' ? '—' : String(value);
  title = title == null || title === '' ? value : String(title);
  return '<div class="meta-item" aria-label="' + esc(label + ': ' + title) + '"><span>' + esc(label) + '</span><b>' + esc(value) + '</b></div>';
}

export function sessionMetaItem(app, value, title){
  value = value == null || value === '' ? '—' : String(value);
  title = title == null || title === '' ? value : String(title);
  var action = app.canChangeSession ? '<button id="changeSessionBtn" class="meta-action" title="Change session">Change</button>' : '';
  return '<div class="meta-item session-meta-item" aria-label="' + esc('Session: ' + title) + '"><span>Session</span><div class="meta-value-row"><b>' + esc(value) + '</b>' + action + '</div></div>';
}

export function envChip(label, value, ok){
  value = value == null || value === '' ? '—' : String(value);
  return '<span class="env-chip ' + (ok ? 'ok' : '') + '" aria-label="' + esc(label + ': ' + value) + '" title="' + esc(label + ': ' + value) + '"><i></i>' + esc(label) + ': <b>' + esc(value) + '</b></span>';
}

export function queueTab(filter, label, value, active){
  return '<button type="button" class="queue-tab ' + (active ? 'active' : '') + '" data-queue-filter="' + esc(filter) + '">' + esc(label) + ' <b>' + Number(value || 0) + '</b></button>';
}
