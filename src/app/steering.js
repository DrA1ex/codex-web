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

module.exports = {
  steerConfirmationMessage() {
    return FORCE_STEER_CONFIRM_MESSAGE;
  },

  appendSteerNote(text, status = 'sent', extra = {}) {
    const lines = ['[user-note]', text];
    if (status !== 'sent') lines.push(`Status: ${status}`);
    if (extra.action) lines.push(`Action: ${extra.action}`);
    return this.appendOutput(lines.join('\n'), 'user-note', false, this.currentOutputMeta({
      steer: {
        status,
        text,
        forceAvailable: Boolean(extra.forceAvailable),
      },
    }));
  },

  async steerActivePrompt(text) {
    if (!this.currentTurnId || !this.app.sessionId) {
      return { ok: false, message: 'No active turn to steer.' };
    }

    const turnId = this.currentTurnId;
    try {
      await this.rpc.request('turn/steer', {
        threadId: this.app.sessionId,
        expectedTurnId: turnId,
        input: steerInput(text),
      }, 3000);
      this.appendSteerNote(text);
      this.broadcastAll();
      return { ok: true, clearComposer: true };
    } catch (err) {
      if (activeTurnNotSteerable(err)) {
        this.appendSteerNote(text, 'not steerable', { forceAvailable: true, action: 'Force send' });
        this.broadcastAll();
        return {
          ok: false,
          message: 'The active turn is not steerable right now.',
          steerForceAvailable: true,
          text,
        };
      }
      return { ok: false, message: err.message || String(err) };
    }
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
      };
    }

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
