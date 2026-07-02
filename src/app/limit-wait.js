'use strict';

function setWaitingForLimits(app, rateLimits, watchIntervalSeconds) {
  const resetAt = rateLimits.resetAt ? new Date(rateLimits.resetAt * 1000) : null;
  const waitMs = resetAt
    ? Math.max(1000, resetAt.getTime() - Date.now() + 1000)
    : watchIntervalSeconds * 1000;

  app.state = 'waiting-limits';
  app.message = resetAt
    ? `Waiting for limit reset at ${resetAt.toLocaleTimeString()}`
    : 'Waiting for rate limits';

  return Math.min(waitMs, watchIntervalSeconds * 1000);
}

function setRefreshingLimits(app, source) {
  app.state = 'waiting-limits';
  app.message = `Refreshing limits; retrying before ${source}`;
}

async function waitForAvailableLimits(ctx, source) {
  if (ctx.rateLimits.status === 'unknown' || ctx.rateLimits.refreshing) {
    await ctx.pollRateLimits();
  }

  if (ctx.rateLimits.status === 'limited') {
    const delay = setWaitingForLimits(ctx.app, ctx.rateLimits, ctx.opts.watchInterval);
    ctx.broadcastAll();
    ctx.schedulePump(delay);
    return true;
  }

  if (ctx.rateLimits.refreshing) {
    setRefreshingLimits(ctx.app, source);
    ctx.broadcastAll();
    ctx.schedulePump(ctx.opts.watchInterval * 1000);
    return true;
  }

  if (ctx.rateLimits.status === 'unknown') {
    ctx.app.state = 'waiting-limits';
    ctx.app.message = `Limits unknown; retrying before ${source}`;
    ctx.broadcastAll();
    ctx.schedulePump(ctx.opts.watchInterval * 1000);
    return true;
  }

  return false;
}

module.exports = {
  setWaitingForLimits,
  setRefreshingLimits,
  waitForAvailableLimits,
};
