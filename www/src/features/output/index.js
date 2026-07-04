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
  const expanded = group.status === 'active' || Boolean(state.expandedOutputGroups[group.id]);
  const groupId = esc(group.id || '');
  const status = groupStatusLabel(group);
  const summary = group.summary || (group.status === 'active' ? 'Running...' : 'Prompt completed.');
  const meta = groupMetaLabel(group);
  const body = expanded
    ? `<div class="out-group-body">${lines.map(renderOutputLine).join('')}</div>`
    : `<p class="out-group-summary">${esc(summary)}</p>`;

  return `
    <section class="out-group ${expanded ? 'expanded' : 'collapsed'} ${esc(group.status || '')}">
      <button type="button" class="out-group-head" data-output-group="${groupId}" aria-expanded="${expanded ? 'true' : 'false'}">
        <span class="out-group-chevron">${expanded ? 'v' : '>'}</span>
        <span class="out-group-title">Prompt</span>
        <strong>${esc(group.title || 'Prompt')}</strong>
        <b class="out-group-status">${esc(status)}</b>
        ${meta ? `<em>${esc(meta)}</em>` : ''}
      </button>
      ${body}
    </section>
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

  if (type === 'diff') return renderDiffLine(line, meta);
  if (type === 'tool' && line.tool?.kind === 'command') return renderCommandToolLine(line);

  const body = BLOCK_OUTPUT_TYPES.has(type)
    ? `<pre class="out-body">${esc(meta.body)}</pre>`
    : `<span class="out-body">${esc(meta.body)}</span>`;

  return `
    <div class="out-line ${esc(type)}">
      <span class="out-label">${esc(meta.label)}</span>
      ${body}
    </div>
  `;
}

function updateOutputJumpAction() {
  const button = document.getElementById('bottomBtn');
  if (!button) return;
  button.classList.toggle('has-new-output', state.outputUnread);
  button.innerHTML = `<span class="icon icon-arrow-down" aria-hidden="true"></span>${state.outputUnread ? 'New output' : 'Scroll to bottom'}`;
}

export function renderOutput() {
  const outputEl = state.outputEl;
  if (!outputEl) return;

  const wasAtBottom = outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight < 30;
  outputEl.innerHTML = renderGroupedOutput(state.snap?.output || [], state.snap?.outputGroups || []);

  if (wasAtBottom) {
    outputEl.scrollTop = outputEl.scrollHeight;
    state.outputUnread = false;
  } else {
    state.outputUnread = true;
  }
  updateOutputJumpAction();
}
