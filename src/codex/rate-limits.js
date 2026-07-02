'use strict';

const { nowIso } = require('../shared/utils');

function emptyRateLimitState(message, now = nowIso()) {
  return {
    status: 'unknown',
    message,
    buckets: [],
    resetAt: null,
    resetCredits: null,
    raw: null,
    updatedAt: null,
    lastSuccessfulUpdatedAt: null,
    refreshFailedAt: now,
    refreshError: message,
    refreshing: true,
    stale: false,
  };
}

function markRateLimitRefreshFailed(previous, err) {
  const now = nowIso();
  const message = err && err.message ? err.message : String(err || 'failed to fetch rate limits');
  const hasLastKnownLimits = Array.isArray(previous?.buckets) && previous.buckets.length > 0;

  if (!hasLastKnownLimits) return emptyRateLimitState(message, now);

  return {
    ...previous,
    refreshFailedAt: now,
    refreshError: message,
    refreshing: true,
    stale: true,
    lastSuccessfulUpdatedAt: previous.lastSuccessfulUpdatedAt || previous.updatedAt || null,
  };
}

function normalizeRateLimits(result) {
  const root = result || {};
  const by = root.rateLimitsByLimitId || (root.rateLimits ? { [root.rateLimits.limitId || 'default']: root.rateLimits } : {});
  function normalizeWindow(w, fallbackName) {
    if (!w) return null;
    const usedPercent = Number(w.usedPercent ?? NaN);
    const windowDurationMins = Number(w.windowDurationMins || 0) || null;
    const resetsAt = Number(w.resetsAt || 0) || null;
    if (!Number.isFinite(usedPercent) && !windowDurationMins && !resetsAt) return null;
    return {
      name: fallbackName,
      usedPercent: Number.isFinite(usedPercent) ? usedPercent : null,
      remainingPercent: Number.isFinite(usedPercent) ? Math.max(0, 100 - usedPercent) : null,
      windowDurationMins,
      resetsAt,
    };
  }
  const buckets = Object.values(by).map((b) => {
    const primary = b.primary || {};
    const secondary = b.secondary || {};
    const resetAt = Number(primary.resetsAt || secondary.resetsAt || b.resetsAt || 0) || null;
    const usedPercent = Number(primary.usedPercent ?? secondary.usedPercent ?? b.usedPercent ?? NaN);
    const windows = [
      normalizeWindow(primary, 'primary'),
      normalizeWindow(secondary, 'secondary'),
    ].filter(Boolean);
    return {
      limitId: b.limitId || b.id || 'unknown',
      limitName: b.limitName || b.name || null,
      usedPercent: Number.isFinite(usedPercent) ? usedPercent : null,
      windowDurationMins: primary.windowDurationMins || secondary.windowDurationMins || null,
      resetsAt: resetAt,
      windows,
      rateLimitReachedType: b.rateLimitReachedType || null,
      planType: b.planType || null,
      credits: b.credits || null,
    };
  });
  let limitedBuckets = buckets.filter((b) => b.rateLimitReachedType || (b.usedPercent !== null && b.usedPercent >= 100));
  let status = 'available';
  let message = 'available';
  let resetAt = null;
  if (!buckets.length) {
    status = 'unknown';
    message = 'no rate-limit buckets returned';
  } else if (limitedBuckets.length) {
    status = 'limited';
    message = limitedBuckets.map((b) => `${b.limitName || b.limitId}${b.rateLimitReachedType ? ': ' + b.rateLimitReachedType : ''}`).join(', ');
    const resets = limitedBuckets.map((b) => b.resetsAt).filter(Boolean);
    resetAt = resets.length ? Math.min(...resets) : null;
  }
  const updatedAt = nowIso();
  return {
    status,
    message,
    buckets,
    resetAt,
    resetCredits: root.rateLimitResetCredits || null,
    raw: root,
    updatedAt,
    lastSuccessfulUpdatedAt: updatedAt,
    refreshFailedAt: null,
    refreshError: null,
    refreshing: false,
    stale: false,
  };
}

module.exports = {
  normalizeRateLimits,
  markRateLimitRefreshFailed,
};
