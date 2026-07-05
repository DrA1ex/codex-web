import { api, getState, isNetworkError, writeOutputError } from '#core/api';
import { state } from '#core/state';
import { updateCounter } from '#features/composer';
import { setQueueEditDraft } from '#features/queue';
import { updateScheduleDraft } from '#ui/schedule';

function isScheduleInput(target) {
  return target?.id === 'scheduleDateInput' || target?.id === 'scheduleTimeInput';
}

function reportError(error) {
  if (!isNetworkError(error)) writeOutputError(error);
  getState().catch(() => {});
}

export function attachFormHandlers() {
  document.addEventListener('input', (event) => {
    const target = event.target;

    if (target?.dataset?.editText) setQueueEditDraft(target.dataset.editText, target.value);
    if (isScheduleInput(target)) updateScheduleDraft();
  });

  document.addEventListener('change', (event) => {
    const target = event.target;

    if (target?.id === 'modelSelect') {
      api('/api/config/model', { model: target.value }).catch(reportError);
    } else if (target?.id === 'effortSelect') {
      api('/api/config/effort', { effort: target.value }).catch(reportError);
    } else if (isScheduleInput(target)) {
      updateScheduleDraft();
    }
  });

  if (state.composer) {
    state.composer.addEventListener('input', updateCounter);
  }
}
