'use strict';

const { MAX_OUTPUT_LINES, MAX_OUTPUT_TOTAL_CHARS } = require('../../shared/config');
const { nowIso, randomId } = require('../../shared/utils');
const {
  canAppendOutput,
  limitOutputText,
  appendLimitedOutputText,
} = require('../../codex/output-format');

module.exports = {
  outputPayload() {
    return { output: this.output, outputGroups: this.outputGroups };
  },

  broadcastOutput() {
    this.broadcast('output', this.outputPayload());
  },

  outputGroupTitle(item) {
    const firstLine = String(item?.text || '').trim().split(/\r?\n/).find(Boolean) || `Prompt #${item?.id || '?'}`;
    return firstLine.length > 76 ? `${firstLine.slice(0, 73)}...` : firstLine;
  },

  outputGroupForId(groupId) {
    return groupId ? this.outputGroups.find((group) => group.id === groupId) || null : null;
  },

  currentOutputMeta(extra = {}) {
    const group = this.outputGroupForId(this.currentOutputGroupId);
    if (!group) return { ...extra };
    return {
      groupId: group.id,
      queueItemId: group.queueItemId,
      turnId: this.currentTurnId || group.turnId || null,
      ...extra,
    };
  },

  createOutputGroupForItem(item) {
    const existing = this.outputGroups.find((group) => group.queueItemId === item.id && group.status === 'active');
    if (existing) {
      this.currentOutputGroupId = existing.id;
      return existing;
    }

    const group = {
      id: randomId(8),
      queueItemId: item.id,
      turnId: null,
      title: this.outputGroupTitle(item),
      promptText: item.text,
      status: 'active',
      summary: 'Running...',
      startedAt: nowIso(),
      finishedAt: null,
      model: this.opts.model || this.app.defaultModel || '',
      effort: this.opts.effort || this.app.effort || '',
    };
    this.outputGroups.push(group);
    this.currentOutputGroupId = group.id;
    return group;
  },

  updateCurrentOutputGroup(fields) {
    const group = this.outputGroupForId(this.currentOutputGroupId);
    if (!group) return null;
    Object.assign(group, fields);
    return group;
  },

  importantOutputLinesForGroup(groupId) {
    return this.output.filter((entry) => entry.groupId === groupId);
  },

  summarizeOutputGroup(group, status, errMessage) {
    if (errMessage) return `Failed: ${errMessage}`;

    const lines = this.importantOutputLinesForGroup(group.id);
    const assistant = [...lines]
      .reverse()
      .find((entry) => entry.type === 'delta' && String(entry.text || '').trim());
    if (assistant) {
      const text = String(assistant.text || '').replace(/\s+/g, ' ').trim();
      return text.length > 180 ? `${text.slice(0, 177)}...` : text;
    }

    const diffs = lines.filter((entry) => entry.type === 'diff');
    const tools = lines.filter((entry) => entry.type === 'tool');
    const failedTool = tools.find((entry) => {
      const code = entry.tool?.exitCode;
      return code !== null && code !== undefined && code !== 0;
    });

    if (failedTool) return `Finished with a failing command: ${failedTool.tool?.command || 'command'}.`;
    if (diffs.length && tools.length) return `Completed with ${diffs.length} diff block(s) and ${tools.length} command/tool block(s).`;
    if (diffs.length) return `Completed with ${diffs.length} diff block(s).`;
    if (tools.length) return `Completed with ${tools.length} command/tool block(s).`;
    return status === 'failed' ? 'Prompt failed.' : 'Prompt completed.';
  },

  finishCurrentOutputGroup(status = 'completed', errMessage = null) {
    const group = this.outputGroupForId(this.currentOutputGroupId);
    if (!group || group.status !== 'active') return null;
    group.status = status;
    group.finishedAt = nowIso();
    group.turnId = this.currentTurnId || group.turnId || null;
    group.summary = this.summarizeOutputGroup(group, status, errMessage);
    return group;
  },

  appendOutput(text, type = 'text', appendToPrevious = false, meta = null) {
    if (text === undefined || text === null || text === '') return;
    if (type !== 'diff') this.closeCurrentDiffOutput();
    const outputMeta = meta || this.currentOutputMeta();
    let entry;
    if (appendToPrevious && this.output.length) {
      const last = this.output[this.output.length - 1];
      if (canAppendOutput(last.type, type) && (last.groupId || null) === (outputMeta.groupId || null)) {
        last.text = appendLimitedOutputText(last.text, text);
        last.ts = nowIso();
        Object.assign(last, outputMeta);
        entry = last;
      } else {
        entry = { id: randomId(5), ts: nowIso(), type, text: limitOutputText(text), ...outputMeta };
        this.output.push(entry);
      }
    } else {
      entry = { id: randomId(5), ts: nowIso(), type, text: limitOutputText(text), ...outputMeta };
      this.output.push(entry);
    }
    this.trimOutput();
    this.broadcastOutput();
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
      ...this.currentOutputMeta({ groupRole: 'tool' }),
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
    this.broadcastOutput();
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
    this.broadcastOutput();
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
      this.broadcastOutput();
      return;
    }
    if (out) {
      if (!/\nexit: /.test(String(out.text || ''))) {
        out.text = appendLimitedOutputText(out.text, line);
      }
      out.ts = nowIso();
      this.broadcastOutput();
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
      Object.assign(entry, this.currentOutputMeta({ groupRole: 'diff' }));
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
    this.broadcastOutput();
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
    const groupIds = new Set(this.output.map((x) => x.groupId).filter(Boolean));
    this.outputGroups = this.outputGroups.filter((group) => groupIds.has(group.id) || group.id === this.currentOutputGroupId);
  },

  clearOutput() {
    this.output = [];
    this.outputGroups = [];
    this.currentOutputGroupId = null;
    this.lastDiffOutputText = null;
    this.currentDiffOutputId = null;
    this.currentDiffFileKey = null;
    if (this.diffSnapshotByFileKey) this.diffSnapshotByFileKey.clear();
    this.commandOutputByItemId.clear();
    this.broadcastOutput();
    this.broadcastAll();
  }
};
