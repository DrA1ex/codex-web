import { state } from '#core/state';

const RUNNING_STATUSES = new Set(['sending', 'sent']);
const DONE_STATUSES = new Set(['completed']);

export function isRunningStatus(status) {
  return RUNNING_STATUSES.has(status);
}

export function isDoneStatus(status) {
  return DONE_STATUSES.has(status);
}

export function isPendingQueueItem(item) {
  return item?.status === 'pending';
}

export function queueMatchesFilter(item) {
  const status = item?.status;

  if (state.activeQueueFilter === 'pending') return status === 'pending';
  if (state.activeQueueFilter === 'running') return isRunningStatus(status);
  if (state.activeQueueFilter === 'completed') return isDoneStatus(status);

  return true;
}
