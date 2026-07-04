'use strict';

const { normalizeRateLimits } = require('../../codex/rate-limits');
const {
  isApprovalMethod,
  isCompactionMethod,
  extractDeltaText,
  extractItemText,
  formatItemStarted,
  outputTypeForItem,
  formatItemCompleted,
} = require('../../codex/output-format');
const {
  mapApprovalResponse,
  humanApprovalResponse,
} = require('../../codex/policies');
const { nowIso, safeJson, truncate, asArray, maskSecrets } = require('../../shared/utils');

function forceSteerInterruptedRecord(ctx, turnId, method, status, errMessage) {
  if (turnId && ctx.intentionalInterrupts?.has(turnId)) {
    return { turnId, record: ctx.intentionalInterrupts.get(turnId) };
  }

  if (
    !turnId
    && method === 'turn/failed'
    && ctx.forceSteer
    && (!ctx.forceSteer.replacementTurnId || /interrupt|cancel/i.test(errMessage || status || ''))
  ) {
    return {
      turnId: null,
      record: {
        queueItemId: ctx.forceSteer.queueItemId || null,
        outputGroupId: ctx.forceSteer.outputGroupId || null,
        handled: false,
      },
    };
  }

  return null;
}

function markOutputGroupActive(ctx, groupId) {
  const group = groupId ? ctx.useOutputGroup(groupId) : null;
  if (!group) return null;
  group.status = 'active';
  group.finishedAt = null;
  group.summary = 'Running...';
  return group;
}

module.exports = {
  handleNotification(method, params) {
    this.eventLog('debug', `notify ${method} ${safeJson(maskSecrets(params)).slice(0, 1000)}`);
    if (method === 'account/rateLimits/updated') {
      const previousStatus = this.rateLimits.status;
      this.rateLimits = normalizeRateLimits(params);
      this.debug.lastRateLimitPayload = params;
      this.reportRateLimitStatus(previousStatus, 'notification');
      this.broadcast('rateLimits', this.rateLimits);
      this.broadcastAll();
      return;
    }
    if (method === 'serverRequest/resolved') {
      if (this.approval && (!params.requestId || params.requestId === this.approval.requestId)) {
        this.approval = null;
        this.clearApprovalTimeout();
        this.broadcast('approval', null);
        if (this.app.state === 'approval-required') this.resume();
      }
      return;
    }
    if (method === 'error') {
      const message = params?.error?.message || params?.message || safeJson(params);
      this.appendOutput(`[error] ${message}`, 'error');
      return;
    }
    if (method === 'thread/tokenUsage/updated') {
      this.handleTokenUsageUpdated(params);
      return;
    }
    if (method === 'thread/compacted') {
      if (!params?.threadId || params.threadId === this.app.sessionId) {
        this.updateContextTokenCountFromCompaction(params);
        this.appendOutput('[compact] completed', 'system');
        if (this.currentQueueCommand === '/compact' && this.currentQueueCommandResolve) {
          this.currentQueueCommandResolve(params || {});
        }
      }
      return;
    }
    if (method === 'turn/started') {
      const turn = params.turn || params;
      this.updateContextTokenCount(params);
      const turnId = turn.id || turn.turnId || this.currentTurnId;
      const isForceSteerReplacement = !!(
        this.forceSteer?.outputGroupId
        && turnId
        && turnId !== this.forceSteer.originalTurnId
        && !(this.forceSteer.interruptedTurnIds || []).includes(turnId)
        && (
          turnId === this.forceSteer.replacementTurnId
          || (!this.forceSteer.replacementTurnId && this.forceSteer.awaitingReplacementTurn)
        )
      );
      if (isForceSteerReplacement) {
        markOutputGroupActive(this, this.forceSteer.outputGroupId);
        if (!this.forceSteer.replacementTurnId) this.forceSteer.replacementTurnId = turnId;
        this.forceSteer.awaitingReplacementTurn = false;
      } else {
        const group = this.outputGroupForTurnId(turnId);
        if (group) this.useOutputGroup(group.id);
      }
      this.currentTurnId = turnId;
      this.updateCurrentOutputGroup({ turnId: this.currentTurnId || null, status: 'active' });
      this.debug.lastTurnId = this.currentTurnId;
      this.turnStarted = true;
      const item = this.currentItem();
      if (item) {
        item.status = 'sent';
        this.recordQueueItemTurn(item, this.currentTurnId).catch(() => {});
        this.saveQueue().catch(() => {});
      }
      this.app.state = 'streaming';
      this.appendOutput('[turn] started', 'turn');
      this.broadcastAll();
      return;
    }
    if (method === 'turn/completed' || method === 'turn/failed') {
      const turn = params.turn || params;
      this.updateContextTokenCount(params);
      const eventTurnId = turn.id || turn.turnId || params.turnId || null;
      const status = turn.status || (method === 'turn/failed' ? 'failed' : 'completed');
      const errMessage = turn?.error?.message || params?.error?.message || null;
      const interrupted = forceSteerInterruptedRecord(this, eventTurnId, method, status, errMessage);
      if (interrupted) {
        markOutputGroupActive(this, interrupted.record.outputGroupId || this.forceSteer?.outputGroupId);
        if (!interrupted.record.handled) {
          this.appendOutput('[steer] Original turn interrupted', 'system');
          interrupted.record.handled = true;
          if (interrupted.turnId && this.intentionalInterrupts?.has(interrupted.turnId)) {
            this.intentionalInterrupts.set(interrupted.turnId, interrupted.record);
          }
        }
        if (this.forceSteer && !this.forceSteer.replacementTurnId && !this.forceSteer.awaitingReplacementTurn) {
          this.forceSteer = null;
        }
        this.broadcastAll();
        return;
      }
      const group = this.outputGroupForTurnId(eventTurnId);
      if (group) this.useOutputGroup(group.id);
      this.turnCompletionSeen = true;
      this.turnCompletionStatus = status;
      const item = this.currentItem();
      if (item) {
        item.finishedAt = nowIso();
        item.status = status === 'completed' ? 'completed' : 'failed';
        item.error = errMessage;
        this.saveQueue().catch(() => {});
      }
      this.finishActiveOutputBlocks();
      this.appendOutput(status === 'completed' ? '[turn] completed' : `[turn] ${status}${errMessage ? ': ' + errMessage : ''}`, status === 'completed' ? 'turn' : 'error');
      this.finishCurrentOutputGroup(status === 'completed' ? 'completed' : 'failed', errMessage);
      this.tryReadSession().then(() => this.broadcastAll()).catch((err) => this.debugLog('refresh session title failed', err.message));
      if (this.currentTurnResolve) this.currentTurnResolve();
      if (method === 'turn/completed' && this.currentQueueCommand === '/compact' && this.currentQueueCommandResolve) {
        this.currentQueueCommandResolve(params || {});
      }
      if (this.forceSteer?.replacementTurnId && eventTurnId === this.forceSteer.replacementTurnId) {
        this.forceSteer = null;
      }
      if (status !== 'completed') this.pause('Auto-send paused after turn failure. Type /resume after reviewing the error.');
      return;
    }
    if (method === 'item/started') {
      const item = params.item || params;
      if (item.type === 'commandExecution') {
        this.appendCommandOutput(item);
        return;
      }
      const label = formatItemStarted(item);
      if (label) {
        const outputItem = this.appendOutput(label, outputTypeForItem(item));
      }
      return;
    }
    if (method === 'item/completed') {
      const item = params.item || params;
      if (item.type === 'commandExecution') {
        this.updateCommandOutput(item);
        return;
      }
      if (item.type === 'agentMessage') {
        this.recordOutputGroupSummary(extractItemText(item), 'agentMessage');
      }
      const label = formatItemCompleted(item);
      if (label) this.appendOutput(label, item?.status === 'failed' ? 'error' : 'item');
      return;
    }
    if (method.includes('/delta') || method.includes('Delta')) {
      const text = extractDeltaText(method, params);
      if (text && method.includes('commandExecution') && this.appendCommandOutputText(params.item || params, text)) return;
      const type = isCompactionMethod(method) ? 'context-delta' : (method.includes('commandExecution') || method.includes('tool') ? 'tool-delta' : (/reasoning/i.test(method) ? 'reasoning-delta' : 'delta'));
      if (text && /summary/i.test(method)) this.recordOutputGroupSummary(text, 'summaryDelta', true);
      if (text) this.appendOutput(text, type, true);
      return;
    }
    if (method === 'turn/plan/updated') {
      const plan = asArray(params.plan).map((p) => `${p.status || '-'} ${p.step || ''}`).join('\n');
      if (plan) this.appendOutput('[plan]\n' + plan, 'plan');
      return;
    }
    if (method === 'turn/diff/updated' && params.diff) {
      const diff = typeof params.diff === 'string' ? params.diff : (params.diff.unified || params.diff.text || safeJson(params.diff));
      this.updateDiffOutput(diff || '[diff updated]');
      return;
    }
    if (this.opts.debug) this.appendOutput(`[event] ${method} ${truncate(safeJson(params), 500)}`, 'event');
  },

  currentItem() {
    if (!this.currentItemId) return null;
    return this.queue.find((i) => i.id === this.currentItemId) || null;
  },

  async handleServerRequest(msg) {
    const method = msg.method;
    const params = msg.params || {};
    this.eventLog('info', `server request ${method}`);
    if (isApprovalMethod(method)) {
      const configured = mapApprovalResponse(this.opts.approvalResponse);
      if (configured !== 'manual') {
        const result = configured;
        this.appendOutput(`[approval] ${method}: ${humanApprovalResponse(configured)}`, 'system');
        this.rpc.respond(msg.id, result);
        return;
      }
      this.approval = {
        rpcId: msg.id,
        requestId: params.requestId || params.itemId || String(msg.id),
        method,
        params,
        createdAt: nowIso(),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      };
      this.app.state = 'approval-required';
      this.app.message = 'Approval required';
      this.appendOutput('[approval] required. Use UI buttons or /approve, /approve-session, /decline, /cancel.', 'system');
      this.scheduleApprovalTimeout(this.approval.requestId);
      this.broadcast('approval', this.approval);
      this.broadcastAll();
      return;
    }
    if (method === 'currentTime/read') {
      this.rpc.respond(msg.id, { currentTimeAt: Math.floor(Date.now() / 1000) });
      return;
    }
    if (method === 'item/tool/requestUserInput' || method === 'mcpServer/elicitation/request') {
      this.rpc.respond(msg.id, { action: 'decline', content: null });
      return;
    }
    this.rpc.respond(msg.id, { code: -32601, message: `Unsupported server request: ${method}` }, true);
  },

  async respondApproval(decision) {
    if (!this.approval) throw new Error('No pending approval request');
    this.clearApprovalTimeout();
    const mapped = mapApprovalResponse(decision);
    const id = this.approval.rpcId;
    this.rpc.respond(id, mapped);
    this.appendOutput(`[approval] ${humanApprovalResponse(mapped)}`, 'system');
    this.approval = null;
    this.broadcast('approval', null);
    if (this.app.state === 'approval-required') this.resume();
  },

  scheduleApprovalTimeout(requestId) {
    this.clearApprovalTimeout();
    this.approvalTimer = setTimeout(() => {
      this.autoRejectApproval(requestId).catch((err) => this.setError(err.message));
    }, 15 * 60 * 1000);
    this.approvalTimer.unref();
  },

  clearApprovalTimeout() {
    if (this.approvalTimer) clearTimeout(this.approvalTimer);
    this.approvalTimer = null;
  },

  async autoRejectApproval(requestId) {
    if (!this.approval || this.approval.requestId !== requestId) return;
    const id = this.approval.rpcId;
    this.rpc.respond(id, mapApprovalResponse('decline'));
    this.appendOutput('[approval] auto-declined after 15 minutes', 'system');
    this.approval = null;
    this.clearApprovalTimeout();
    this.broadcast('approval', null);
    this.pause('Approval timed out and was auto-declined. Queue paused.');
  }
};
