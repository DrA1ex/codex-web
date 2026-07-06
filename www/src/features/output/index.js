import { state } from '#core/state';
import { esc } from '#utils/format';

const OUTPUT_LABELS = {
  error: 'Error',
  stderr: 'Stderr',
  system: 'System',
  turn: 'Turn',
  send: 'Send',
  prompt: 'Prompt',
  tool: 'Tool',
  'tool-delta': 'Tool',
  reasoning: 'Reasoning',
  'reasoning-delta': 'Reasoning',
  plan: 'Plan',
  diff: 'Diff',
  item: 'Item',
  event: 'Event',
  delta: 'Assistant',
  'context-delta': 'Context',
  'user-note': 'User note',
  command: 'Command',
};

const BLOCK_OUTPUT_TYPES = new Set([
  'diff',
  'prompt',
  'plan',
  'tool-delta',
  'delta',
  'reasoning-delta',
  'context-delta',
]);

function capitalizedLabel(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function outputLabel(type, text) {
  let label = OUTPUT_LABELS[type] || 'Output';
  let body = String(text == null ? '' : text);
  const embeddedType = body.match(/^\[([^\]]+)]\s*/);

  if (embeddedType && type !== 'diff') {
    const embeddedLabel = embeddedType[1];
    label = OUTPUT_LABELS[embeddedLabel] || capitalizedLabel(embeddedLabel);
    body = body.slice(embeddedType[0].length);
  }

  return { label, body };
}


function renderCommandFeedbackLine(line) {
  const command = line.command || {};
  const status = command.status || 'info';
  const title = command.title || (status === 'error' ? 'Command error' : 'Command');
  const raw = command.raw || '';
  const message = command.message || '';
  const usage = command.usage || '';
  return `
    <div class="out-line command">
      <div class="out-command-card ${esc(status)}">
        <div class="out-command-head">
          <span>${esc(title)}</span>
          ${raw ? `<code>${esc(raw)}</code>` : ''}
        </div>
        ${message ? `<pre class="out-command-message">${esc(message)}</pre>` : ''}
        ${usage ? `<div class="out-command-usage">Usage: <code>${esc(usage)}</code></div>` : ''}
      </div>
    </div>
  `;
}

function renderDiffLine(line, meta) {
  const diffId = esc(line.id || '');
  const expanded = Boolean(state.expandedDiffOutput[line.id]);
  const active = Boolean(line.diff?.active);
  const added = Number(line.diff?.added || 0);
  const removed = Number(line.diff?.removed || 0);
  const caption = line.diff?.caption || '';

  return `
    <div class="out-line diff ${expanded ? 'expanded' : 'collapsed'}">
      <div class="out-diff-card">
        <button type="button" class="out-diff-toggle" data-output-diff="${diffId}">
          <i class="out-activity-dot ${active ? '' : 'is-idle'}" aria-hidden="true"></i>
          <span>Diff</span>
          <em>${esc(caption)}</em>
          <b class="out-diff-stat add">+${added}</b>
          <b class="out-diff-stat del">-${removed}</b>
        </button>
        ${expanded ? `<pre class="out-body">${esc(meta.body)}</pre>` : ''}
      </div>
    </div>
  `;
}

function toolExitLabel(tool) {
  if (tool.exitCode !== null && tool.exitCode !== undefined) return `exit ${tool.exitCode}`;
  if (tool.status && tool.status !== 'running') return tool.status;
  return 'running';
}

function renderCommandToolLine(line) {
  const toolId = esc(line.id || '');
  const tool = line.tool || {};
  const output = String(tool.output || '');
  const hasOutput = output.length > 0;
  const expanded = hasOutput && Boolean(state.expandedToolOutput[line.id]);
  const command = tool.command || 'command';
  const active = Boolean(tool.active);
  const headerInner = `
    <i class="out-activity-dot ${active ? '' : 'is-idle'}" aria-hidden="true"></i>
    <span>Command</span>
    <code>${esc(command)}</code>
    <b>${esc(toolExitLabel(tool))}</b>
  `;
  const header = hasOutput
    ? `<button type="button" class="out-tool-toggle" data-output-tool="${toolId}">${headerInner}</button>`
    : `<div class="out-tool-toggle is-static">${headerInner}</div>`;

  return `
    <div class="out-line tool ${expanded ? 'expanded' : 'collapsed'}">
      <div class="out-tool-card">
        ${header}
        ${expanded ? `<pre class="out-body">${esc(output)}</pre>` : ''}
      </div>
    </div>
  `;
}

function groupStatusLabel(group) {
  if (group.status === 'active') return 'running';
  if (group.status === 'failed') return 'failed';
  return 'done';
}

function groupMetaLabel(group) {
  const pieces = [];
  if (group.model) pieces.push(group.model);
  if (group.effort) pieces.push(`effort: ${group.effort}`);
  return pieces.join(' · ');
}

function renderOutputGroup(group, lines) {
  const isActive = group.status === 'active';
  const expanded = isActive || Boolean(state.expandedOutputGroups[group.id]);
  const groupId = esc(group.id || '');
  const status = groupStatusLabel(group);
  const summary = group.summary || (isActive ? 'Running...' : 'Prompt completed.');
  const meta = groupMetaLabel(group);
  const body = expanded
    ? `<div class="out-group-body">${lines.map(renderOutputLine).join('')}</div>`
    : `<p class="out-group-summary">${esc(summary)}</p>`;
  const headerInner = `
        ${isActive
    ? '<i class="out-activity-dot out-group-activity" aria-hidden="true"></i>'
    : `<span class="out-group-chevron icon icon-chevron-${expanded ? 'up' : 'down'}" aria-hidden="true"></span>`}
        <span class="out-group-title">Prompt</span>
        <strong>${esc(group.title || 'Prompt')}</strong>
        <b class="out-group-status">${esc(status)}</b>
        ${meta ? `<em>${esc(meta)}</em>` : ''}
  `;
  const header = isActive
    ? `<div class="out-group-head is-static" aria-live="polite">${headerInner}</div>`
    : `<button type="button" class="out-group-head" data-output-group="${groupId}" aria-expanded="${expanded ? 'true' : 'false'}">${headerInner}</button>`;

  return `
    <section class="out-group ${expanded ? 'expanded' : 'collapsed'} ${esc(group.status || '')}">
      ${header}
      ${body}
    </section>
  `;
}

function renderOutputHistoryControl() {
  const history = state.snap?.outputHistory || {};
  const loading = Boolean(state.outputHistoryLoading);
  if (!loading && !history.hasMore) return '';

  return `
    <div class="out-history-control">
      <button type="button" data-output-history-more="1" ${loading ? 'disabled' : ''}>
        <i class="out-activity-dot ${loading ? '' : 'is-idle'}" aria-hidden="true"></i>
        <span>${loading ? 'Loading earlier prompt...' : 'Load earlier prompt'}</span>
      </button>
    </div>
  `;
}

function renderGroupedOutput(lines, groups) {
  if (!groups.length) return lines.map(renderOutputLine).join('');

  const linesByGroup = new Map();
  for (const line of lines) {
    if (!line.groupId) continue;
    const bucket = linesByGroup.get(line.groupId) || [];
    bucket.push(line);
    linesByGroup.set(line.groupId, bucket);
  }

  const rendered = [];
  const renderedGroupIds = new Set();

  for (const line of lines) {
    if (!line.groupId) {
      rendered.push(renderOutputLine(line));
      continue;
    }
    if (renderedGroupIds.has(line.groupId)) continue;
    const group = groups.find((candidate) => candidate.id === line.groupId);
    if (!group) {
      rendered.push(renderOutputLine(line));
      continue;
    }
    renderedGroupIds.add(line.groupId);
    rendered.push(renderOutputGroup(group, linesByGroup.get(line.groupId) || []));
  }

  for (const group of groups) {
    if (!renderedGroupIds.has(group.id)) rendered.push(renderOutputGroup(group, []));
  }

  return rendered.join('');
}

function renderOutputLine(line) {
  const type = line.type || 'text';
  const meta = outputLabel(type, line.text);

  if (type === 'command') return renderCommandFeedbackLine(line);
  if (type === 'diff') return renderDiffLine(line, meta);
  if (type === 'tool' && line.tool?.kind === 'command') return renderCommandToolLine(line);

  const body = BLOCK_OUTPUT_TYPES.has(type)
    ? `<pre class="out-body">${esc(meta.body)}</pre>`
    : `<span class="out-body">${esc(meta.body)}</span>`;
  const action = type === 'user-note' && line.steer?.forceAvailable
    ? `<button type="button" class="out-inline-action" data-force-steer="${esc(line.id || '')}">Force send</button>`
    : '';

  return `
    <div class="out-line ${esc(type)}">
      <span class="out-label">${esc(meta.label)}</span>
      ${body}
      ${action}
    </div>
  `;
}

function updateOutputJumpAction() {
  const button = document.getElementById('bottomBtn');
  if (!button) return;
  button.classList.toggle('has-new-output', state.outputUnread);
  button.innerHTML = `<span class="icon icon-arrow-down" aria-hidden="true"></span>${state.outputUnread ? 'New output' : 'Scroll to bottom'}`;
}

function outputIsNearBottom() {
  const outputEl = state.outputEl;
  if (!outputEl) return true;
  return outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight < 30;
}

function outputContentKey() {
  const lines = state.snap?.output || [];
  return lines.map(outputLineKey).join('|');
}

function outputLineKey(line) {
  return [
    line.id || '',
    line.type || '',
    line.ts || '',
    String(line.text || '').length,
    String(line.tool?.output || '').length,
    line.tool?.active ? 'tool-active' : '',
    line.diff?.active ? 'diff-active' : '',
  ].join(':');
}

function outputGroupById() {
  const groups = new Map();
  for (const group of state.snap?.outputGroups || []) {
    if (group?.id) groups.set(group.id, group);
  }
  return groups;
}

function isHistoryOutputLine(line, groups) {
  return line?.source === 'history' || groups.get(line?.groupId)?.source === 'history';
}

function liveOutputChanged(previousLineKeys) {
  const groups = outputGroupById();
  for (const line of state.snap?.output || []) {
    const id = line?.id || '';
    if (!id || isHistoryOutputLine(line, groups)) continue;
    const nextKey = outputLineKey(line);
    if (previousLineKeys[id] !== nextKey) return true;
  }
  return false;
}

export function updateOutputScrollState() {
  if (!outputIsNearBottom() || !state.outputUnread) return;
  state.outputUnread = false;
  updateOutputJumpAction();
}

export function attachOutputScrollHandler() {
  if (!state.outputEl) return;
  state.outputEl.addEventListener('scroll', updateOutputScrollState, { passive: true });
}

export function renderOutput() {
  const outputEl = state.outputEl;
  if (!outputEl) return;

  const wasAtBottom = outputIsNearBottom();
  const previousContentKey = state.outputContentKey;
  const previousLineKeys = state.outputLineKeys || Object.create(null);
  const nextContentKey = outputContentKey();
  const contentChanged = previousContentKey !== '' && previousContentKey !== nextContentKey;
  const hasLiveOutputChange = contentChanged && liveOutputChanged(previousLineKeys);
  outputEl.innerHTML = `${renderOutputHistoryControl()}${renderGroupedOutput(state.snap?.output || [], state.snap?.outputGroups || [])}`;
  state.outputContentKey = nextContentKey;
  state.outputLineKeys = Object.create(null);
  for (const line of state.snap?.output || []) {
    if (line?.id) state.outputLineKeys[line.id] = outputLineKey(line);
  }

  if (wasAtBottom) {
    outputEl.scrollTop = outputEl.scrollHeight;
    state.outputUnread = false;
  } else if (hasLiveOutputChange) {
    state.outputUnread = true;
  }
  updateOutputJumpAction();
}
