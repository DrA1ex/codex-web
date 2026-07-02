'use strict';

const PROCESSING_STATES = new Set([
  'countdown',
  'sending',
  'streaming',
  'waiting-limits',
]);

const SESSION_CHANGE_RUNNING_STATES = new Set([
  'countdown',
  'sending',
  'streaming',
]);

const SESSION_CHANGE_BLOCKED_STATES = new Set([
  'initializing',
  'selecting-session',
  'approval-required',
  'shutting-down',
]);

const NON_PAUSABLE_STATES = new Set([
  'paused',
  'done',
  'error',
  'initializing',
  'selecting-session',
  'approval-required',
]);

const PENDING_QUEUE_STATUSES = new Set(['pending']);
const ACTIVE_QUEUE_STATUSES = new Set(['pending', 'sending', 'sent']);
const RUNNING_QUEUE_STATUSES = new Set(['sending', 'sent']);
const FINISHED_QUEUE_STATUSES = new Set(['completed', 'cancelled', 'failed', 'unknown']);
const FAILURE_QUEUE_STATUSES = new Set(['failed', 'unknown']);

function hasStatus(queue, statuses) {
  return queue.some((item) => statuses.has(item.status));
}

function allHaveStatus(queue, statuses) {
  return queue.length > 0 && queue.every((item) => statuses.has(item.status));
}

module.exports = {
  PROCESSING_STATES,
  SESSION_CHANGE_RUNNING_STATES,
  SESSION_CHANGE_BLOCKED_STATES,
  NON_PAUSABLE_STATES,
  PENDING_QUEUE_STATUSES,
  ACTIVE_QUEUE_STATUSES,
  RUNNING_QUEUE_STATUSES,
  FINISHED_QUEUE_STATUSES,
  FAILURE_QUEUE_STATUSES,
  hasStatus,
  allHaveStatus,
};
