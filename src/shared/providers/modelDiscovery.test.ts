import { describe, expect, test } from 'vitest';

import {
  combineProviderModelDiscovery,
  mergeDiscoveredProviderModels,
  parseProviderModelInfoResponse,
  parseProviderModelsResponse,
} from './modelDiscovery';

describe('modelDiscovery', () => {
  test('parses and combines listed models with optional capability metadata', () => {
    const listed = parseProviderModelsResponse({
      data: [{ id: 'chat-model' }, { id: 'embedding-model' }, { id: 'chat-model' }],
    });
    const info = parseProviderModelInfoResponse({
      data: [
        {
          model_name: 'chat-model',
          model_info: {
            mode: 'chat',
            supports_vision: false,
            max_input_tokens: 128_000,
            max_output_tokens: 8_000,
          },
        },
        {
          model_name: 'embedding-model',
          model_info: { mode: 'embedding' },
        },
      ],
    });

    expect(combineProviderModelDiscovery(listed, info)).toEqual({
      chatModels: [
        {
          id: 'chat-model',
          name: 'chat-model',
          mode: 'chat',
          supportsImage: false,
          contextLength: 128_000,
          maxTokens: 8_000,
        },
      ],
      embeddingModels: [{ id: 'embedding-model', name: 'embedding-model', mode: 'embedding' }],
    });
  });

  test('treats invalid payloads and missing capability fields as unavailable', () => {
    expect(parseProviderModelsResponse({ data: 'invalid' })).toEqual([]);
    expect(parseProviderModelInfoResponse({ data: [{ model_info: {} }] }).size).toBe(0);

    const info = parseProviderModelInfoResponse({
      data: [{ model_name: 'model', model_info: { supports_vision: 'yes' } }],
    }).get('model');
    expect(info).toEqual({
      id: 'model',
      name: 'model',
      supportsImage: undefined,
      contextLength: undefined,
      maxTokens: undefined,
      mode: undefined,
    });
  });

  test('uses the model list only for ids and names', () => {
    expect(
      parseProviderModelsResponse({
        data: [
          {
            id: 'model-a',
            display_name: 'Model A',
            context_length: 128_000,
            supports_vision: true,
          },
        ],
      }),
    ).toEqual([{ id: 'model-a', name: 'Model A' }]);
  });

  test('smart merges explicit metadata and preserves manual models and names', () => {
    const existing = [
      {
        id: 'existing',
        name: 'My custom name',
        supportsImage: true,
        contextLength: 64_000,
        maxTokens: 4_000,
      },
      { id: 'manual-only', name: 'Manual only', supportsImage: true },
      { id: 'old-embedding', name: 'Old embedding' },
    ];

    expect(
      mergeDiscoveredProviderModels(existing, [
        { id: 'existing', name: 'Server name', supportsImage: false, maxTokens: 8_000 },
        { id: 'old-embedding', name: 'Old embedding', mode: 'embedding' },
        { id: 'new-model', name: 'New model' },
      ]),
    ).toEqual([
      {
        id: 'existing',
        name: 'My custom name',
        supportsImage: false,
        contextLength: 64_000,
        maxTokens: 8_000,
      },
      { id: 'manual-only', name: 'Manual only', supportsImage: true },
      {
        id: 'new-model',
        name: 'New model',
        enabled: true,
        capabilitiesConfirmed: false,
      },
    ]);
  });
});
