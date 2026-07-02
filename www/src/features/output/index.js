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
  const lines = String(meta.body || '').split(/\r?\n/);
  const firstLine = lines.find((item) => item.trim()) || 'Diff updated';

  return `
    <div class="out-line diff ${expanded ? 'expanded' : 'collapsed'}">
      <div class="out-diff-card">
        <button type="button" class="out-diff-toggle" data-output-diff="${diffId}">
          <span>${expanded ? 'Collapse' : 'Expand'} diff</span>
          <b>${lines.length} lines</b>
          <em>${esc(firstLine)}</em>
        </button>
        ${expanded ? `<pre class="out-body">${esc(meta.body)}</pre>` : ''}
      </div>
    </div>
  `;
}

function renderOutputLine(line) {
  const type = line.type || 'text';
  const meta = outputLabel(type, line.text);

  if (type === 'diff') return renderDiffLine(line, meta);

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
