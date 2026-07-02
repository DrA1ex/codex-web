'use strict';

const {
  DEFAULT_MODEL,
  MODEL_OPTIONS: FALLBACK_MODEL_OPTIONS,
  EFFORT_OPTIONS: FALLBACK_EFFORT_OPTIONS,
} = require('../shared/config');

const MODEL_LIST_PAGE_LIMIT = 100;
const MODEL_LIST_TIMEOUT_MS = 8000;

function toTrimmedString(value) {
  return String(value || '').trim();
}

function uniqueByValue(options) {
  const seen = new Set();
  const result = [];

  for (const option of options) {
    const value = toTrimmedString(option?.value);
    if (seen.has(value)) continue;

    seen.add(value);
    result.push({ ...option, value });
  }

  return result;
}

function effortValue(effort) {
  if (typeof effort === 'string') return toTrimmedString(effort);
  return toTrimmedString(
    effort?.reasoningEffort
    || effort?.effort
    || effort?.value
    || effort?.id
    || effort?.name,
  );
}

function normalizeEffortOption(effort) {
  const value = effortValue(effort);
  if (!value) return null;

  const description = typeof effort === 'object' && effort ? toTrimmedString(effort.description) : '';

  return {
    value,
    label: value,
    ...(description ? { description } : {}),
  };
}

function normalizeSupportedEfforts(entry) {
  const efforts = Array.isArray(entry?.supportedReasoningEfforts)
    ? entry.supportedReasoningEfforts
    : [];

  return efforts
    .map(normalizeEffortOption)
    .filter(Boolean);
}

function modelId(entry) {
  return toTrimmedString(entry?.model || entry?.id || entry?.name);
}

function normalizeModelEntry(entry) {
  const value = modelId(entry);
  if (!value) return null;

  const displayName = toTrimmedString(entry.displayName || entry.display_name || entry.title);
  const label = displayName && displayName !== value ? `${displayName} (${value})` : value;

  return {
    value,
    label,
    id: toTrimmedString(entry.id) || value,
    model: value,
    displayName: displayName || value,
    hidden: !!entry.hidden,
    isDefault: !!entry.isDefault,
    defaultReasoningEffort: effortValue(entry.defaultReasoningEffort),
    supportedReasoningEfforts: normalizeSupportedEfforts(entry),
    inputModalities: Array.isArray(entry.inputModalities) ? entry.inputModalities : ['text', 'image'],
    supportsPersonality: entry.supportsPersonality !== false,
    raw: entry,
  };
}

function extractModelEntries(result) {
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result?.models)) return result.models;
  if (Array.isArray(result?.modelOptions)) return result.modelOptions;
  if (Array.isArray(result)) return result;

  return [];
}

function extractNextCursor(result) {
  return result?.nextCursor || result?.next_cursor || result?.cursor || null;
}

function makeFallbackCatalog(error = null) {
  return {
    source: 'fallback',
    defaultModel: DEFAULT_MODEL,
    models: FALLBACK_MODEL_OPTIONS
      .filter((option) => option.value)
      .map((option) => ({
        value: option.value,
        label: option.label,
        id: option.value,
        model: option.value,
        displayName: option.label,
        hidden: false,
        isDefault: option.value === DEFAULT_MODEL,
        defaultReasoningEffort: '',
        supportedReasoningEfforts: FALLBACK_EFFORT_OPTIONS.filter((option) => option.value),
        inputModalities: ['text', 'image'],
        supportsPersonality: true,
        raw: option,
      })),
    modelOptions: FALLBACK_MODEL_OPTIONS,
    effortOptions: FALLBACK_EFFORT_OPTIONS,
    updatedAt: null,
    error,
  };
}

function findDefaultModel(models) {
  return models.find((model) => model.isDefault)?.value || models[0]?.value || DEFAULT_MODEL;
}

function findModel(catalog, selectedModel) {
  const value = toTrimmedString(selectedModel) || catalog.defaultModel;
  return catalog.models.find((model) => model.value === value)
    || catalog.models.find((model) => model.value === catalog.defaultModel)
    || catalog.models[0]
    || null;
}

function buildModelOptions(catalog) {
  const defaultModel = catalog.defaultModel
    && catalog.models.find((model) => model.value === catalog.defaultModel)?.displayName
    || DEFAULT_MODEL

  const options = [
    { value: '', label: `${defaultModel} (default)` },
    ...catalog.models.map((model) => ({
      value: model.value,
      label: model.displayName || model.label || model.value,
      ...(model.hidden ? { hidden: true } : {}),
      ...(model.inputModalities ? { inputModalities: model.inputModalities } : {}),
      ...(model.supportsPersonality === false ? { supportsPersonality: false } : {}),
    })),
  ];

  return uniqueByValue(options);
}

function buildEffortOptions(catalog, selectedModel) {
  const model = findModel(catalog, selectedModel);
  const supported = model?.supportedReasoningEfforts?.length
    ? model.supportedReasoningEfforts
    : FALLBACK_EFFORT_OPTIONS.filter((option) => option.value);

  return uniqueByValue([
    { value: '', label: 'default' },
    ...supported,
  ]);
}

function createModelCatalog(entries, { source = 'app-server', updatedAt = new Date().toISOString() } = {}) {
  const models = uniqueByValue(entries.map(normalizeModelEntry).filter(Boolean));

  if (!models.length) return makeFallbackCatalog('app-server returned an empty model list');

  const defaultModel = findDefaultModel(models);
  const catalog = {
    source,
    defaultModel,
    models,
    modelOptions: [],
    effortOptions: [],
    updatedAt,
    error: null,
  };

  catalog.modelOptions = buildModelOptions(catalog);
  catalog.effortOptions = buildEffortOptions(catalog, '');

  return catalog;
}

async function fetchModelCatalog(rpc, options = {}) {
  const includeHidden = !!options.includeHidden;
  const allEntries = [];
  let cursor = null;

  do {
    const params = {
      limit: MODEL_LIST_PAGE_LIMIT,
      includeHidden,
    };

    if (cursor) params.cursor = cursor;

    const page = await rpc.request('model/list', params, MODEL_LIST_TIMEOUT_MS);
    allEntries.push(...extractModelEntries(page));
    cursor = extractNextCursor(page);
  } while (cursor);

  return createModelCatalog(allEntries);
}

function isKnownModel(catalog, value) {
  const normalized = toTrimmedString(value);
  if (!normalized) return true;
  if (catalog?.source !== 'app-server') return true;

  return catalog.models.some((model) => model.value === normalized);
}

function isKnownEffort(catalog, selectedModel, value) {
  const normalized = toTrimmedString(value);
  if (!normalized) return true;
  if (catalog?.source !== 'app-server') return true;

  return buildEffortOptions(catalog, selectedModel).some((option) => option.value === normalized);
}

module.exports = {
  fetchModelCatalog,
  makeFallbackCatalog,
  buildEffortOptions,
  isKnownModel,
  isKnownEffort,
};
