import { describe, expect, it } from 'vitest';

import {
  getLanguageModelCatalogAdditions,
  getOpenClawAppConfigSignature,
} from './appConfigSignature';

describe('runtime app configuration changes', () => {
  it('does not reapply the runtime when first saving the default Chinese preference', () => {
    const previous = { providers: {} };
    const initialized = { ...previous, language: 'zh', language_initialized: true };

    expect(getOpenClawAppConfigSignature(initialized)).toBe(
      getOpenClawAppConfigSignature(previous),
    );
  });

  it('matches the runtime Chinese fallback for absent or invalid stored languages', () => {
    const chinese = getOpenClawAppConfigSignature({ language: 'zh' });

    for (const language of [undefined, null, '', 'zh-CN', 'fr', true]) {
      expect(getOpenClawAppConfigSignature({ language })).toBe(chinese);
    }
    expect(getOpenClawAppConfigSignature(undefined)).toBe(chinese);
  });

  it('reapplies the runtime for English selection and for switching back to Chinese', () => {
    const initial = getOpenClawAppConfigSignature({});
    const english = getOpenClawAppConfigSignature({ language: 'en' });
    const chinese = getOpenClawAppConfigSignature({ language: 'zh' });

    expect(english).not.toBe(initial);
    expect(chinese).not.toBe(english);
  });

  it('retains provider and speech changes that require runtime synchronization', () => {
    const baseline = getOpenClawAppConfigSignature({});

    expect(getOpenClawAppConfigSignature({ providers: {} })).not.toBe(baseline);
    expect(getOpenClawAppConfigSignature({ voice: { outputEnabled: true } })).not.toBe(baseline);
    expect(getOpenClawAppConfigSignature({ voice: { inputEnabled: true } })).not.toBe(baseline);
    expect(getOpenClawAppConfigSignature({ voice: { recognitionMode: 'online' } })).not.toBe(baseline);
  });

  it('only changes Control UI admission when both developer mode and its switch are enabled', () => {
    const baseline = getOpenClawAppConfigSignature({});

    expect(getOpenClawAppConfigSignature({ developerMode: true })).toBe(baseline);
    expect(getOpenClawAppConfigSignature({ controlUiEnabled: true })).toBe(baseline);
    expect(getOpenClawAppConfigSignature({
      developerMode: true,
      controlUiEnabled: true,
    })).not.toBe(baseline);
  });
});

describe('language model catalog additions', () => {
  const existingModel = { id: 'model-a', enabled: true };
  const addedModel = { id: 'team/model-b', enabled: true };
  const provider = {
    enabled: true,
    baseUrl: 'http://localhost:8000/v1',
    apiKey: 'test-key',
    models: [existingModel],
  };
  const previous = { providers: { custom: provider } };
  const appendedProvider = { ...provider, models: [existingModel, addedModel] };

  it.each([true, false])('identifies an append with an unchanged sign-in state (%s)', signedIn => {
    const builtin = signedIn ? { builtin_models: { models: [{ id: 'builtin-a' }] } } : {};
    const before = { providers: { ...builtin, custom: provider } };
    const after = { language: 'zh', providers: { ...builtin, custom: appendedProvider } };

    expect(getLanguageModelCatalogAdditions(before, after)).toEqual([
      { providerKey: 'custom', modelIds: ['team/model-b'] },
    ]);
  });

  it.each([
    ['a duplicate ID', existingModel],
    ['a padded ID', { id: ' padded' }],
    ['a disabled model', { ...addedModel, enabled: false }],
  ])('leaves %s to ordinary configuration synchronization', (_description, model) => {
    const next = { providers: { custom: { ...provider, models: [existingModel, model] } } };

    expect(getLanguageModelCatalogAdditions(previous, next)).toBeUndefined();
  });

  it('leaves changes to existing models, credentials and other runtime settings to ordinary synchronization', () => {
    const editedModel = { ...existingModel, id: 'renamed-model' };

    expect(getLanguageModelCatalogAdditions(previous, {
      providers: { custom: { ...appendedProvider, models: [editedModel, addedModel] } },
    })).toBeUndefined();
    expect(getLanguageModelCatalogAdditions(previous, {
      providers: { custom: { ...appendedProvider, apiKey: 'replacement-key' } },
    })).toBeUndefined();
    expect(getLanguageModelCatalogAdditions(previous, {
      language: 'en', providers: { custom: appendedProvider },
    })).toBeUndefined();
  });

  it('requires an existing eligible model and preserves provider identity and order', () => {
    const emptyProvider = { ...provider, models: [{ ...existingModel, enabled: false }] };
    const otherProvider = { ...provider, models: [{ id: 'other-model' }] };

    expect(getLanguageModelCatalogAdditions(
      { providers: { custom: emptyProvider } },
      { providers: { custom: { ...emptyProvider, models: [...emptyProvider.models, addedModel] } } },
    )).toBeUndefined();
    expect(getLanguageModelCatalogAdditions(previous, {
      providers: { other: appendedProvider },
    })).toBeUndefined();
    expect(getLanguageModelCatalogAdditions(
      { providers: { custom: provider, other: otherProvider } },
      { providers: { other: otherProvider, custom: appendedProvider } },
    )).toBeUndefined();
    expect(getLanguageModelCatalogAdditions(
      { providers: { builtin_models: provider } },
      { providers: { builtin_models: appendedProvider } },
    )).toBeUndefined();
  });
});
