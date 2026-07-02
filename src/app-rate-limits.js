'use strict';

const { normalizeRateLimits } = require('./rate-limits');
const { nowIso, safeJson, truncate, maskSecrets } = require('./utils');

module.exports = {
  scheduleLimitPolling() {
    if (this.limitTimer) clearInterval(this.limitTimer);
    this.limitTimer = setInterval(() => this.pollRateLimits().catch((err) => this.debugLog('pollRateLimits failed', err.message)), this.opts.watchInterval * 1000);
    this.limitTimer.unref();
  },

  reportRateLimitStatus(previousStatus, source, err = null) {
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
    } else if (previousStatus === 'unknown') {
      console.log(`[limits] ${ts} ${source} recovered: ${this.rateLimits.status} (${this.rateLimits.message || 'ok'})`);
    }
  },

  async pollRateLimits() {
    if (!this.rpc || this.rpc.exited) return;
    const previousStatus = this.rateLimits.status;
    try {
      const result = await this.rpc.request('account/rateLimits/read', undefined, 12000);
      this.rateLimits = normalizeRateLimits(result);
      this.debug.lastRateLimitPayload = result;
      this.reportRateLimitStatus(previousStatus, 'poll');
      this.broadcast('rateLimits', this.rateLimits);
      this.broadcastAll();
    } catch (err) {
      this.rateLimits = { status: 'unknown', message: err.message, buckets: [], resetAt: null, raw: null, updatedAt: nowIso() };
      this.debug.lastJsonRpcError = { message: err.message, code: err.code, data: err.data };
      this.reportRateLimitStatus(previousStatus, 'poll', err);
      this.broadcast('rateLimits', this.rateLimits);
      this.broadcastAll();
    }
  }
};
