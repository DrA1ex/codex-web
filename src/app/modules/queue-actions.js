'use strict';

const {
  isPendingLikeStatus,
  makeQueueItem,
  normalizeQueueOrder,
  movePendingToNext: movePendingToNextItem,
  undoLastPending,
  clearPending: clearPendingItems,
  clearCompleted: clearCompletedItems,
  updateQueueItemData,
  removeQueueItem: removeQueueItemData,
  reorderPendingItem,
  parseQueuedCommand,
} = require('../../queue');
const { commandByName, commandHelpPayload } = require('../commands');
const { parseComposerCommand } = require('../command-parser');

const COMPLETED_ARCHIVE_INITIAL_COUNT = 10;
const COMPLETED_ARCHIVE_PAGE_SIZE = 50;

function queueItemTime(item) {
  const time = new Date(item?.finishedAt || item?.createdAt || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

function completedQueueEntries(queue) {
  return queue
    .map((item, index) => ({ item, index, time: queueItemTime(item) }))
    .filter((entry) => entry.item.status === 'completed')
    .sort((left, right) => left.time - right.time || left.index - right.index);
}


function commandRaw(parsed, fallback) {
  return parsed?.raw || fallback || parsed?.command || '';
}

function commandFeedback(ctx, payload) {
  if (typeof ctx.appendCommandFeedback === 'function') return ctx.appendCommandFeedback(payload);
  return ctx.appendOutput(`[${payload.title || 'Command'}] ${payload.raw || ''}\n${payload.message || ''}`, payload.status === 'error' ? 'error' : 'system');
}

function commandErrorResponse(ctx, parsed, raw) {
  const meta = commandByName(parsed?.command);
  commandFeedback(ctx, {
    status: 'error',
    title: 'Command error',
    raw: commandRaw(parsed, raw),
    message: commandHelpMessage(meta, parsed?.message || 'Invalid command.'),
    usage: parsed?.usage || '',
  });
  ctx.broadcastAll();
  return { ok: false, clearComposer: false, commandError: true };
}

function commandSuccess(ctx, parsed, message, status = 'success') {
  commandFeedback(ctx, {
    status,
    title: status === 'error' ? 'Command error' : 'Command',
    raw: commandRaw(parsed),
    message,
  });
}

function commandHelpMessage(meta, lead) {
  const lines = [];
  if (lead) lines.push(lead);
  if (meta?.details) {
    if (lines.length) lines.push('');
    lines.push(meta.details);
  }
  if (meta?.options?.length) {
    if (lines.length) lines.push('');
    lines.push(`Options: ${meta.options.join(', ')}`);
  }
  return lines.join('\n');
}

function commandUsage(meta) {
  if (!meta) return '';
  return `${meta.name}${meta.argumentHint ? ` ${meta.argumentHint}` : ''}`;
}

function commandInfoResponse(ctx, parsed, message) {
  const meta = commandByName(parsed?.command);
  commandFeedback(ctx, {
    status: 'info',
    title: 'Command',
    raw: commandRaw(parsed),
    message,
    usage: commandUsage(meta),
  });
  ctx.broadcastAll();
  return { ok: true, clearComposer: false, commandInfo: true };
}

function queuePreview(item) {
  const preview = String(item?.preview || item?.text || '').replace(/\s+/g, ' ').trim();
  if (!preview) return '(empty prompt)';
  return preview.length > 80 ? `${preview.slice(0, 77)}...` : preview;
}

function pendingListText(queue) {
  const pending = queue.filter((item) => isPendingLikeStatus(item.status));
  if (!pending.length) return 'No pending items.';

  const [next, ...rest] = pending;
  const lines = [];
  if (next) {
    lines.push('Next:');
    lines.push(`#${next.id} — ${queuePreview(next)}`);
  }
  if (rest.length) {
    lines.push('');
    lines.push('Pending:');
    for (const item of rest) lines.push(`#${item.id} — ${queuePreview(item)}`);
  }
  return lines.join('\n');
}

function alreadyNext(queue, item, currentItemId) {
  const ordered = normalizeQueueOrder(queue);
  const from = ordered.findIndex((candidate) => candidate.id === item.id);
  if (from < 0) return false;
  const runningIndex = ordered.findIndex((candidate) => (
    candidate.id === currentItemId || candidate.status === 'sending' || candidate.status === 'sent'
  ));
  if (runningIndex >= 0) return from === runningIndex + 1;

  const firstPendingIndex = ordered.findIndex((candidate) => isPendingLikeStatus(candidate.status));
  return from === firstPendingIndex;
}

function completedQueuePage(queue, before = null, limit = COMPLETED_ARCHIVE_INITIAL_COUNT) {
  const entries = completedQueueEntries(queue);
  if (!entries.length) {
    return { items: [], hasMore: false, cursor: null, totalCompleted: 0 };
  }

  let end = entries.length;
  if (before?.id) {
    const beforeIndex = entries.findIndex((entry) => entry.item.id === before.id);
    if (beforeIndex >= 0) {
      end = beforeIndex;
    } else {
      const beforeTime = Date.parse(before.finishedAt || before.createdAt || '');
      if (!Number.isFinite(beforeTime)) end = 0;
      else {
        const timeIndex = entries.findIndex((entry) => entry.time >= beforeTime);
        end = timeIndex >= 0 ? timeIndex : entries.length;
      }
    }
  }

  const pageLimit = Math.max(1, Math.min(200, Number(limit) || COMPLETED_ARCHIVE_INITIAL_COUNT));
  const start = Math.max(0, end - pageLimit);
  const items = entries.slice(start, end).map((entry) => entry.item);

  return {
    items,
    hasMore: start > 0,
    cursor: items[0] ? {
      id: items[0].id,
      finishedAt: items[0].finishedAt || null,
    } : null,
    totalCompleted: entries.length,
  };
}

module.exports = {
  async addPrompt(text) {
    const normalized = String(text || '').replace(/\r\n/g, '\n');
    const trimmed = normalized.trim();
    if (!trimmed) return { ok: false, message: 'Prompt is empty' };

    const parsed = parseComposerCommand(trimmed);
    if (parsed) {
      if (!parsed.ok) return commandErrorResponse(this, parsed, trimmed);
      if (parsed.execution !== 'queued') return await this.executeCommand(Object.keys(parsed.args || {}).length ? parsed : parsed.command);
    }

    const queuedCommand = parseQueuedCommand(trimmed);
    const item = makeQueueItem(normalized);
    this.queue.push(item);
    await this.saveQueue();
    this.app.state = this.app.state === 'done' ? 'watching' : this.app.state;
    this.appendOutput(queuedCommand ? `[queue] added #${item.id} · command ${queuedCommand}` : `[queue] added #${item.id} · ${item.lineCount} lines`, 'system');
    this.broadcastAll();
    this.schedulePump(200);
    return { ok: true, clearComposer: true, item };
  },

  canScheduleQueue() {
    const hasPending = this.queue.some((i) => isPendingLikeStatus(i.status));
    const hasSchedule = !!this.app.scheduledRunAt;
    return !!this.app.sessionId && (hasPending || hasSchedule) && !this.currentItemId && !this.currentTurnId && !this.approval && (this.app.state === 'paused' || this.app.state === 'waiting-limits' || this.app.state === 'scheduled');
  },

  async setQueueSchedule(value) {
    if (!this.canScheduleQueue()) throw new Error('Queue can be scheduled only when it is paused, scheduled, or waiting for limits.');
    if (!this.queue.some((i) => isPendingLikeStatus(i.status))) throw new Error('Queue has no pending prompts to schedule.');
    const ts = Date.parse(String(value || ''));
    if (!Number.isFinite(ts)) throw new Error('Invalid schedule time.');
    if (ts <= Date.now()) throw new Error('Schedule time must be in the future.');
    this.app.scheduledRunAt = new Date(ts).toISOString();
    this.app.state = 'scheduled';
    this.app.message = `Queue scheduled for ${new Date(ts).toLocaleString()}`;
    await this.saveState();
    this.appendOutput(`[queue] scheduled ${this.app.scheduledRunAt}`, 'system');
    this.broadcastAll();
    this.schedulePump(Math.min(Math.max(1000, ts - Date.now()), this.opts.watchInterval * 1000));
    return { ok: true, scheduledRunAt: this.app.scheduledRunAt };
  },

  async resetQueueSchedule() {
    this.clearPumpTimer();
    this.app.scheduledRunAt = null;
    if (this.app.state === 'scheduled') this.app.state = 'paused';
    this.app.message = 'Queue schedule reset';
    await this.saveState();
    this.appendOutput('[queue] schedule reset', 'system');
    this.broadcastAll();
    return { ok: true };
  },

  async cancelQueueRun() {
    this.clearPumpTimer();
    this.countdownCancel = true;
    this.app.scheduledRunAt = null;
    this.app.state = 'paused';
    this.app.message = 'Queue cancelled';
    await this.saveState();
    this.appendOutput('[queue] cancelled', 'system');
    this.broadcastAll();
    return { ok: true };
  },

  async executeCommand(commandOrParsed) {
    const parsed = typeof commandOrParsed === 'string'
      ? parseComposerCommand(commandOrParsed)
      : commandOrParsed;

    if (!parsed) return { ok: false, message: 'Not a command.' };
    if (!parsed.ok) return commandErrorResponse(this, parsed, commandOrParsed);

    try {
      switch (parsed.command) {
        case '/pending': return await this.executePendingCommand(parsed);
        case '/send': return await this.executeSendCommand(parsed);
        case '/next': return await this.executeNextCommand(parsed);
        case '/schedule': return await this.executeScheduleCommand(parsed);
        case '/sandbox': return await this.executeSandboxCommand(parsed);
        case '/approval': return await this.executeApprovalCommand(parsed);
        case '/stop': return await this.executeStopCommand(parsed);
        case '/think': return await this.steerActivePrompt(parsed.args.text);
        case '/think!': return await this.forceSteerActivePrompt(parsed.args.text);
        case '/undo': return await this.undoLast();
        case '/clear': await this.clearPending(); return { ok: true, clearComposer: true };
        case '/pause': this.pause(); return { ok: true, clearComposer: true };
        case '/resume': this.resume(); return { ok: true, clearComposer: true };
        case '/quit': await this.shutdown('quit command'); return { ok: true, clearComposer: true };
        case '/help': return { ok: true, clearComposer: true, help: { commands: commandHelpPayload() } };
        case '/approve': await this.respondApproval('accept'); return { ok: true, clearComposer: true };
        case '/approve-session': await this.respondApproval('accept-for-session'); return { ok: true, clearComposer: true };
        case '/decline': await this.respondApproval('decline'); return { ok: true, clearComposer: true };
        case '/cancel': await this.respondApproval('cancel'); return { ok: true, clearComposer: true };
        default:
          return commandErrorResponse(this, { ...parsed, message: `Unknown command: ${parsed.command}`, usage: 'Type /help to see available commands.' });
      }
    } catch (error) {
      const meta = commandByName(parsed?.command);
      commandFeedback(this, {
        status: 'error',
        title: 'Command error',
        raw: commandRaw(parsed),
        message: commandHelpMessage(meta, error.message || String(error)),
        usage: commandUsage(meta),
      });
      this.broadcastAll();
      return { ok: false, clearComposer: false, commandError: true };
    }
  },

  async executePendingCommand(parsed) {
    commandSuccess(this, parsed, pendingListText(this.queue), 'info');
    this.broadcastAll();
    return { ok: true, clearComposer: true };
  },

  async executeSendCommand(parsed) {
    const id = parsed.args.id;
    const item = this.queue.find((candidate) => candidate.id === id);
    if (!item) return commandErrorResponse(this, { ...parsed, message: `Queue item not found: ${id}` });
    if (!isPendingLikeStatus(item.status)) return commandErrorResponse(this, { ...parsed, message: 'Only pending queue items can be sent.' });

    const result = await this.sendItemNow(item);
    commandSuccess(this, parsed, `Send requested for #${id}.`);
    this.broadcastAll();
    return { ok: true, clearComposer: true, item: result?.item || item };
  },

  async executeNextCommand(parsed) {
    const id = parsed.args.id;
    const item = this.queue.find((candidate) => candidate.id === id);
    if (!item) return commandErrorResponse(this, { ...parsed, message: `Queue item not found: ${id}` });
    if (!isPendingLikeStatus(item.status)) return commandErrorResponse(this, { ...parsed, message: 'Only pending queue items can be moved next.' });
    if (alreadyNext(this.queue, item, this.currentItemId)) return commandErrorResponse(this, { ...parsed, message: `#${id} is already next.` });

    const result = movePendingToNextItem(this.queue, item, this.currentItemId);
    this.queue = result.queue;
    await this.saveQueue();
    commandSuccess(this, parsed, `Moved #${id} next.`);
    this.broadcastAll();
    return { ok: true, clearComposer: true, item: result.item };
  },

  async executeStopCommand(parsed) {
    const result = await this.interruptCurrentTurn();
    if (!result.ok) {
      commandSuccess(this, parsed, 'Nothing is running.', 'info');
      this.broadcastAll();
      return { ok: true, clearComposer: true };
    }
    commandSuccess(this, parsed, 'Interrupt requested.');
    this.broadcastAll();
    return { ok: true, clearComposer: true };
  },

  async executeScheduleCommand(parsed) {
    const schedule = parsed.args.schedule;
    if (schedule.action === 'open') {
      if (!this.canScheduleQueue()) {
        return commandErrorResponse(this, {
          ...parsed,
          message: 'Queue can be scheduled only when it is paused, scheduled, or waiting for limits.',
        });
      }
      if (!this.queue.some((i) => isPendingLikeStatus(i.status))) {
        return commandErrorResponse(this, {
          ...parsed,
          message: 'Queue has no pending prompts to schedule.',
        });
      }
      return { ok: true, clearComposer: true, openScheduleModal: true };
    }
    if (schedule.action === 'reset') {
      await this.resetQueueSchedule();
      commandSuccess(this, parsed, 'Schedule cleared.');
      this.broadcastAll();
      return { ok: true, clearComposer: true };
    }
    await this.setQueueSchedule(schedule.scheduledRunAt);
    commandSuccess(this, parsed, `Scheduled for ${new Date(schedule.scheduledRunAt).toLocaleString()}.`);
    this.broadcastAll();
    return { ok: true, clearComposer: true, scheduledRunAt: schedule.scheduledRunAt };
  },

  async executeSandboxCommand(parsed) {
    const value = parsed.args.value;
    const meta = commandByName('/sandbox');
    if (!value) {
      return commandInfoResponse(
        this,
        parsed,
        commandHelpMessage(meta, `Current sandbox: ${this.opts.sandbox || this.app.sandbox || 'unknown'}`),
      );
    }

    await this.setSandbox(value);
    commandSuccess(this, parsed, `Sandbox set to ${value}.`);
    this.broadcastAll();
    return { ok: true, clearComposer: true, sandbox: value };
  },

  async executeApprovalCommand(parsed) {
    const value = parsed.args.value;
    const meta = commandByName('/approval');
    if (!value) {
      return commandInfoResponse(
        this,
        parsed,
        commandHelpMessage(meta, `Current approval policy: ${this.opts.approvalPolicy || this.app.approvalPolicy || 'unknown'}`),
      );
    }

    await this.setApprovalPolicy(value);
    commandSuccess(this, parsed, `Approval policy set to ${value}.`);
    this.broadcastAll();
    return { ok: true, clearComposer: true, approvalPolicy: value };
  },

  async undoLast() {
    const result = undoLastPending(this.queue);
    this.queue = result.queue;
    if (!result.item) return { ok: false, message: 'No pending prompt to undo' };
    await this.saveQueue();
    this.appendOutput(`[queue] undo #${result.item.id}`, 'system');
    this.broadcastAll();
    return { ok: true, composerText: result.item.text };
  },

  async clearPending() {
    const result = clearPendingItems(this.queue);
    this.queue = result.queue;
    await this.saveQueue();
    this.appendOutput(`[queue] cleared ${result.removed} pending prompt(s)`, 'system');
    this.broadcastAll();
  },

  async clearCompleted() {
    const result = clearCompletedItems(this.queue);
    this.queue = result.queue;
    await this.saveQueue();
    this.appendOutput(`[queue] cleared ${result.removed} completed prompt(s)`, 'system');
    this.broadcastAll();
  },

  completedArchiveSnapshot() {
    return completedQueuePage(this.queue, null, COMPLETED_ARCHIVE_INITIAL_COUNT);
  },

  async loadCompletedArchivePage(body = {}) {
    const before = body.before || null;
    return completedQueuePage(this.queue, before, body.limit || COMPLETED_ARCHIVE_PAGE_SIZE);
  },

  async updateQueueItem(body) {
    if (body.action === 'sendNow') {
      const item = this.queue.find((i) => i.id === body.id);
      if (!item) throw new Error('Queue item not found');
      return await this.sendItemNow(item);
    }
    const result = updateQueueItemData(this.queue, body);
    this.queue = result.queue;
    await this.saveQueue();
    this.broadcastAll();
    this.schedulePump(200);
    return { ok: true, item: result.item };
  },

  async removeQueueItem(id) {
    const result = removeQueueItemData(this.queue, id, this.currentItemId);
    this.queue = result.queue;
    await this.saveQueue();
    this.broadcastAll();
  },

  async reorderQueueItem(id, body = {}) {
    const result = reorderPendingItem(this.queue, id, body);
    this.queue = result.queue;
    await this.saveQueue();
    this.broadcastAll();
  }
};
