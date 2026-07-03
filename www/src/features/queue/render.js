import { state } from '#core/state';
import { esc, fmtTime } from '#utils/format';
import { toArray } from '#utils/dom';
import { captureActiveEditor, queueContainer, queueDraftValue, restoreActiveEditor } from './editor.js';
import { animateQueueItems, clearQueueScrollRequest, queueItemRects, scrollQueueItemAfterMove } from './scroll.js';
import { isPendingQueueItem, isRunningStatus, queueMatchesFilter } from './status.js';

function queueItemClassName({ active, running, completed, draggable, expanded, editing }) {
  return [
    'queue-item',
    active && 'active',
    running && 'running',
    completed && 'completed',
    draggable && 'draggable',
    expanded && 'expanded',
    editing && 'editing',
  ].filter(Boolean).join(' ');
}

function promptToggleAttrs(item, expanded, editing) {
  if (editing) return '';

  return [
    'data-toggle-prompt="1"',
    `data-id="${esc(item.id)}"`,
    'role="button"',
    'tabindex="0"',
    `aria-expanded="${expanded ? 'true' : 'false'}"`,
    `title="Click to ${expanded ? 'collapse' : 'expand'} prompt"`,
  ].join(' ');
}

function compactNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 0 : 1)}m`;
  if (number >= 1_000) return `${(number / 1_000).toFixed(number >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(number));
}

function icon(name) {
  return `<span class="icon icon-${name}" aria-hidden="true"></span>`;
}

function renderUsageSummary(item) {
  const usage = item.usage || null;
  if (!usage || !['completed', 'failed', 'unknown', 'cancelled'].includes(item.status)) return '';

  const chips = [];
  const title = [];
  const tokens = usage.tokenUsage || null;
  if (tokens?.totalTokens != null) {
    chips.push(`${compactNumber(tokens.totalTokens)} t.`);
    title.push(`Tokens: ${tokens.totalTokens}`);
    title.push(`Input: ${tokens.inputTokens || 0}`);
    title.push(`Cached input: ${tokens.cachedInputTokens || 0}`);
    title.push(`Output: ${tokens.outputTokens || 0}`);
    title.push(`Reasoning output: ${tokens.reasoningOutputTokens || 0}`);
  }

  for (const delta of usage.limitDeltas || []) {
    if (delta?.usedPercent == null) continue;
    chips.push(`${delta.window || delta.limitName || 'limit'} -${delta.usedPercent}%`);
  }

  if (!chips.length) return '';
  if ((usage.limitDeltas || []).length) title.push('Limit deltas are account-level and may include parallel Codex work.');

  return `<span class="queue-usage" title="${esc(title.join('\n'))}">${chips.map((chip) => `<b>${esc(chip)}</b>`).join('')}</span>`;
}

function renderQueueHeader(item, index, draggable, completed, expanded, editing) {
  const finishedOrCreatedAt = completed && item.finishedAt ? item.finishedAt : item.createdAt;
  const dragHandle = draggable
    ? `<span class="queue-drag-handle" title="Drag to reorder">${icon('drag')}</span>`
    : '';
  const toggleAttrs = promptToggleAttrs(item, expanded, editing);

  return `
    <div class="queue-top" ${toggleAttrs}>
      <span>${dragHandle}#${index + 1} <span class="status ${esc(item.status)}">${esc(item.status)}</span> · ${item.lineCount || 0} lines</span>
      <span>${esc(fmtTime(finishedOrCreatedAt))}</span>
    </div>
  `;
}

function renderQueuePrompt(item, idAttr, expanded, editing) {
  if (editing) {
    return `<textarea class="queue-edit" data-edit-text="${idAttr}" spellcheck="false">${esc(queueDraftValue(item.id, item.text || ''))}</textarea>`;
  }

  const text = promptTextForState(item, expanded);

  const attrs = promptToggleAttrs(item, expanded, editing);

  return `<div class="prompt-preview" aria-label="${esc(item.text || item.preview || '')}" ${attrs}>${esc(text || '')}</div>`;
}

function renderEditActions(item, idAttr) {
  const saving = Boolean(state.savingQueueEdits[item.id]);
  const disabled = saving ? ' disabled' : '';

  return `
    <div class="actions queue-actions">
      <button data-act="saveEdit" data-id="${idAttr}" class="primary"${disabled}>${icon('save')}${saving ? 'Saving...' : 'Save'}</button>
      <button data-act="cancelEdit" data-id="${idAttr}"${disabled}>${icon('close')}Cancel</button>
    </div>
  `;
}

function renderQueueActions(item, idAttr, app) {
  const sendDisabled = app.state === 'countdown';
  const recoveryActions = item.status === 'unknown' || item.status === 'failed'
    ? `<button data-act="markCompleted" data-id="${idAttr}">${icon('check')}Done</button><button data-act="retry" data-id="${idAttr}">${icon('retry')}Retry</button>`
    : '';

  return `
    <div class="actions queue-actions">
      <button data-act="edit" data-id="${idAttr}">${icon('edit')}Edit</button>
      <button data-act="duplicate" data-id="${idAttr}">${icon('duplicate')}Duplicate</button>
      <button data-act="sendNow" data-id="${idAttr}"${sendDisabled ? ' disabled title="A prompt is already scheduled to send"' : ''}>${icon('send')}Send</button>
      <button data-act="remove" data-id="${idAttr}" class="danger">${icon('remove')}Remove</button>
      ${recoveryActions}
    </div>
  `;
}

function renderQueueItem(item, index, app) {
  const running = isRunningStatus(item.status);
  const next = item.status === 'next';
  const completed = item.status === 'completed';
  const editing = state.editingQueueItemId === item.id && !completed && !running;
  const expanded = Boolean(state.expandedQueueItems[item.id]) || editing;
  const draggable = isPendingQueueItem(item) && !editing;
  const idAttr = esc(item.id);

  return `
    <div class="${queueItemClassName({
      active: running || next,
      running,
      completed,
      draggable,
      expanded,
      editing,
    })}" data-queue-id="${idAttr}" data-queue-status="${esc(item.status)}"${draggable ? ' draggable="true"' : ''}>
      ${renderQueueHeader(item, index, draggable, completed, expanded, editing)}
      ${renderQueuePrompt(item, idAttr, expanded, editing)}
      ${item.error ? `<div class="prompt-error">${esc(item.error)}</div>` : ''}
      ${editing ? renderEditActions(item, idAttr) : (!completed && !running ? renderQueueActions(item, idAttr, app) : '')}
      ${completed ? renderUsageSummary(item) : ''}
    </div>
  `;
}

function promptTextForState(item, expanded) {
  return expanded ? item.text || item.preview || '' : item.preview || item.text || '';
}

export function findRenderedQueueItem(container, id) {
  return toArray(container.querySelectorAll('[data-queue-id]')).find((node) => node.dataset.queueId === id);
}

function updateQueuePromptToggleAttrs(root, expanded) {
  toArray(root.querySelectorAll('[data-toggle-prompt]')).forEach((node) => {
    node.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    node.title = `Click to ${expanded ? 'collapse' : 'expand'} prompt`;
  });
}

export function setQueueItemExpandedInDom(id, expanded) {
  const item = (state.snap?.queue || []).find((queueItem) => queueItem.id === id);
  if (!item) return false;

  const container = queueContainer();
  const root = container && findRenderedQueueItem(container, id);
  if (!root || root.classList.contains('editing')) return false;

  if (expanded) state.expandedQueueItems[id] = true;
  else delete state.expandedQueueItems[id];

  root.classList.toggle('expanded', expanded);
  updateQueuePromptToggleAttrs(root, expanded);

  const prompt = root.querySelector('.prompt-preview');
  if (prompt) {
    prompt.textContent = promptTextForState(item, expanded);
    prompt.setAttribute('aria-label', item.text || item.preview || '');
  }

  return true;
}

export function toggleQueueItemExpandedInDom(id) {
  if (!id) return false;
  return setQueueItemExpandedInDom(id, !Boolean(state.expandedQueueItems[id]));
}


export function renderQueueItemById(id, { restoreEditor = false } = {}) {
  const queue = state.snap?.queue || [];
  const item = queue.find((queueItem) => queueItem.id === id);
  const container = queueContainer();
  const root = container && findRenderedQueueItem(container, id);

  if (!item || !container || !root || !queueMatchesFilter(item)) return false;

  const activeEditor = restoreEditor ? captureActiveEditor() : null;
  root.outerHTML = renderQueueItem(item, queue.indexOf(item), state.snap?.app || {});

  if (restoreEditor) restoreActiveEditor(container, activeEditor);

  return true;
}

function processPendingScroll(container, queue) {
  if (state.pendingQueueScrollId) {
    const targetItem = queue.find((item) => item.id === state.pendingQueueScrollId);

    if (!targetItem || !queueMatchesFilter(targetItem)) {
      clearQueueScrollRequest();
      return;
    }

    const target = findRenderedQueueItem(container, state.pendingQueueScrollId);
    if (!target) return;

    const waitForSendPosition =
      state.pendingQueueScrollKind === 'send' &&
      targetItem?.status === 'pending' &&
      !state.pendingQueueScrollReady;

    if (waitForSendPosition) return;

    const scrollId = state.pendingQueueScrollId;
    clearQueueScrollRequest();
    scrollQueueItemAfterMove(scrollId);
    return;
  }

  if (state.didInitialQueueScroll) return;

  state.didInitialQueueScroll = true;
  const firstOpenItem = queue.find((item) => item.status !== 'completed');
  const firstTarget = firstOpenItem && findRenderedQueueItem(container, firstOpenItem.id);
  if (firstTarget) firstTarget.scrollIntoView({ block: 'center' });
}

export function renderQueue() {
  const snapshot = state.snap || {};
  const queue = snapshot.queue || [];
  const container = queueContainer();
  const app = snapshot.app || {};

  if (!container) return;

  if (!queue.length) {
    container.innerHTML = '<div class="empty">Queue is empty.</div>';
    return;
  }

  const filteredQueue = queue.filter(queueMatchesFilter);
  if (!filteredQueue.length) {
    container.innerHTML = '<div class="empty">No items match this filter.</div>';
    return;
  }

  const oldRects = queueItemRects(container);
  const activeEditor = captureActiveEditor();

  container.innerHTML = filteredQueue
    .map((item) => renderQueueItem(item, queue.indexOf(item), app))
    .join('');

  animateQueueItems(container, oldRects);
  processPendingScroll(container, queue);
  restoreActiveEditor(container, activeEditor);
}
