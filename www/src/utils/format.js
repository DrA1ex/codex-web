export function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}

export function fmtTime(iso){
  if(!iso) return '';
  try { return new Date(iso).toLocaleString(); } catch(e){ return iso; }
}

export function fmtClock(ts){
  if(!ts) return '—';
  try { return new Date(ts * 1000).toLocaleTimeString(); } catch(e){ return '—'; }
}

export function fmtRelative(ts){
  if(!ts) return 'unknown';
  var mins = Math.max(0, Math.ceil(((ts * 1000) - Date.now()) / 60000));
  return fmtCountdownMinutes(mins);
}

export function fmtCountdownMinutes(mins){
  mins = Math.max(0, Math.ceil(Number(mins) || 0));
  if(mins <= 120) return mins + 'm';
  var hours = Math.ceil(mins / 60);
  if(hours <= 48) return hours + 'h';
  return Math.ceil(hours / 24) + 'd';
}

function isSameLocalDay(a, b){
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function fmtRunAt(iso){
  if(!iso) return '—';
  var d = new Date(iso);
  if(Number.isNaN(d.getTime())) return '—';
  var time = d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
  if(isSameLocalDay(d, new Date())) return time;
  return d.toLocaleDateString([], { year:'numeric', month:'short', day:'numeric' }) + ', ' + time;
}

export function fmtRunMeta(iso){
  if(!iso) return '—';
  var d = new Date(iso);
  if(Number.isNaN(d.getTime())) return '—';
  return fmtRunAt(iso) + ' · in ' + fmtCountdownMinutes(((d.getTime() - Date.now()) / 60000));
}

export function localDateValue(iso){
  var d = iso ? new Date(iso) : new Date(Date.now() + 15 * 60000);
  if(Number.isNaN(d.getTime())) d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export function localTimeValue(iso){
  var d = iso ? new Date(iso) : new Date(Date.now() + 15 * 60000);
  if(Number.isNaN(d.getTime())) d = new Date(Date.now() + 15 * 60000);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

export function fmtCountdown(iso){
  if(!iso) return '15:00';
  var ms = Math.max(0, new Date(iso).getTime() - Date.now());
  var total = Math.ceil(ms / 1000);
  var mins = Math.floor(total / 60);
  var secs = total % 60;
  return mins + ':' + String(secs).padStart(2, '0');
}

export function windowLabel(w){
  var mins = Number(w && w.windowDurationMins) || 0;
  if(mins === 300) return '5h';
  if(mins === 10080) return 'weekly';
  if(mins && mins % 1440 === 0) return (mins / 1440) + 'd';
  if(mins && mins % 60 === 0) return (mins / 60) + 'h';
  return (w && w.name) || 'window';
}

export function pct(n){
  n = Number(n);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
}
