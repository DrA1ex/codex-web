'use strict';

const { MAX_OUTPUT_LINES, MAX_OUTPUT_TOTAL_CHARS } = require('../../shared/config');
const { nowIso, randomId } = require('../../shared/utils');
const {
  canAppendOutput,
  limitOutputText,
  appendLimitedOutputText,
} = require('../../codex/output-format');

module.exports = {
  appendOutput(text, type = 'text', appendToPrevious = false) {
    if (text === undefined || text === null || text === '') return;
    let entry;
    if (appendToPrevious && this.output.length) {
      const last = this.output[this.output.length - 1];
      if (canAppendOutput(last.type, type)) {
        last.text = appendLimitedOutputText(last.text, text);
        last.ts = nowIso();
        entry = last;
      } else {
        entry = { id: randomId(5), ts: nowIso(), type, text: limitOutputText(text) };
        this.output.push(entry);
      }
    } else {
      entry = { id: randomId(5), ts: nowIso(), type, text: limitOutputText(text) };
      this.output.push(entry);
    }
    this.trimOutput();
    this.broadcast('output', this.output);
    return entry;
  },

  commandItemId(item) {
    return item && (item.id || item.itemId || item.callId || item.toolCallId || item.executionId || null);
  },

  trackCommandOutput(item, outputItem) {
    if (!outputItem) return;
    const id = this.commandItemId(item);
    if (id) this.commandOutputByItemId.set(String(id), outputItem.id);
    this.commandOutputByItemId.set('__last__', outputItem.id);
  },

  appendCommandOutput(item) {
    const command = Array.isArray(item?.command) ? item.command.join(' ') : String(item?.command || '');
    const entry = {
      id: randomId(5),
      ts: nowIso(),
      type: 'tool',
      text: `[tool] command: ${command}`,
      tool: {
        kind: 'command',
        command,
        output: '',
        status: 'running',
        exitCode: null,
        active: true,
      },
    };
    this.output.push(entry);
    this.trimOutput();
    this.broadcast('output', this.output);
    this.trackCommandOutput(item, entry);
    return entry;
  },

  commandOutputEntry(item) {
    const id = this.commandItemId(item);
    const outputId = (id && this.commandOutputByItemId.get(String(id))) || this.commandOutputByItemId.get('__last__');
    return outputId ? this.output.find((x) => x.id === outputId) : null;
  },

  appendCommandOutputText(item, text) {
    if (text === undefined || text === null || text === '') return false;
    const out = this.commandOutputEntry(item);
    if (!out || out.type !== 'tool' || out.tool?.kind !== 'command') return false;

    out.tool.output = appendLimitedOutputText(out.tool.output || '', text);
    out.tool.active = true;
    out.ts = nowIso();
    this.broadcast('output', this.output);
    return true;
  },

  updateCommandOutput(item) {
    const out = this.commandOutputEntry(item);
    const exitCode = item.exitCode !== undefined && item.exitCode !== null ? item.exitCode : (item.exit_code !== undefined ? item.exit_code : null);
    const status = item.status || 'completed';
    const line = exitCode === null ? `\nexit: ${status}` : `\nexit: ${exitCode}`;
    if (out && out.tool?.kind === 'command') {
      out.tool.status = status;
      out.tool.exitCode = exitCode;
      out.tool.active = false;
      out.ts = nowIso();
      this.broadcast('output', this.output);
      return;
    }
    if (out) {
      if (!/\nexit: /.test(String(out.text || ''))) {
        out.text = appendLimitedOutputText(out.text, line);
      }
      out.ts = nowIso();
      this.broadcast('output', this.output);
      return;
    }
    this.appendOutput(`[tool] command\n${line.trim()}`, item?.status === 'failed' ? 'error' : 'tool');
  },

  finishActiveOutputBlocks() {
    for (const out of this.output) {
      if (out.tool) out.tool.active = false;
      if (out.diff) out.diff.active = false;
    }
  },

  updateDiffOutput(text) {
    if (text === undefined || text === null || text === '') return;
    const limited = limitOutputText(text);
    if (this.lastDiffOutputText === limited) return;
    this.lastDiffOutputText = limited;
    const last = this.output[this.output.length - 1];
    if (last && last.type === 'diff') {
      if (last.text === limited) return;
      last.text = limited;
      last.ts = nowIso();
      last.diff = { ...(last.diff || {}), active: true };
    } else {
      this.output.push({ id: randomId(5), ts: nowIso(), type: 'diff', text: limited, diff: { active: true } });
    }
    this.trimOutput();
    this.broadcast('output', this.output);
  },

  trimOutput() {
    if (this.output.length > MAX_OUTPUT_LINES) this.output.splice(0, this.output.length - MAX_OUTPUT_LINES);
    let total = 0;
    for (let i = this.output.length - 1; i >= 0; i--) {
      total += String(this.output[i].text || '').length;
      if (total > MAX_OUTPUT_TOTAL_CHARS) {
        this.output.splice(0, i + 1);
        break;
      }
    }
    const outputIds = new Set(this.output.map((x) => x.id));
    for (const [key, value] of this.commandOutputByItemId.entries()) {
      if (!outputIds.has(value)) this.commandOutputByItemId.delete(key);
    }
  },

  clearOutput() {
    this.output = [];
    this.lastDiffOutputText = null;
    this.commandOutputByItemId.clear();
    this.broadcast('output', this.output);
    this.broadcastAll();
  }
};
