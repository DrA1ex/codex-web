import { state } from '#core/state';

const RUNNING_STATUSES = new Set(['sending', 'sent']);
const PENDING_STATUSES = new Set(['pending', 'next']);
const DONE_STATUSES = new Set(['completed']);

export function isRunningStatus(status) {
  return RUNNING_STATUSES.has(status);
}

export function isDoneStatus(status) {
  return DONE_STATUSES.has(status);
}

export function isPendingQueueItem(item) {
  return PENDING_STATUSES.has(item?.status);
}

export function queueMatchesFilter(item) {
  const status = item?.status;

  if (state.activeQueueFilter === 'pending' || state.activeQueueFilter === 'running') {
    return PENDING_STATUSES.has(status) || isRunningStatus(status);
  }

  if (state.activeQueueFilter === 'completed') return isDoneStatus(status);

  return true;
}
