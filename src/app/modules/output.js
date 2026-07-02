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

  updateCommandOutput(item) {
    const id = this.commandItemId(item);
    const outputId = (id && this.commandOutputByItemId.get(String(id))) || this.commandOutputByItemId.get('__last__');
    const out = outputId ? this.output.find((x) => x.id === outputId) : null;
    const exitCode = item.exitCode !== undefined && item.exitCode !== null ? item.exitCode : (item.exit_code !== undefined ? item.exit_code : null);
    const status = item.status || 'completed';
    const line = exitCode === null ? `\nexit: ${status}` : `\nexit: ${exitCode}`;
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
    } else {
      this.output.push({ id: randomId(5), ts: nowIso(), type: 'diff', text: limited });
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
