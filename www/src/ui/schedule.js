import { state } from '#core/state';
import { esc, fmtRunMeta, localDateValue, localTimeValue } from '#utils/format';

export function scheduleInputIso(){
  var dateEl = document.getElementById('scheduleDateInput');
  var timeEl = document.getElementById('scheduleTimeInput');
  var date = dateEl && dateEl.value ? dateEl.value : localDateValue(null);
  var time = timeEl && timeEl.value ? timeEl.value : '';
  if(!time) return null;
  var d = new Date(date + 'T' + time + ':00');
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function updateScheduleDraft(){
  state.scheduleDraft = state.scheduleDraft || {};
  state.scheduleDraft.date = document.getElementById('scheduleDateInput') ? document.getElementById('scheduleDateInput').value : localDateValue(null);
  state.scheduleDraft.time = document.getElementById('scheduleTimeInput') ? document.getElementById('scheduleTimeInput').value : '';
}

export function openScheduleModal(){
  var app = state.snap && state.snap.app || {};
  state.scheduleDraft = {
    date: localDateValue(app.scheduledRunAt || null),
    time: localTimeValue(app.scheduledRunAt || null)
  };
  state.scheduleOpen = true;
  renderScheduleModal();
}

export function closeScheduleModal(){
  state.scheduleOpen = false;
  state.scheduleDraft = null;
  renderScheduleModal();
}

export function renderScheduleModal(){
  var box = document.getElementById('scheduleBox');
  if(!box) return;
  if(!state.scheduleOpen) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  var app = state.snap && state.snap.app || {};
  var scheduled = app.scheduledRunAt || '';
  var draft = state.scheduleDraft;
  box.classList.remove('hidden');
  box.innerHTML = '<div class="confirm-modal schedule-modal" role="dialog" aria-modal="true" aria-labelledby="scheduleTitle">' +
    '<div class="modal-head"><b id="scheduleTitle">Schedule queue</b><button id="scheduleCloseBtn" class="icon-only" title="Close">×</button></div>' +
    '<div class="schedule-fields">' +
      '<label><span>Date</span><input id="scheduleDateInput" type="date" value="' + esc(draft ? draft.date : localDateValue(scheduled)) + '"></label>' +
      '<label><span>Time</span><input id="scheduleTimeInput" type="time" value="' + esc(draft ? draft.time : localTimeValue(scheduled)) + '"></label>' +
    '</div>' +
    (scheduled ? '<div class="schedule-current">Current: ' + esc(fmtRunMeta(scheduled)) + '</div>' : '') +
    '<div class="actions schedule-actions">' +
      '<button id="scheduleSaveBtn" class="primary">Save</button>' +
      '<button id="scheduleCancelQueueBtn" class="danger">Cancel queue</button>' +
    '</div>' +
  '</div>';
}
