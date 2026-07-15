'use strict';

const { nowIso, randomId } = require('../shared/utils');
const { makeQueueItem, transitionQueueItem } = require('../queue');
const { mapApprovalPolicy, makeSandboxPolicy } = require('../codex/policies');

const FORCE_STEER_CONFIRM_MESSAGE = 'The active prompt may not be able to continue after interruption because rate limits are currently unavailable. The current queue item will be marked as interrupted, and the correction may remain pending until limits are available.';

function activeTurnNotSteerable(err) {
  return err?.code === 'activeTurnNotSteerable'
    || err?.data?.code === 'activeTurnNotSteerable'
    || /activeTurnNotSteerable|not steerable/i.test(err?.message || '');
}

function steerInput(text) {
  return [{ type: 'text', text }];
}

function makeSteerClientUserMessageId() {
  return `codex-queue-steer-${randomId(8)}`;
}

function steerClientIdFromItem(item) {
  return item?.clientId
    || item?.client_id
    || item?.clientUserMessageId
    || item?.client_user_message_id
    || null;
}

function steerActionDoneForRpc(action) {
  return action?.status === 'canceled'
    || action?.status === 'promoted'
    || action?.status === 'submitted';
}

function steerStatusLabel(status) {
  if (status === 'waiting') return 'waiting to send';
  if (status === 'accepted') return 'accepted by app-server';
  if (status === 'submitted') return 'submitted to turn';
  return status || 'accepted by app-server';
}

function steerNoteText(text, status = 'accepted', extra = {}) {
  const lines = ['[user-note]', text, `Status: ${steerStatusLabel(status)}`];
  if (extra.error) lines.push(`Error: ${extra.error}`);
  if (extra.action) lines.push(`Action: ${extra.action}`);
  return lines.join('\n');
}

function forceTurnStartParams(ctx, text) {
  const params = {
    threadId: ctx.app.sessionId,
    cwd: ctx.opts.projectDir,
    input: steerInput(text),
    approvalPolicy: mapApprovalPolicy(ctx.opts.approvalPolicy),
    sandboxPolicy: makeSandboxPolicy(ctx.opts),
  };

  if (ctx.opts.model) params.model = ctx.opts.model;
  if (ctx.opts.effort) params.effort = ctx.opts.effort;

  return params;
}

function limitsAvailable(ctx) {
  return ctx.rateLimits?.status === 'available';
}

function activeItemOrNull(ctx) {
  return ctx.currentItem ? ctx.currentItem() : null;
}

function promoteSteerUndoAction(ctx, actionId) {
  if (!actionId) return { ok: true, action: null };
  if (!Array.isArray(ctx.undoActions)) return { ok: false, message: 'Waiting steer is no longer available.' };
  const action = ctx.undoActions.find((candidate) => candidate.id === actionId);
  if (!action || action.type !== 'steer') return { ok: false, message: 'Waiting steer is no longer available.' };
  if (action.status !== 'waiting') {
    return {
      ok: false,
      message: action.status === 'accepted'
        ? 'Steer was already accepted by app-server and cannot be converted to /think!.'
        : 'Waiting steer is no longer available.',
    };
  }

  action.status = 'promoted';
  ctx.updateSteerNote?.(action, 'force requested', { text: action.text });
  ctx.forgetUndoAction?.(action);
  return { ok: true, action };
}

module.exports = {
  steerConfirmationMessage() {
    return FORCE_STEER_CONFIRM_MESSAGE;
  },

  appendSteerNote(text, status = 'accepted', extra = {}) {
    return this.appendOutput(steerNoteText(text, status, extra), 'user-note', false, this.currentOutputMeta({
      steer: {
        status,
        text,
        forceAvailable: Boolean(extra.forceAvailable),
        clientUserMessageId: extra.clientUserMessageId || null,
        acceptedAt: extra.acceptedAt || null,
        submittedAt: extra.submittedAt || null,
        canceledAt: extra.canceledAt || null,
        error: extra.error || null,
      },
    }));
  },

  updateSteerNote(actionOrOutputId, status, extra = {}) {
    const outputId = typeof actionOrOutputId === 'string' ? actionOrOutputId : actionOrOutputId?.outputId;
    const entry = this.output.find((candidate) => candidate.id === outputId);
    if (!entry) return null;

    const text = extra.text || entry.steer?.text || actionOrOutputId?.text || '';
    const canceledAt = extra.canceledAt || (status === 'canceled' ? nowIso() : entry.steer?.canceledAt || null);
    entry.text = steerNoteText(text, status, extra);
    entry.ts = nowIso();
    entry.steer = {
      ...(entry.steer || {}),
      status,
      text,
      forceAvailable: Boolean(extra.forceAvailable),
      clientUserMessageId: extra.clientUserMessageId || entry.steer?.clientUserMessageId || actionOrOutputId?.clientUserMessageId || null,
      acceptedAt: extra.acceptedAt || entry.steer?.acceptedAt || null,
      submittedAt: extra.submittedAt || entry.steer?.submittedAt || null,
      canceledAt,
      error: extra.error || null,
    };
    if (actionOrOutputId && typeof actionOrOutputId === 'object') actionOrOutputId.canceledAt = canceledAt;
    return entry;
  },

  async steerActivePrompt(text) {
    if (!this.app.sessionId || !this.turnCoordinator.canInterrupt) {
      return { ok: false, message: 'No active turn to steer.' };
    }

    const turnId = this.currentTurnId;
    const threadId = this.app.sessionId;
    const clientUserMessageId = makeSteerClientUserMessageId();
    const note = this.appendSteerNote(text, 'waiting', { clientUserMessageId });
    const action = this.recordSteerUndo ? this.recordSteerUndo({
      outputId: note?.id || null,
      turnId,
      threadId,
      text,
      clientUserMessageId,
    }) : null;
    this.broadcastAll();

    this.rpc.request('turn/steer', {
      threadId,
      expectedTurnId: turnId,
      clientUserMessageId,
      input: steerInput(text),
    }, 3000).then(() => {
      if (steerActionDoneForRpc(action)) return;
      const acceptedAt = nowIso();
      if (action) {
        action.status = 'accepted';
        action.acceptedAt = acceptedAt;
      }
      this.updateSteerNote(note?.id, 'accepted', { text, acceptedAt, clientUserMessageId });
      this.broadcastAll();
    }).catch((err) => {
      if (steerActionDoneForRpc(action)) return;
      if (activeTurnNotSteerable(err)) {
        if (action) {
          action.status = 'not steerable';
          this.forgetUndoAction?.(action);
        }
        this.updateSteerNote(note?.id, 'not steerable', { text, forceAvailable: true, action: 'Force send' });
        this.broadcastAll();
        return;
      }
      if (action) {
        action.status = 'failed';
        this.forgetUndoAction?.(action);
      }
      this.updateSteerNote(note?.id, 'failed', { text, error: err.message || String(err) });
      this.broadcastAll();
    });

    return { ok: true, clearComposer: true };
  },

  markSteerSubmittedFromUserMessage(item) {
    const clientUserMessageId = steerClientIdFromItem(item);
    if (!clientUserMessageId || !Array.isArray(this.undoActions)) return false;
    const action = this.undoActions.find((candidate) => (
      candidate?.type === 'steer'
      && candidate.clientUserMessageId === clientUserMessageId
      && (candidate.status === 'waiting' || candidate.status === 'accepted')
    ));
    if (!action) return false;

    const submittedAt = nowIso();
    action.status = 'submitted';
    action.submittedAt = submittedAt;
    this.updateSteerNote(action, 'submitted', {
      text: action.text,
      clientUserMessageId,
      acceptedAt: action.acceptedAt || null,
      submittedAt,
    });
    this.forgetUndoAction?.(action);
    return true;
  },

  async forceSteerActivePrompt(text, options = {}) {
    if (!this.app.sessionId || !this.turnCoordinator.canInterrupt) {
      return { ok: false, message: 'No active turn to interrupt.' };
    }

    if (!limitsAvailable(this) && !options.confirmed) {
      return {
        ok: false,
        needsConfirmation: true,
        confirmAction: 'force-steer',
        message: FORCE_STEER_CONFIRM_MESSAGE,
        text,
        promoteSteerActionId: options.promoteSteerActionId || null,
      };
    }

    const promoted = promoteSteerUndoAction(this, options.promoteSteerActionId);
    if (!promoted.ok) return { ok: false, message: promoted.message };

    const item = activeItemOrNull(this);
    const originalTurnId = this.currentTurnId;
    const group = this.outputGroupForId(this.currentOutputGroupId) || this.outputGroupForQueueItemId(item?.id);
    if (group) {
      this.currentOutputGroupId = group.id;
      this.addTurnToOutputGroup(group, originalTurnId);
    }
    const continueQueue = !this.currentManualSend || this.manualSendContinueQueue;
    const force = this.turnCoordinator.beginForceSteer({
      queueItemId: item?.id || null,
      originalTurnId,
      awaitingReplacementTurn: limitsAvailable(this),
      outputGroupId: group?.id || null,
      text,
      continueQueue,
      interruptedAt: nowIso(),
    });

    this.appendOutput('[steer] Interrupt requested', 'system');
    try {
      await this.rpc.request('turn/interrupt', { threadId: this.app.sessionId, turnId: originalTurnId }, 3000);
    } catch (err) {
      this.turnCoordinator.rollbackForceSteer({ removeInterrupt: true });
      this.appendOutput(`[error] Could not interrupt active turn: ${err.message || String(err)}`, 'error');
      this.broadcastAll();
      return { ok: false, message: `Could not interrupt active turn: ${err.message || String(err)}` };
    }

    if (!limitsAvailable(this)) {
      force.awaitingReplacementTurn = false;
      if (item) {
        transitionQueueItem(item, 'interrupted');
        item.finishedAt = nowIso();
        item.error = null;
      }
      const queued = makeQueueItem(text);
      this.queue.push(queued);
      await this.saveQueue();
      const record = originalTurnId ? this.intentionalInterrupts.get(originalTurnId) : null;
      if (record && !record.handled) {
        record.handled = true;
        this.appendOutput('[steer] Original turn interrupted', 'system');
      }
      this.appendOutput('[steer] Follow-up prompt queued until limits are available', 'system');
      this.turnCoordinator.resolveSynthetic('interrupted', { turnId: originalTurnId });
      this.broadcastAll();
      return { ok: true, clearComposer: true, item: queued };
    }

    this.appendOutput('[steer] Sending follow-up prompt', 'system');
    force.awaitingReplacementTurn = true;
    let result;
    try {
      result = await this.rpc.request('turn/start', forceTurnStartParams(this, text));
    } catch (err) {
      const message = `Follow-up turn/start failed after the original turn was interrupted: ${err.message || String(err)}`;
      if (item) {
        transitionQueueItem(item, 'failed');
        item.finishedAt = nowIso();
        item.error = message;
      }
      await this.saveQueue().catch((saveErr) => this.reportPersistenceFailure('saving failed force steer', saveErr));
      this.turnCoordinator.rollbackForceSteer({ removeInterrupt: false });
      const operationError = new Error(message);
      operationError.preserveItemStatus = true;
      this.turnCoordinator.fail(operationError);
      this.pause('Auto-send paused because the force-steer replacement could not be started. Review the error before resuming.');
      this.appendOutput(`[error] ${message}`, 'error');
      this.broadcastAll();
      return { ok: false, message };
    }

    const turn = result?.turn || result || {};
    const replacementTurnId = turn.id || turn.turnId || this.currentTurnId;
    if (replacementTurnId && replacementTurnId !== originalTurnId) {
      this.turnCoordinator.acceptTurn(replacementTurnId, { replacement: true });
      this.debug.lastTurnId = replacementTurnId;
      if (force.outputGroupId) this.useOutputGroup(force.outputGroupId);
      if (item) await this.recordQueueItemTurn(item, replacementTurnId);
      this.updateCurrentOutputGroup({ turnId: replacementTurnId, status: 'active' });
    }
    this.appendSteerNote(text, 'force sent');
    this.appendOutput('[steer] Follow-up prompt sent', 'system');
    this.broadcastAll();
    return { ok: true, clearComposer: true };
  },
};
