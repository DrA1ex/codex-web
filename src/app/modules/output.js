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
    if (type !== 'diff') this.closeCurrentDiffOutput();
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
    this.closeCurrentDiffOutput();
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
    this.closeCurrentDiffOutput();
    const out = this.commandOutputEntry(item);
    if (!out || out.type !== 'tool' || out.tool?.kind !== 'command') return false;

    out.tool.output = appendLimitedOutputText(out.tool.output || '', text);
    out.tool.active = true;
    out.ts = nowIso();
    this.broadcast('output', this.output);
    return true;
  },

  updateCommandOutput(item) {
    this.closeCurrentDiffOutput();
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
    this.currentDiffOutputId = null;
    this.currentDiffFileKey = null;
    this.lastDiffOutputText = null;
    if (this.diffSnapshotByFileKey) this.diffSnapshotByFileKey.clear();
  },

  closeCurrentDiffOutput() {
    const outputId = this.currentDiffOutputId;
    if (!outputId) return;

    const out = this.output.find((entry) => entry.id === outputId && entry.type === 'diff');
    if (out?.diff?.active) {
      out.diff.active = false;
      out.ts = nowIso();
    }
    this.currentDiffOutputId = null;
    this.currentDiffFileKey = null;
    this.lastDiffOutputText = null;
  },

  diffFiles(text) {
    const files = [];
    const seen = new Set();
    for (const line of String(text || '').split(/\r?\n/)) {
      const gitMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const file = gitMatch
        ? (gitMatch[2] || gitMatch[1])
        : (line.startsWith('+++ b/')
          ? line.slice(6)
          : (line.startsWith('--- a/') ? line.slice(6) : null));
      if (file && file !== '/dev/null' && !seen.has(file)) {
        seen.add(file);
        files.push(file);
      }
    }
    return files;
  },

  diffFileKey(text) {
    const files = this.diffFiles(text);
    if (files.length === 1) return files[0];
    if (files.length > 1) return `multi:${files.join('\n')}`;
    return '';
  },

  diffStats(text) {
    let added = 0;
    let removed = 0;
    for (const line of String(text || '').split(/\r?\n/)) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) removed += 1;
    }
    return { added, removed };
  },

  diffCaption(text) {
    const files = this.diffFiles(text);
    if (files.length === 1) return files[0];
    if (files.length > 1) return `${files.length} files`;
    return '';
  },

  diffSections(text) {
    const raw = String(text || '');
    const lines = raw.split(/\r?\n/);
    const chunks = [];
    let chunk = [];

    for (const line of lines) {
      if (/^diff --git /.test(line) && chunk.length) {
        chunks.push(chunk.join('\n'));
        chunk = [];
      }
      chunk.push(line);
    }
    if (chunk.length) chunks.push(chunk.join('\n'));

    return chunks
      .map((chunkText, index) => {
        const limited = limitOutputText(chunkText);
        const fileKey = this.diffFileKey(limited) || `section:${index}`;
        return {
          text: limited,
          fileKey,
          diff: {
            added: 0,
            removed: 0,
            ...this.diffStats(limited),
            caption: this.diffCaption(limited),
            active: false,
          },
        };
      })
      .filter((section) => section.text !== '');
  },

  appendOrUpdateDiffSection(section) {
    const current = this.currentDiffOutputId
      ? this.output.find((entry) => entry.id === this.currentDiffOutputId && entry.type === 'diff')
      : null;

    if (current && this.currentDiffFileKey === section.fileKey) {
      if (current.text === section.text || this.lastDiffOutputText === section.text) return false;
      current.text = section.text;
      current.ts = nowIso();
      current.diff = { ...(current.diff || {}), ...section.diff };
    } else {
      this.closeCurrentDiffOutput();
      const entry = { id: randomId(5), ts: nowIso(), type: 'diff', text: section.text, diff: section.diff };
      this.output.push(entry);
      this.currentDiffOutputId = entry.id;
      this.currentDiffFileKey = section.fileKey;
    }

    this.lastDiffOutputText = section.text;
    return true;
  },

  updateDiffOutput(text) {
    if (text === undefined || text === null || text === '') return;
    if (!this.diffSnapshotByFileKey) this.diffSnapshotByFileKey = new Map();

    let changed = false;
    for (const section of this.diffSections(text)) {
      if (this.diffSnapshotByFileKey.get(section.fileKey) === section.text) continue;
      this.diffSnapshotByFileKey.set(section.fileKey, section.text);
      if (this.appendOrUpdateDiffSection(section)) changed = true;
    }

    if (!changed) return;

    this.trimOutput();
    if (!this.output.some((entry) => entry.id === this.currentDiffOutputId)) {
      this.currentDiffOutputId = null;
      this.currentDiffFileKey = null;
      this.lastDiffOutputText = null;
    }
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
    this.currentDiffOutputId = null;
    this.currentDiffFileKey = null;
    if (this.diffSnapshotByFileKey) this.diffSnapshotByFileKey.clear();
    this.commandOutputByItemId.clear();
    this.broadcast('output', this.output);
    this.broadcastAll();
  }
};
