import { describe, expect, test } from 'vitest';

import modelReducer, {
  setAvailableModels,
  setConfiguredModels,
  setSelectedModel,
} from './modelSlice';

describe('modelSlice', () => {
  test('projects the saved provider rename instead of selecting the first model', () => {
    const state = modelReducer(
      undefined,
      setSelectedModel({ id: 'shared', name: 'Old', providerKey: 'old' }),
    );
    const models = [
      { id: 'shared', name: 'Other', providerKey: 'other' },
      { id: 'shared', name: 'Renamed', providerKey: 'renamed' },
    ];

    const result = modelReducer(
      state,
      setConfiguredModels({ models, defaultModel: 'shared', defaultModelProvider: 'renamed' }),
    );

    expect(result.selectedModel).toEqual(models[1]);
  });

  test('refreshes the selected model from committed configuration instead of stale Redux state', () => {
    const state = modelReducer(
      undefined,
      setSelectedModel({ id: 'old', name: 'Old', providerKey: 'provider' }),
    );
    const models = [
      { id: 'old', name: 'Old', providerKey: 'provider' },
      { id: 'new', name: 'New', providerKey: 'provider' },
    ];

    const result = modelReducer(
      state,
      setConfiguredModels({ models, defaultModel: 'new', defaultModelProvider: 'provider' }),
    );

    expect(result.selectedModel).toEqual(models[1]);
  });

  test('clears a stale selected model when no models remain available', () => {
    const withSelectedModel = modelReducer(
      undefined,
      setSelectedModel({
        id: 'builtin-model',
        name: 'Built-in model',
        providerKey: 'builtin_models',
      }),
    );

    const result = modelReducer(withSelectedModel, setAvailableModels([]));

    expect(result.availableModels).toEqual([]);
    expect(result.selectedModel).toEqual({ id: '', name: '' });
  });

  test('keeps server models available when provider models are cleared', () => {
    const state = {
      selectedModel: {
        id: 'builtin-model',
        name: 'Built-in model',
        providerKey: 'builtin_models',
      },
      availableModels: [
        { id: 'server-model', name: 'Server model', isServerModel: true },
        { id: 'builtin-model', name: 'Built-in model', providerKey: 'builtin_models' },
      ],
    };

    const result = modelReducer(state, setAvailableModels([]));

    expect(result.availableModels).toEqual([
      { id: 'server-model', name: 'Server model', isServerModel: true },
    ]);
    expect(result.selectedModel).toEqual({
      id: 'server-model',
      name: 'Server model',
      isServerModel: true,
    });
  });
});
