'use strict';

const GET_ROUTES = new Map([
  ['/api/state', (app) => app.snapshot()],
]);

const POST_ROUTES = new Map([
  ['/api/session/select', async (app, body) => {
    await app.selectSession(String(body.sessionId || body.threadId || ''));
    return { ok: true };
  }],
  ['/api/session/create', async (app) => {
    await app.createSession();
    return { ok: true };
  }],
  ['/api/session/reload', async (app) => {
    await app.loadSessions();
    return { ok: true };
  }],
  ['/api/session/cancel-change', (app) => app.cancelSessionChange()],
  ['/api/config/model', (app, body) => app.setModel(body.model)],
  ['/api/config/effort', (app, body) => app.setEffort(body.effort)],
  ['/api/config/models/reload', (app) => app.refreshModelCatalog()],
  ['/api/config/theme', (app, body) => app.setTheme(body.theme)],
  ['/api/limits/reset-request', (app) => app.requestLimitReset()],
  ['/api/limits/reset', (app, body) => app.consumeLimitReset(body)],
  ['/api/queue/add', (app, body) => app.addPrompt(body.text || '')],
  ['/api/queue/send-composer', (app, body) => app.sendComposerNow(body.text || '')],
  ['/api/queue/schedule', (app, body) => app.setQueueSchedule(body.scheduledRunAt)],
  ['/api/queue/schedule-reset', (app) => app.resetQueueSchedule()],
  ['/api/queue/cancel-run', (app) => app.cancelQueueRun()],
  ['/api/queue/update', (app, body) => app.updateQueueItem(body)],
  ['/api/queue/remove', async (app, body) => {
    await app.removeQueueItem(String(body.id));
    return { ok: true };
  }],
  ['/api/queue/completed-page', async (app, body) => {
    return await app.loadCompletedArchivePage(body);
  }],
  ['/api/queue/reorder', async (app, body) => {
    await app.reorderQueueItem(String(body.id), body);
    return { ok: true };
  }],
  ['/api/queue/clear', async (app) => {
    await app.clearPending();
    return { ok: true };
  }],
  ['/api/queue/clear-completed', async (app) => {
    await app.clearCompleted();
    return { ok: true };
  }],
  ['/api/queue/undo', (app) => app.undoLast()],
  ['/api/control/cancel-send', (app) => {
    app.cancelPendingSend();
    return { ok: true };
  }],
  ['/api/control/interrupt', (app) => app.interruptCurrentTurn()],
  ['/api/control/steer-force', (app, body) => app.forceSteerActivePrompt(String(body.text || ''), { confirmed: true })],
  ['/api/control/pause', (app) => {
    app.pause();
    return { ok: true };
  }],
  ['/api/control/resume', (app) => {
    app.resume();
    return { ok: true };
  }],
  ['/api/control/stop', async (app) => {
    await app.shutdown('stop requested');
    return { ok: true };
  }],
  ['/api/approval/respond', async (app, body) => {
    await app.respondApproval(String(body.decision));
    return { ok: true };
  }],
  ['/api/output/clear', (app) => {
    app.clearOutput();
    return { ok: true };
  }],
]);

async function resolveApiRoute(app, req, route, body) {
  if (req.method === 'GET') {
    const handler = GET_ROUTES.get(route);
    if (!handler) return { status: 404, body: { error: 'unknown api route' } };
    return { status: 200, body: await handler(app, body) };
  }

  if (req.method !== 'POST') {
    return { status: 405, body: { error: 'method not allowed' } };
  }

  const handler = POST_ROUTES.get(route);
  if (!handler) return { status: 404, body: { error: 'unknown api route' } };

  return { status: 200, body: await handler(app, body) };
}

module.exports = { resolveApiRoute };
