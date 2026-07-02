const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

export function fmtTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function fmtClock(timestampSeconds) {
  if (!timestampSeconds) return '—';
  try {
    return new Date(timestampSeconds * 1000).toLocaleTimeString();
  } catch {
    return '—';
  }
}

export function fmtRelative(timestampSeconds) {
  if (!timestampSeconds) return 'unknown';
  const minutes = Math.max(0, Math.ceil((timestampSeconds * 1000 - Date.now()) / 60_000));
  return fmtCountdownMinutes(minutes);
}

export function fmtCountdownMinutes(minutes) {
  const safeMinutes = Math.max(0, Math.ceil(Number(minutes) || 0));
  if (safeMinutes <= 120) return `${safeMinutes}m`;

  const hours = Math.ceil(safeMinutes / 60);
  if (hours <= 48) return `${hours}h`;

  return `${Math.ceil(hours / 24)}d`;
}

function isSameLocalDay(left, right) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

export function fmtRunAt(iso) {
  if (!iso) return '—';

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (isSameLocalDay(date, new Date())) return time;

  return `${date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })}, ${time}`;
}

export function fmtRunMeta(iso) {
  if (!iso) return '—';

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  return `${fmtRunAt(iso)} · in ${fmtCountdownMinutes((date.getTime() - Date.now()) / 60_000)}`;
}

function fallbackScheduleDate(iso) {
  const date = iso ? new Date(iso) : new Date(Date.now() + 15 * 60_000);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

export function localDateValue(iso) {
  const date = fallbackScheduleDate(iso);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function localTimeValue(iso) {
  const date = fallbackScheduleDate(iso);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

export function fmtCountdown(iso) {
  if (!iso) return '15:00';

  const ms = Math.max(0, new Date(iso).getTime() - Date.now());
  const seconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

export function windowLabel(windowInfo) {
  const minutes = Number(windowInfo?.windowDurationMins) || 0;

  if (minutes === 300) return '5h';
  if (minutes === 10_080) return 'weekly';
  if (minutes && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes && minutes % 60 === 0) return `${minutes / 60}h`;

  return windowInfo?.name || 'window';
}

export function pct(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}
