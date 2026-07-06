'use strict';

const { nowIso } = require('../shared/utils');
const { makeQueueItem } = require('../queue');
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

function steerStatusLabel(status) {
  if (status === 'waiting') return 'waiting to send';
  return status || 'sent';
}

function steerNoteText(text, status = 'sent', extra = {}) {
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
      message: action.status === 'sent'
        ? 'Steer was already sent and cannot be converted to /think!.'
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

  appendSteerNote(text, status = 'sent', extra = {}) {
    return this.appendOutput(steerNoteText(text, status, extra), 'user-note', false, this.currentOutputMeta({
      steer: {
        status,
        text,
        forceAvailable: Boolean(extra.forceAvailable),
        sentAt: extra.sentAt || null,
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
      sentAt: extra.sentAt || entry.steer?.sentAt || null,
      canceledAt,
      error: extra.error || null,
    };
    if (actionOrOutputId && typeof actionOrOutputId === 'object') actionOrOutputId.canceledAt = canceledAt;
    return entry;
  },

  async steerActivePrompt(text) {
    if (!this.currentTurnId || !this.app.sessionId) {
      return { ok: false, message: 'No active turn to steer.' };
    }

    const turnId = this.currentTurnId;
    const threadId = this.app.sessionId;
    const note = this.appendSteerNote(text, 'waiting');
    const action = this.recordSteerUndo ? this.recordSteerUndo({
      outputId: note?.id || null,
      turnId,
      threadId,
      text,
    }) : null;
    this.broadcastAll();

    this.rpc.request('turn/steer', {
      threadId,
      expectedTurnId: turnId,
      input: steerInput(text),
    }, 3000).then(() => {
      if (action?.status === 'canceled' || action?.status === 'promoted') return;
      const sentAt = nowIso();
      if (action) {
        action.status = 'sent';
        action.sentAt = sentAt;
      }
      this.updateSteerNote(note?.id, 'sent', { text, sentAt });
      this.broadcastAll();
    }).catch((err) => {
      if (action?.status === 'canceled' || action?.status === 'promoted') return;
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

  async forceSteerActivePrompt(text, options = {}) {
    if (!this.currentTurnId || !this.app.sessionId) {
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
    const previousForceSteer = this.forceSteer && (
      this.forceSteer.queueItemId === item?.id
      || this.forceSteer.outputGroupId === group?.id
    ) ? this.forceSteer : null;
    const interruptedTurnIds = [
      ...(previousForceSteer?.interruptedTurnIds || []),
      originalTurnId,
    ].filter(Boolean).filter((turnId, index, ids) => ids.indexOf(turnId) === index);
    if (originalTurnId) {
      this.intentionalInterrupts.set(originalTurnId, {
        queueItemId: item?.id || null,
        outputGroupId: group?.id || null,
        createdAt: nowIso(),
        handled: false,
      });
    }
    this.forceSteer = {
      queueItemId: item?.id || null,
      originalTurnId,
      replacementTurnId: null,
      interruptedTurnIds,
      awaitingReplacementTurn: limitsAvailable(this),
      outputGroupId: group?.id || null,
      text,
      continueQueue,
      interruptedAt: nowIso(),
    };

    this.appendOutput('[steer] Interrupt requested', 'system');
    await this.rpc.request('turn/interrupt', { threadId: this.app.sessionId, turnId: originalTurnId }, 3000);

    if (!limitsAvailable(this)) {
      this.forceSteer.awaitingReplacementTurn = false;
      if (item) {
        item.status = 'interrupted';
        item.finishedAt = nowIso();
        item.error = null;
      }
      const queued = makeQueueItem(text);
      this.queue.push(queued);
      await this.saveQueue();
      this.appendOutput('[steer] Follow-up prompt queued until limits are available', 'system');
      if (this.currentTurnResolve) this.currentTurnResolve();
      this.broadcastAll();
      return { ok: true, clearComposer: true, item: queued };
    }

    this.appendOutput('[steer] Sending follow-up prompt', 'system');
    this.forceSteer.awaitingReplacementTurn = true;
    const result = await this.rpc.request('turn/start', forceTurnStartParams(this, text));
    const turn = result?.turn || result || {};
    const replacementTurnId = turn.id || turn.turnId || null;
    if (replacementTurnId) {
      this.currentTurnId = replacementTurnId;
      this.debug.lastTurnId = replacementTurnId;
      this.forceSteer.replacementTurnId = replacementTurnId;
      this.forceSteer.awaitingReplacementTurn = false;
      if (this.forceSteer.outputGroupId) this.useOutputGroup(this.forceSteer.outputGroupId);
      if (item) await this.recordQueueItemTurn(item, replacementTurnId);
      this.updateCurrentOutputGroup({ turnId: replacementTurnId, status: 'active' });
    }
    this.appendSteerNote(text, 'force sent');
    this.appendOutput('[steer] Follow-up prompt sent', 'system');
    this.broadcastAll();
    return { ok: true, clearComposer: true };
  },
};
