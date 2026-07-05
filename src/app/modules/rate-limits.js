'use strict';

const crypto = require('node:crypto');

const {
  normalizeRateLimits,
  markRateLimitRefreshFailed,
} = require('../../codex/rate-limits');
const { nowIso, randomId, safeJson, truncate, maskSecrets } = require('../../shared/utils');

const LIMIT_RESET_WAIT_MS = 5000;
const LIMIT_RESET_VALID_MS = 60000;
const LIMIT_RESET_SUCCESS_OUTCOMES = new Set(['reset', 'alreadyRedeemed']);

function nowMs(ctx) {
  return typeof ctx.nowMs === 'function' ? ctx.nowMs() : Date.now();
}

function isoFromMs(ms) {
  return new Date(ms).toISOString();
}

function resetCreditInfo(rateLimits) {
  const resetCredits = rateLimits?.resetCredits || null;
  const availableCount = Number(resetCredits?.availableCount ?? 0) || 0;
  const expiresAt = Number(resetCredits?.expiresAt || 0) || null;
  return {
    availableCount: Math.max(0, availableCount),
    expiresAt,
  };
}

function limitWindowRemaining(windowInfo = {}) {
  const remaining = Number(windowInfo.remainingPercent);
  if (Number.isFinite(remaining)) return Math.max(0, remaining);
  const used = Number(windowInfo.usedPercent);
  return Number.isFinite(used) ? Math.max(0, 100 - used) : null;
}

function resettableLimitWindow(windowInfo = {}) {
  const duration = Number(windowInfo.windowDurationMins || 0);
  const name = String(windowInfo.name || '').toLowerCase();
  return duration === 300
    || duration === 10080
    || name === 'primary'
    || name === 'secondary'
    || name === '5h'
    || name === 'weekly';
}

function hasExhaustedResettableLimit(rateLimits) {
  for (const bucket of rateLimits?.buckets || []) {
    for (const windowInfo of bucket.windows || []) {
      const remaining = limitWindowRemaining(windowInfo);
      if (resettableLimitWindow(windowInfo) && remaining !== null && remaining <= 0) return true;
    }
  }
  return false;
}

function hasEmptyLimitsWithResetCredit(rateLimits) {
  return resetCreditInfo(rateLimits).availableCount > 0 && hasExhaustedResettableLimit(rateLimits);
}

function publicResetRequest(request, now = Date.now()) {
  if (!request) return null;
  return {
    requestId: request.requestId,
    availableCount: request.availableCount,
    creditExpiresAt: request.creditExpiresAt,
    requestedAt: request.requestedAt,
    availableAt: request.availableAt,
    expiresAt: request.expiresAt,
    waitMs: Math.max(0, request.availableAtMs - now),
    validForMs: LIMIT_RESET_VALID_MS,
  };
}

module.exports = {
  scheduleLimitPolling() {
    if (this.limitTimer) clearInterval(this.limitTimer);
    this.limitTimer = setInterval(() => this.pollRateLimits().catch((err) => this.debugLog('pollRateLimits failed', err.message)), this.opts.watchInterval * 1000);
    this.limitTimer.unref();
  },

  reportRateLimitStatus(previousStatus, source, err = null, recoveredFromRefreshError = false) {
    const ts = nowIso();
    if (err) {
      const code = err.code ? ` code=${err.code}` : '';
      const data = err.data ? ` data=${truncate(safeJson(maskSecrets(err.data)), 300)}` : '';
      console.warn(`[limits] ${ts} ${source} failed: ${err.message || String(err)}${code}${data}`);
      return;
    }
    if (this.rateLimits.status === 'unknown') {
      const raw = this.rateLimits.raw && typeof this.rateLimits.raw === 'object' ? ` rawKeys=${Object.keys(this.rateLimits.raw).join(',') || 'none'}` : '';
      console.warn(`[limits] ${ts} ${source} unknown: ${this.rateLimits.message || 'unknown'}${raw}`);
    } else if (previousStatus === 'unknown' || recoveredFromRefreshError) {
      console.log(`[limits] ${ts} ${source} recovered: ${this.rateLimits.status} (${this.rateLimits.message || 'ok'})`);
    }
  },

  async pollRateLimits() {
    if (!this.rpc || this.rpc.exited) return;
    const previousLimits = this.rateLimits;
    const previousStatus = previousLimits.status;
    try {
      const result = await this.rpc.request('account/rateLimits/read', undefined, 12000);
      this.rateLimits = normalizeRateLimits(result);
      this.debug.lastRateLimitPayload = result;
      this.reportRateLimitStatus(previousStatus, 'poll', null, !!previousLimits.refreshError);
      this.broadcast('rateLimits', this.rateLimits);
      this.broadcastAll();
    } catch (err) {
      this.rateLimits = markRateLimitRefreshFailed(previousLimits, err);
      this.debug.lastJsonRpcError = { message: err.message, code: err.code, data: err.data };
      this.reportRateLimitStatus(previousStatus, 'poll', err);
      this.broadcast('rateLimits', this.rateLimits);
      this.broadcastAll();
    }
  },

  currentLimitResetRequest() {
    const request = this.limitResetRequest;
    if (!request) return null;
    const now = nowMs(this);
    if (now > request.expiresAtMs) {
      this.limitResetRequest = null;
      return null;
    }
    return publicResetRequest(request, now);
  },

  requestLimitReset() {
    if (!hasEmptyLimitsWithResetCredit(this.rateLimits)) {
      throw new Error('No rate-limit reset is currently available.');
    }

    const now = nowMs(this);
    if (this.limitResetRequest && now <= this.limitResetRequest.expiresAtMs) {
      const existing = publicResetRequest(this.limitResetRequest, now);
      this.broadcastAll();
      return { ok: true, resetRequest: existing };
    }

    const credits = resetCreditInfo(this.rateLimits);
    const availableAtMs = now + LIMIT_RESET_WAIT_MS;
    const expiresAtMs = now + LIMIT_RESET_VALID_MS;
    this.limitResetRequest = {
      requestId: randomId(8),
      idempotencyKey: crypto.randomUUID(),
      availableCount: credits.availableCount,
      creditExpiresAt: credits.expiresAt,
      requestedAt: isoFromMs(now),
      availableAt: isoFromMs(availableAtMs),
      expiresAt: isoFromMs(expiresAtMs),
      availableAtMs,
      expiresAtMs,
    };
    this.broadcastAll();
    return { ok: true, resetRequest: publicResetRequest(this.limitResetRequest, now) };
  },

  async consumeLimitReset(body = {}) {
    const requestId = String(body.requestId || '');
    const request = this.limitResetRequest;
    const now = nowMs(this);

    if (!request || request.requestId !== requestId) {
      throw new Error('Request reset before consuming a rate-limit reset.');
    }
    if (now < request.availableAtMs) {
      throw new Error('Rate-limit reset is not ready yet.');
    }
    if (now > request.expiresAtMs) {
      this.limitResetRequest = null;
      this.broadcastAll();
      throw new Error('Rate-limit reset request expired. Request reset again.');
    }

    const result = await this.rpc.request(
      'account/rateLimitResetCredit/consume',
      { idempotencyKey: request.idempotencyKey },
      12000
    );
    const outcome = result?.outcome || 'unknown';
    if (!LIMIT_RESET_SUCCESS_OUTCOMES.has(outcome)) {
      this.limitResetRequest = null;
      this.broadcastAll();
      throw new Error(`Rate-limit reset was not consumed: ${outcome}`);
    }

    this.limitResetRequest = null;
    this.appendOutput(`[limits] reset consumed (${outcome})`, 'system');
    await this.pollRateLimits();
    this.broadcastAll();
    return { ok: true, outcome };
  }
};
