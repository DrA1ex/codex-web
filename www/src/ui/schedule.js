import { state } from '#core/state';
import { esc, fmtRunMeta, localDateValue, localTimeValue } from '#utils/format';
import { byId, setHidden } from '#utils/dom';

function readScheduleInputs() {
  const dateInput = byId('scheduleDateInput');
  const timeInput = byId('scheduleTimeInput');

  return {
    date: dateInput?.value || localDateValue(null),
    time: timeInput?.value || '',
  };
}

export function scheduleInputIso() {
  const { date, time } = readScheduleInputs();
  if (!time) return null;

  const selectedDate = new Date(`${date}T${time}:00`);
  return Number.isNaN(selectedDate.getTime()) ? null : selectedDate.toISOString();
}

export function updateScheduleDraft() {
  state.scheduleDraft = {
    ...(state.scheduleDraft || {}),
    ...readScheduleInputs(),
  };
}

export function openScheduleModal() {
  const app = state.snap?.app || {};
  state.scheduleDraft = {
    date: localDateValue(app.scheduledRunAt || null),
    time: localTimeValue(app.scheduledRunAt || null),
  };
  state.scheduleOpen = true;
  renderScheduleModal();
}

export function closeScheduleModal() {
  state.scheduleOpen = false;
  state.scheduleDraft = null;
  renderScheduleModal();
}

export function renderScheduleModal() {
  const box = byId('scheduleBox');
  if (!box) return;

  if (!state.scheduleOpen) {
    setHidden(box, true);
    box.innerHTML = '';
    return;
  }

  const app = state.snap?.app || {};
  const scheduled = app.scheduledRunAt || '';
  const draft = state.scheduleDraft || {
    date: localDateValue(scheduled),
    time: localTimeValue(scheduled),
  };

  setHidden(box, false);
  box.innerHTML = `
    <div class="confirm-modal schedule-modal" role="dialog" aria-modal="true" aria-labelledby="scheduleTitle">
      <div class="modal-head">
        <b id="scheduleTitle">Schedule queue</b>
        <button id="scheduleCloseBtn" class="icon-only" title="Close"><span class="icon icon-close" aria-hidden="true"></span></button>
      </div>
      <div class="schedule-fields">
        <label><span>Date</span><input id="scheduleDateInput" type="date" value="${esc(draft.date)}"></label>
        <label><span>Time</span><input id="scheduleTimeInput" type="time" value="${esc(draft.time)}"></label>
      </div>
      ${scheduled ? `<div class="schedule-current">Current: ${esc(fmtRunMeta(scheduled))}</div>` : ''}
      <div class="actions schedule-actions">
        <button id="scheduleSaveBtn" class="primary">Save</button>
        <button id="scheduleCancelQueueBtn" class="danger">Cancel queue</button>
      </div>
    </div>
  `;
}
