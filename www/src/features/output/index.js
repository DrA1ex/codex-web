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

  return `
    <div class="out-line diff ${expanded ? 'expanded' : 'collapsed'}">
      <div class="out-diff-card">
        <button type="button" class="out-diff-toggle" data-output-diff="${diffId}">
          <i class="out-activity-dot ${active ? '' : 'is-idle'}" aria-hidden="true"></i>
          <span>Diff</span>
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

export function renderOutput() {
  const outputEl = state.outputEl;
  if (!outputEl) return;

  const wasAtBottom = outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight < 30;
  outputEl.innerHTML = (state.snap?.output || []).map(renderOutputLine).join('');

  if (wasAtBottom) outputEl.scrollTop = outputEl.scrollHeight;
}
