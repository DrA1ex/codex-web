'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { fetchModelCatalog, makeFallbackCatalog, buildEffortOptions, isKnownModel, isKnownEffort } = require('../src/codex/models');
const { makeAppWithQueue } = require('./helpers');

test('fetchModelCatalog follows cursors and normalizes model and effort options', async () => {
  const requests = [];
  const rpc = {
    request: async (method, params, timeout) => {
      requests.push({ method, params, timeout });
      if (!params.cursor) {
        return {
          data: [{
            model: 'gpt-a',
            displayName: 'GPT A',
            isDefault: true,
            supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'fast' }, 'high'],
          }],
          nextCursor: 'page-2',
        };
      }
      return { models: [{ id: 'gpt-b', display_name: 'GPT B', hidden: true, supportsPersonality: false }] };
    },
  };

  const catalog = await fetchModelCatalog(rpc, { includeHidden: true });

  assert.equal(catalog.source, 'app-server');
  assert.equal(catalog.defaultModel, 'gpt-a');
  assert.deepEqual(requests.map((r) => r.params), [
    { limit: 100, includeHidden: true },
    { limit: 100, includeHidden: true, cursor: 'page-2' },
  ]);
  assert.equal(catalog.modelOptions.find((option) => option.value === 'gpt-b').hidden, true);
  assert.deepEqual(buildEffortOptions(catalog, 'gpt-a').map((option) => option.value), ['', 'low', 'high']);
  assert.equal(isKnownModel(catalog, 'gpt-a'), true);
  assert.equal(isKnownModel(catalog, 'unknown'), false);
  assert.equal(isKnownEffort(catalog, 'gpt-a', 'low'), true);
  assert.equal(isKnownEffort(catalog, 'gpt-a', 'medium'), false);
});

test('fallback catalog accepts arbitrary explicit selections', () => {
  const fallback = makeFallbackCatalog('offline');

  assert.equal(fallback.source, 'fallback');
  assert.equal(fallback.error, 'offline');
  assert.equal(isKnownModel(fallback, 'custom-model'), true);
  assert.equal(isKnownEffort(fallback, 'custom-model', 'custom-effort'), true);
});

test('refreshModelCatalog applies app-server catalog and resets unsupported effort', async () => {
  const app = makeAppWithQueue([], { model: 'gpt-a', effort: 'unsupported' });
  app.rpc = {
    request: async () => ({
      data: [{
        model: 'gpt-a',
        displayName: 'GPT A',
        isDefault: true,
        supportedReasoningEfforts: ['low'],
      }],
    }),
  };

  const result = await app.refreshModelCatalog();

  assert.equal(result.ok, true);
  assert.equal(app.modelCatalog.source, 'app-server');
  assert.equal(app.opts.effort, '');
  assert.equal(app.app.defaultModel, 'gpt-a');
  assert.deepEqual(app.app.effortOptions.map((option) => option.value), ['', 'low']);
  assert.match(app.output.at(-1).text, /unsupported.*reset to default/);
});

test('refreshModelCatalog falls back when model/list fails', async () => {
  const app = makeAppWithQueue([]);
  app.rpc = { request: async () => { throw new Error('model list failed'); } };

  const result = await app.refreshModelCatalog();

  assert.equal(result.ok, false);
  assert.equal(result.source, 'fallback');
  assert.equal(result.error, 'model list failed');
});

test('setModel and setEffort validate app-server selections and persist state', async () => {
  const app = makeAppWithQueue([]);
  app.rpc = {
    request: async () => ({
      data: [{
        model: 'gpt-a',
        displayName: 'GPT A',
        isDefault: true,
        supportedReasoningEfforts: ['low', 'high'],
      }],
    }),
  };
  await app.refreshModelCatalog();

  await assert.rejects(() => app.setModel('missing'), /Unsupported model/);
  const modelResult = await app.setModel('gpt-a');
  assert.equal(modelResult.model, 'gpt-a');

  await assert.rejects(() => app.setEffort('medium'), /Unsupported effort/);
  const effortResult = await app.setEffort('high');
  assert.deepEqual(effortResult, { ok: true, effort: 'high' });
  assert.equal(app.opts.effort, 'high');

  const themeResult = await app.setTheme('light');
  assert.deepEqual(themeResult, { ok: true, theme: 'light' });
  assert.equal(app.app.theme, 'light');
  assert.deepEqual(await app.setTheme('unknown'), { ok: true, theme: 'dark' });
});
