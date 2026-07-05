'use strict';

const { MAX_OUTPUT_LINES, MAX_OUTPUT_TOTAL_CHARS } = require('../../shared/config');
const { nowIso, randomId, asArray, truncate } = require('../../shared/utils');
const {
  canAppendOutput,
  limitOutputText,
  appendLimitedOutputText,
} = require('../../codex/output-format');

module.exports = {
  outputPayload() {
    return { output: this.output, outputGroups: this.outputGroups, outputHistory: this.outputHistoryPayload() };
  },

  broadcastOutput() {
    this.broadcast('output', this.outputPayload());
  },

  outputGroupTitle(item) {
    const firstLine = String(item?.text || '').trim().split(/\r?\n/).find(Boolean) || `Prompt #${item?.id || '?'}`;
    return firstLine.length > 76 ? `${firstLine.slice(0, 73)}...` : firstLine;
  },

  ensureOutputHistoryState() {
    const sessionId = this.app.sessionId || null;
    if (!this.outputHistory || this.outputHistory.sessionId !== sessionId) {
      this.outputHistory = {
        sessionId,
        hasMore: !!sessionId,
        loadedTurnIds: new Set(),
      };
    }
    if (!(this.outputHistory.loadedTurnIds instanceof Set)) {
      this.outputHistory.loadedTurnIds = new Set(this.outputHistory.loadedTurnIds || []);
    }
    return this.outputHistory;
  },

  outputHistoryPayload() {
    const history = this.ensureOutputHistoryState();
    return {
      hasMore: !!(history.sessionId && history.hasMore),
    };
  },

  outputGroupForId(groupId) {
    return groupId ? this.outputGroups.find((group) => group.id === groupId) || null : null;
  },

  outputGroupForTurnId(turnId) {
    if (!turnId) return null;
    return this.outputGroups.find((group) => (
      group.turnId === turnId || (Array.isArray(group.turnIds) && group.turnIds.includes(turnId))
    )) || null;
  },

  outputGroupForQueueItemId(queueItemId) {
    if (!queueItemId) return null;
    return this.outputGroups.find((group) => group.queueItemId === queueItemId && group.status === 'active') || null;
  },

  useOutputGroup(groupId) {
    const group = this.outputGroupForId(groupId);
    if (!group) return null;
    this.currentOutputGroupId = group.id;
    return group;
  },

  addTurnToOutputGroup(group, turnId) {
    if (!group || !turnId) return group || null;
    if (!Array.isArray(group.turnIds)) group.turnIds = [];
    if (!group.turnIds.includes(turnId)) group.turnIds.push(turnId);
    group.turnId = turnId;
    return group;
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
      turnIds: [],
      status: 'active',
      summary: 'Running...',
      summaryText: '',
      summarySource: '',
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
    if (fields && fields.turnId) this.addTurnToOutputGroup(group, fields.turnId);
    return group;
  },

  importantOutputLinesForGroup(groupId) {
    return this.output.filter((entry) => entry.groupId === groupId);
  },

  recordOutputGroupSummary(text, source = 'summary', append = false) {
    const group = this.outputGroupForId(this.currentOutputGroupId);
    const value = String(text || '').trim();
    if (!group || !value) return null;

    group.summaryText = append
      ? appendLimitedOutputText(group.summaryText ? `${group.summaryText}\n` : '', value).trim()
      : limitOutputText(value).trim();
    group.summarySource = source;
    if (group.status !== 'active') group.summary = group.summaryText;
    return group;
  },

  summarizeOutputGroup(group, status, errMessage) {
    if (errMessage) return `Failed: ${errMessage}`;
    if (group.summaryText) return group.summaryText;

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

  extractHistoryTurns(readResult) {
    const thread = readResult?.thread || readResult?.session || readResult;
    return asArray(thread?.turns || readResult?.turns || readResult?.items);
  },

  textFromContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((item) => this.textFromContent(item)).filter(Boolean).join('\n');
    }
    if (!content || typeof content !== 'object') return '';
    return this.textFromContent(content.text)
      || this.textFromContent(content.value)
      || this.textFromContent(content.content)
      || this.textFromContent(content.message)
      || this.textFromContent(content.output)
      || '';
  },

  textFromHistoryItem(item) {
    if (!item || typeof item !== 'object') return '';
    return this.textFromContent(item.content)
      || this.textFromContent(item.text)
      || this.textFromContent(item.message)
      || this.textFromContent(item.output)
      || this.textFromContent(item.delta);
  },

  historyItemRole(item) {
    const role = String(item?.role || item?.author?.role || '').toLowerCase();
    if (role) return role;
    const type = String(item?.type || item?.kind || '').toLowerCase();
    if (type.includes('user')) return 'user';
    if (type.includes('agent') || type.includes('assistant')) return 'assistant';
    return '';
  },

  normalizeHistoryTurn(turn, fallbackId) {
    const items = asArray(turn?.items || turn?.messages || turn?.entries || turn?.events);
    const promptParts = [];
    const assistantParts = [];

    for (const item of items) {
      const role = this.historyItemRole(item);
      const text = this.textFromHistoryItem(item).trim();
      if (!text) continue;
      if (role === 'user') promptParts.push(text);
      else if (role === 'assistant') assistantParts.push(text);
    }

    const promptText = promptParts.join('\n\n').trim()
      || this.textFromContent(turn?.input).trim()
      || this.textFromContent(turn?.prompt).trim();
    const assistantText = assistantParts.join('\n\n').trim()
      || this.textFromContent(turn?.output).trim()
      || this.textFromContent(turn?.response).trim()
      || this.textFromContent(turn?.summary).trim();

    if (!promptText && !assistantText) return null;

    const turnId = String(turn?.id || turn?.turnId || fallbackId || randomId(4));
    const title = this.outputGroupTitle({ id: turnId, text: promptText || assistantText });
    const summary = assistantText
      ? truncate(assistantText, 180)
      : 'Prompt completed.';
    const timestamp = turn?.completedAt || turn?.finishedAt || turn?.updatedAt || turn?.createdAt || nowIso();

    return {
      turnId,
      title,
      promptText,
      assistantText,
      summary,
      timestamp,
      model: turn?.model || '',
      effort: turn?.effort || '',
    };
  },

  knownOutputTurnIds() {
    const ids = new Set();
    for (const group of this.outputGroups || []) {
      if (group.turnId) ids.add(String(group.turnId));
      for (const id of group.turnIds || []) ids.add(String(id));
    }
    if (this.currentTurnId) ids.add(String(this.currentTurnId));
    for (const id of this.ensureOutputHistoryState().loadedTurnIds || []) ids.add(String(id));
    return ids;
  },

  prependHistoryOutputGroup(historyTurn) {
    const groupId = randomId(8);
    const ts = historyTurn.timestamp || nowIso();
    const group = {
      id: groupId,
      queueItemId: null,
      turnId: historyTurn.turnId,
      title: historyTurn.title,
      promptText: historyTurn.promptText,
      turnIds: [historyTurn.turnId],
      status: 'completed',
      summary: historyTurn.summary,
      summaryText: historyTurn.summary,
      summarySource: 'history',
      startedAt: ts,
      finishedAt: ts,
      model: historyTurn.model || '',
      effort: historyTurn.effort || '',
      source: 'history',
    };
    const entries = [];
    if (historyTurn.promptText) {
      entries.push({
        id: randomId(5),
        ts,
        type: 'prompt',
        text: `[prompt]\n${limitOutputText(historyTurn.promptText)}`,
        groupId,
        turnId: historyTurn.turnId,
        groupRole: 'prompt',
      });
    }
    if (historyTurn.assistantText) {
      entries.push({
        id: randomId(5),
        ts,
        type: 'delta',
        text: limitOutputText(historyTurn.assistantText),
        groupId,
        turnId: historyTurn.turnId,
      });
    }

    this.outputGroups.unshift(group);
    this.output.unshift(...entries);
    return group;
  },

  async loadPreviousOutputGroup() {
    const history = this.ensureOutputHistoryState();
    if (!history.sessionId) throw new Error('No Codex session selected');
    if (!history.hasMore) return { ok: true, loaded: false, hasMore: false };

    const read = await this.rpc.request('thread/read', { threadId: history.sessionId, includeTurns: true }, 8000);
    const turns = this.extractHistoryTurns(read);
    const known = this.knownOutputTurnIds();
    let loaded = null;
    let loadedIndex = -1;

    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index];
      const turnId = String(turn?.id || turn?.turnId || `index:${index}`);
      if (known.has(turnId)) continue;
      const normalized = this.normalizeHistoryTurn(turn, turnId);
      if (!normalized) {
        known.add(turnId);
        history.loadedTurnIds.add(turnId);
        continue;
      }
      loaded = normalized;
      loadedIndex = index;
      break;
    }

    if (!loaded) {
      history.hasMore = false;
      this.broadcastAll();
      return { ok: true, loaded: false, hasMore: false };
    }

    this.prependHistoryOutputGroup(loaded);
    history.loadedTurnIds.add(loaded.turnId);
    known.add(loaded.turnId);
    history.hasMore = turns.some((turn, index) => {
      if (index >= loadedIndex) return false;
      const turnId = String(turn?.id || turn?.turnId || `index:${index}`);
      return !known.has(turnId) && !!this.normalizeHistoryTurn(turn, turnId);
    });
    this.broadcastOutput();
    this.broadcastAll();
    return { ok: true, loaded: true, hasMore: history.hasMore };
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


  appendCommandFeedback(command) {
    const payload = command || {};
    const entry = {
      id: randomId(5),
      ts: nowIso(),
      type: 'command',
      command: {
        status: payload.status || 'info',
        title: payload.title || (payload.status === 'error' ? 'Command error' : 'Command'),
        raw: String(payload.raw || ''),
        message: String(payload.message || ''),
        usage: String(payload.usage || ''),
      },
      ...this.currentOutputMeta(),
    };
    this.output.push(entry);
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
    const groupKey = outputItem.groupId ? `__last_group__:${outputItem.groupId}` : '__last_group__:none';
    this.commandOutputByItemId.set(groupKey, outputItem.id);
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
    const groupId = this.currentOutputGroupId || null;
    const groupOutputId = groupId ? this.commandOutputByItemId.get(`__last_group__:${groupId}`) : null;
    const outputId = (id && this.commandOutputByItemId.get(String(id)))
      || groupOutputId
      || (!groupId ? this.commandOutputByItemId.get('__last__') : null);
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
    if (this.outputHistory) {
      this.outputHistory.loadedTurnIds = new Set();
      this.outputHistory.hasMore = !!this.outputHistory.sessionId;
    }
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
