import { describe, expect, test } from 'vitest';

import modelReducer, { setAvailableModels, setSelectedModel } from './modelSlice';

describe('modelSlice', () => {
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
