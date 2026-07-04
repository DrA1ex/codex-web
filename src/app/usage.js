'use strict';

const { nowIso } = require('../shared/utils');

const USAGE_REFRESH_DELAY_MS = 2500;

function cloneLimitWindow(windowInfo = {}) {
  return {
    name: windowInfo.name || null,
    usedPercent: Number.isFinite(Number(windowInfo.usedPercent)) ? Number(windowInfo.usedPercent) : null,
    remainingPercent: Number.isFinite(Number(windowInfo.remainingPercent)) ? Number(windowInfo.remainingPercent) : null,
    windowDurationMins: Number(windowInfo.windowDurationMins || 0) || null,
    resetsAt: Number(windowInfo.resetsAt || 0) || null,
  };
}

function windowsForBucket(bucket = {}) {
  if (Array.isArray(bucket.windows) && bucket.windows.length) {
    return bucket.windows.map(cloneLimitWindow);
  }

  return [cloneLimitWindow({
    name: 'primary',
    usedPercent: bucket.usedPercent,
    remainingPercent: bucket.remainingPercent,
    windowDurationMins: bucket.windowDurationMins,
    resetsAt: bucket.resetsAt,
  })];
}

function cloneLimitSnapshot(rateLimits = {}) {
  return {
    status: rateLimits.status || 'unknown',
    updatedAt: rateLimits.updatedAt || nowIso(),
    buckets: (rateLimits.buckets || []).map((bucket) => ({
      limitId: bucket.limitId || 'unknown',
      limitName: bucket.limitName || bucket.limitId || 'limit',
      windows: windowsForBucket(bucket),
    })),
  };
}

function windowLabel(windowInfo = {}) {
  const minutes = Number(windowInfo.windowDurationMins) || 0;
  if (minutes === 300) return '5h';
  if (minutes === 10080) return 'weekly';
  if (minutes && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes && minutes % 60 === 0) return `${minutes / 60}h`;
  return windowInfo.name || 'window';
}

function windowKey(windowInfo = {}) {
  return windowInfo.windowDurationMins ? `duration:${windowInfo.windowDurationMins}` : `name:${windowInfo.name || 'window'}`;
}

function positivePercentDelta(startValue, endValue) {
  const start = Number(startValue);
  const end = Number(endValue);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const delta = end - start;
  return delta > 0 ? Math.round(delta * 10) / 10 : null;
}

function calculateLimitDeltas(startSnapshot, endSnapshot) {
  const endBuckets = new Map((endSnapshot?.buckets || []).map((bucket) => [bucket.limitId, bucket]));
  const deltas = [];

  for (const startBucket of startSnapshot?.buckets || []) {
    const endBucket = endBuckets.get(startBucket.limitId);
    if (!endBucket) continue;

    const endWindows = new Map((endBucket.windows || []).map((windowInfo) => [windowKey(windowInfo), windowInfo]));
    for (const startWindow of startBucket.windows || []) {
      const endWindow = endWindows.get(windowKey(startWindow));
      if (!endWindow) continue;

      const usedPercent = positivePercentDelta(startWindow.usedPercent, endWindow.usedPercent);
      if (usedPercent == null) continue;

      deltas.push({
        limitId: startBucket.limitId,
        limitName: startBucket.limitName || startBucket.limitId,
        window: windowLabel(startWindow),
        windowDurationMins: startWindow.windowDurationMins,
        usedPercent,
      });
    }
  }

  return deltas;
}

function normalizeTokenBreakdown(value) {
  if (!value || typeof value !== 'object') return null;
  const keys = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];
  const result = {};
  for (const key of keys) {
    const number = Number(value[key]);
    result[key] = Number.isFinite(number) ? Math.max(0, number) : 0;
  }
  return result;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : null;
}

function firstFiniteNumber(values) {
  for (const value of values) {
    const number = finiteNumber(value);
    if (number !== null) return number;
  }
  return null;
}

function extractThreadTokenCount(value = {}) {
  const thread = value.thread || value;
  return firstFiniteNumber([
    thread.contextTokenCount,
    thread.contextTokens,
    thread.context_token_count,
    thread.context_tokens,
    thread.tokenCount,
    thread.tokens,
    thread.totalTokens,
    thread.total_tokens,
    thread.context?.tokenCount,
    thread.context?.tokens,
    thread.context?.totalTokens,
    thread.contextWindow?.usedTokens,
    thread.contextWindow?.tokenCount,
    thread.context_window?.used_tokens,
    thread.context_window?.token_count,
    thread.tokenUsage?.totalTokens,
    thread.token_usage?.total_tokens,
    thread.usage?.totalTokens,
  ]);
}

function extractCompactionTokenCount(params = {}, phase) {
  const compact = params.compaction || params.compact || params.summary || params;
  const phaseNode = phase === 'before'
    ? (compact.before || compact.previous || compact.pre || params.before)
    : (compact.after || compact.next || compact.post || params.after);

  return firstFiniteNumber([
    phaseNode?.contextTokenCount,
    phaseNode?.contextTokens,
    phaseNode?.tokenCount,
    phaseNode?.tokens,
    phaseNode?.totalTokens,
    phase === 'before' ? compact.beforeTokens : compact.afterTokens,
    phase === 'before' ? compact.beforeTokenCount : compact.afterTokenCount,
    phase === 'before' ? compact.previousTokens : compact.currentTokens,
    phase === 'before' ? params.beforeTokens : params.afterTokens,
    phase === 'before' ? params.beforeTokenCount : params.afterTokenCount,
  ]);
}

function formatNumber(value) {
  return Number(value).toLocaleString('en-US');
}

function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '?';
  return `${Math.round(number * 10) / 10}%`;
}

function formatTokenChange(before, after) {
  if (before === null && after === null) return 'tokens: unavailable';
  if (before === null) return `tokens: ? -> ${formatNumber(after)}`;
  if (after === null) return `tokens: ${formatNumber(before)} -> ?`;

  const delta = after - before;
  const signed = delta > 0 ? `+${formatNumber(delta)}` : formatNumber(delta);
  return `tokens: ${formatNumber(before)} -> ${formatNumber(after)} (${signed})`;
}

function formatLimitUsageChanges(startSnapshot, endSnapshot) {
  const endBuckets = new Map((endSnapshot?.buckets || []).map((bucket) => [bucket.limitId, bucket]));
  const lines = [];

  for (const startBucket of startSnapshot?.buckets || []) {
    const endBucket = endBuckets.get(startBucket.limitId);
    if (!endBucket) continue;

    const endWindows = new Map((endBucket.windows || []).map((windowInfo) => [windowKey(windowInfo), windowInfo]));
    for (const startWindow of startBucket.windows || []) {
      const endWindow = endWindows.get(windowKey(startWindow));
      if (!endWindow) continue;

      const before = Number(startWindow.usedPercent);
      const after = Number(endWindow.usedPercent);
      const delta = Number.isFinite(before) && Number.isFinite(after)
        ? Math.round((after - before) * 10) / 10
        : null;
      const signed = delta === null ? '' : ` (${delta > 0 ? '+' : ''}${formatPercent(delta)})`;
      lines.push(`${startBucket.limitName || startBucket.limitId} ${windowLabel(startWindow)}: ${formatPercent(before)} -> ${formatPercent(after)}${signed}`);
    }
  }

  return lines;
}

function compactUsageOutput(usage = {}) {
  const before = usage.compactTokensBefore ?? null;
  const after = usage.compactTokensAfter ?? null;
  const lines = ['[compact usage]', formatTokenChange(before, after)];
  lines.push(...formatLimitUsageChanges(usage.startedLimits, usage.finishedLimits));
  return lines.join('\n');
}

function publicUsageStatus(usage) {
  if (!usage) return 'unavailable';
  if (usage.tokenUsage || (usage.limitDeltas || []).length) return usage.refreshPending ? 'estimated' : 'final';
  if (usage.finishedLimits || usage.refreshedLimits) return 'unavailable';
  return 'pending';
}

async function safePollRateLimits(ctx, source) {
  try {
    await ctx.pollRateLimits();
  } catch (err) {
    ctx.debugLog?.(`${source} rate-limit refresh failed`, err.message || String(err));
  }
}

function ensureUsage(item, ctx) {
  if (!item.usage || typeof item.usage !== 'object') {
    item.usage = {
      threadId: ctx.app.sessionId || null,
      turnId: null,
      tokenUsage: null,
      startedLimits: null,
      finishedLimits: null,
      refreshedLimits: null,
      limitDeltas: [],
      limitDeltaScope: 'account',
      usageStatus: 'pending',
      usageUpdatedAt: nowIso(),
      refreshPending: false,
    };
  }
  return item.usage;
}

async function updateUsageFromLimits(ctx, item, fieldName) {
  if (!item?.usage?.startedLimits) return false;
  const snapshot = cloneLimitSnapshot(ctx.rateLimits);
  item.usage[fieldName] = snapshot;
  item.usage.limitDeltas = calculateLimitDeltas(item.usage.startedLimits, snapshot);
  item.usage.usageUpdatedAt = nowIso();
  item.usage.usageStatus = publicUsageStatus(item.usage);
  return true;
}

module.exports = {
  cloneLimitSnapshot,
  calculateLimitDeltas,
  normalizeTokenBreakdown,
  extractThreadTokenCount,
  extractCompactionTokenCount,
  compactUsageOutput,

  async refreshPreviousQueueItemUsage() {
    const id = this.pendingUsageRefreshItemId;
    if (!id) return false;

    const item = this.queue.find((queueItem) => queueItem.id === id);
    this.pendingUsageRefreshItemId = null;
    if (!item?.usage?.refreshPending) return false;

    await safePollRateLimits(this, 'previous usage');
    item.usage.refreshPending = false;
    const updated = await updateUsageFromLimits(this, item, 'refreshedLimits');
    if (updated) await this.saveQueue();
    return updated;
  },

  async beginQueueItemUsage(item) {
    await this.refreshPreviousQueueItemUsage();
    await safePollRateLimits(this, 'usage baseline');

    const usage = ensureUsage(item, this);
    usage.threadId = this.app.sessionId || null;
    usage.turnId = null;
    usage.tokenUsage = null;
    usage.startedLimits = cloneLimitSnapshot(this.rateLimits);
    usage.finishedLimits = null;
    usage.refreshedLimits = null;
    usage.limitDeltas = [];
    usage.limitDeltaScope = 'account';
    usage.usageStatus = 'pending';
    usage.usageUpdatedAt = nowIso();
    usage.refreshPending = false;
    return usage;
  },

  async recordQueueItemTurn(item, turnId) {
    if (!item || !turnId) return false;
    const usage = ensureUsage(item, this);
    usage.threadId = this.app.sessionId || usage.threadId || null;
    usage.turnId = turnId;
    usage.usageUpdatedAt = nowIso();
    await this.saveQueue();
    return true;
  },

  async readThreadTokenCount() {
    if (!this.app.sessionId) return null;
    try {
      const read = await this.rpc.request('thread/read', { threadId: this.app.sessionId, includeTurns: true }, 6000);
      return extractThreadTokenCount(read);
    } catch (err) {
      this.debugLog?.('thread token read failed', err.message || String(err));
      return null;
    }
  },

  async beginQueuedCommandUsage(item) {
    await this.refreshPreviousQueueItemUsage();
    await safePollRateLimits(this, 'command usage baseline');

    const usage = ensureUsage(item, this);
    usage.threadId = this.app.sessionId || null;
    usage.turnId = null;
    usage.tokenUsage = null;
    usage.startedLimits = cloneLimitSnapshot(this.rateLimits);
    usage.finishedLimits = null;
    usage.refreshedLimits = null;
    usage.limitDeltas = [];
    usage.limitDeltaScope = 'account';
    usage.usageStatus = 'pending';
    usage.usageUpdatedAt = nowIso();
    usage.refreshPending = false;
    usage.command = item.command || null;
    usage.compactTokensBefore = item.command === '/compact' ? await this.readThreadTokenCount() : null;
    usage.compactTokensAfter = null;
    return usage;
  },

  async completeQueuedCommandUsage(item, eventParams = null) {
    if (!item?.usage?.startedLimits) return null;

    const usage = ensureUsage(item, this);
    if (item.command === '/compact') {
      usage.compactTokensBefore = usage.compactTokensBefore ?? extractCompactionTokenCount(eventParams, 'before');
      usage.compactTokensAfter = extractCompactionTokenCount(eventParams, 'after') ?? await this.readThreadTokenCount();
    }

    await safePollRateLimits(this, 'command usage final');
    await updateUsageFromLimits(this, item, 'finishedLimits');
    usage.refreshPending = false;
    usage.usageStatus = publicUsageStatus(usage);
    usage.usageUpdatedAt = nowIso();
    await this.saveQueue();
    return usage;
  },

  async completeQueueItemUsage(item) {
    if (!item?.usage?.startedLimits) return false;

    await safePollRateLimits(this, 'usage final');
    const updated = await updateUsageFromLimits(this, item, 'finishedLimits');
    item.usage.refreshPending = true;
    item.usage.usageStatus = publicUsageStatus(item.usage);
    this.pendingUsageRefreshItemId = item.id;
    await this.saveQueue();
    this.scheduleQueueItemUsageRefresh(item.id);
    return updated;
  },

  scheduleQueueItemUsageRefresh(itemId) {
    if (this.usageRefreshTimer) clearTimeout(this.usageRefreshTimer);
    this.pendingUsageRefreshItemId = itemId;
    this.usageRefreshTimer = setTimeout(() => {
      this.usageRefreshTimer = null;
      this.refreshPreviousQueueItemUsage()
        .then((updated) => {
          if (updated) this.broadcastAll();
        })
        .catch((err) => this.debugLog?.('usage refresh failed', err.message || String(err)));
    }, USAGE_REFRESH_DELAY_MS);
    if (typeof this.usageRefreshTimer.unref === 'function') this.usageRefreshTimer.unref();
  },

  handleTokenUsageUpdated(params = {}) {
    const threadId = params.threadId || params.thread?.id || null;
    const turnId = params.turnId || params.turn?.id || null;
    if (!threadId || !turnId) return false;
    if (threadId !== this.app.sessionId) return false;

    const activeItem = turnId === this.currentTurnId ? this.currentItem() : null;
    const item = activeItem || this.queue.find((queueItem) => (
      queueItem.usage?.threadId === threadId && queueItem.usage?.turnId === turnId
    ));
    if (!item) return false;

    const tokenUsage = normalizeTokenBreakdown(params.tokenUsage?.last || params.tokenUsage);
    if (!tokenUsage) return false;

    const usage = ensureUsage(item, this);
    usage.threadId = threadId;
    usage.turnId = turnId;
    usage.tokenUsage = tokenUsage;
    usage.usageUpdatedAt = nowIso();
    usage.usageStatus = publicUsageStatus(usage);
    this.saveQueue().catch(() => {});
    this.broadcastAll();
    return true;
  },
};
