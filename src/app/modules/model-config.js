'use strict';

const { DEFAULT_MODEL } = require('../../shared/config');
const {
  fetchModelCatalog,
  makeFallbackCatalog,
  buildEffortOptions,
  isKnownModel,
  isKnownEffort,
} = require('../../codex/models');

const SANDBOX_OPTIONS = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const APPROVAL_POLICY_OPTIONS = new Set(['on-request', 'never', 'untrusted', 'on-failure']);

function catalogMeta(catalog) {
  return {
    source: catalog.source,
    updatedAt: catalog.updatedAt,
    error: catalog.error,
  };
}

function applyModelCatalog(ctx, catalog) {
  ctx.modelCatalog = catalog;
  ctx.app.defaultModel = catalog.defaultModel || DEFAULT_MODEL;
  ctx.app.modelOptions = catalog.modelOptions;
  ctx.app.effortOptions = buildEffortOptions(catalog, ctx.opts.model);
  ctx.app.modelCatalog = catalogMeta(catalog);
}

function selectedModelLabel(ctx, value) {
  if (!value) return `${ctx.app.defaultModel || DEFAULT_MODEL} (default)`;

  const option = ctx.app.modelOptions.find((candidate) => candidate.value === value);
  return option?.label || value;
}

function selectedEffortLabel(ctx, value) {
  if (!value) return 'default';

  const option = ctx.app.effortOptions.find((candidate) => candidate.value === value);
  return option?.label || value;
}

async function resetUnsupportedEffort(ctx) {
  if (!ctx.opts.effort) return false;
  if (isKnownEffort(ctx.modelCatalog, ctx.opts.model, ctx.opts.effort)) return false;

  const previous = ctx.opts.effort;
  ctx.opts.effort = '';
  ctx.app.effort = '';
  ctx.app.effortOptions = buildEffortOptions(ctx.modelCatalog, ctx.opts.model);
  await ctx.saveState();
  ctx.appendOutput(`[config] effort ${previous} is not supported by ${selectedModelLabel(ctx, ctx.opts.model)}; reset to default`, 'system');

  return true;
}

module.exports = {

  async syncModelConfigState() {
    applyModelCatalog(this, this.modelCatalog);
    await resetUnsupportedEffort(this);
  },

  async refreshModelCatalog() {
    let catalog;

    try {
      catalog = await fetchModelCatalog(this.rpc);
    } catch (err) {
      catalog = makeFallbackCatalog(err.message || String(err));
      this.debugLog('model/list failed', err.message || String(err));
    }

    applyModelCatalog(this, catalog);

    if (this.opts.model && !isKnownModel(catalog, this.opts.model)) {
      this.debugLog('configured model is not in model/list', this.opts.model);
    }

    await resetUnsupportedEffort(this);
    this.broadcastAll();

    return {
      ok: catalog.source === 'app-server',
      source: catalog.source,
      defaultModel: catalog.defaultModel,
      modelOptions: this.app.modelOptions,
      effortOptions: this.app.effortOptions,
      error: catalog.error,
    };
  },

  async setModel(model) {
    const value = String(model || '').trim();

    if (value && !isKnownModel(this.modelCatalog, value)) {
      throw new Error(`Unsupported model selection: ${value}`);
    }

    this.opts.model = value;
    this.app.model = value;
    this.app.configSources.model = 'runtime';
    this.app.effortOptions = buildEffortOptions(this.modelCatalog, value);

    await resetUnsupportedEffort(this);
    await this.saveState();
    this.appendOutput(`[config] model ${selectedModelLabel(this, value)}`, 'system');
    this.broadcastAll();

    return {
      ok: true,
      model: value,
      effort: this.opts.effort || '',
      effortOptions: this.app.effortOptions,
    };
  },

  async setEffort(effort) {
    const value = String(effort || '').trim();

    if (!isKnownEffort(this.modelCatalog, this.opts.model, value)) {
      throw new Error(`Unsupported effort selection for ${selectedModelLabel(this, this.opts.model)}: ${value}`);
    }

    this.opts.effort = value;
    this.app.effort = value;
    this.app.configSources.effort = 'runtime';
    await this.saveState();
    this.appendOutput(`[config] effort ${selectedEffortLabel(this, value)}`, 'system');
    this.broadcastAll();

    return { ok: true, effort: value };
  },

  async setTheme(theme) {
    const value = theme === 'light' ? 'light' : 'dark';

    this.app.theme = value;
    await this.saveSettings();
    this.broadcastAll();

    return { ok: true, theme: value };
  },

  async setSandbox(sandbox) {
    const value = String(sandbox || '').trim();
    if (!SANDBOX_OPTIONS.has(value)) throw new Error(`Unsupported sandbox mode: ${value || '(empty)'}`);

    this.opts.sandbox = value;
    this.app.sandbox = value;
    this.app.configSources.sandbox = 'runtime';
    await this.saveSettings();
    this.appendOutput(`[config] sandbox ${value}`, 'system');
    this.broadcastAll();

    return { ok: true, sandbox: value };
  },

  async setApprovalPolicy(approvalPolicy) {
    const value = String(approvalPolicy || '').trim();
    if (!APPROVAL_POLICY_OPTIONS.has(value)) throw new Error(`Unsupported approval policy: ${value || '(empty)'}`);

    this.opts.approvalPolicy = value;
    this.app.approvalPolicy = value;
    this.app.configSources.approvalPolicy = 'runtime';
    await this.saveSettings();
    this.appendOutput(`[config] approval ${value}`, 'system');
    this.broadcastAll();

    return { ok: true, approvalPolicy: value };
  },
};
