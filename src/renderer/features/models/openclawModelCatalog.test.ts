import { describe, expect, test } from 'vitest';

import { enrichModelsFromOpenClawCatalog } from './openclawModelCatalog';

describe('enrichModelsFromOpenClawCatalog', () => {
  test('projects runtime availability and capabilities onto configured models', () => {
    const [model] = enrichModelsFromOpenClawCatalog(
      [
        {
          id: 'gpt-5',
          name: 'GPT 5',
          providerKey: 'custom_0',
          provider: 'Acme',
          supportsImage: false,
          contextLength: 32_000,
        },
      ],
      [
        {
          id: 'gpt-5',
          name: 'Runtime GPT 5',
          provider: 'acme',
          available: false,
          unavailableReason: 'cooldown',
          unavailableUntil: 123,
          contextWindow: 128_000,
          input: ['text', 'image'],
          reasoning: true,
          supportsTools: true,
        },
      ],
    );

    expect(model).toMatchObject({
      name: 'GPT 5',
      available: false,
      unavailableReason: 'cooldown',
      unavailableUntil: 123,
      supportsImage: true,
      contextLength: 128_000,
      reasoning: true,
      supportsTools: true,
    });
  });

  test('keeps local metadata when the runtime has no matching catalog row', () => {
    const models = [
      {
        id: 'local-model',
        name: 'Local model',
        providerKey: 'custom_0',
        provider: 'Acme',
        supportsImage: true,
      },
    ];

    expect(enrichModelsFromOpenClawCatalog(models, [])).toBe(models);
    expect(
      enrichModelsFromOpenClawCatalog(models, [
        { id: 'other', name: 'Other', provider: 'acme', available: false },
      ]),
    ).toEqual(models);
  });

  test('treats an explicit runtime input list as authoritative', () => {
    const [model] = enrichModelsFromOpenClawCatalog(
      [
        {
          id: 'text-only',
          name: 'Text only',
          providerKey: 'custom_0',
          provider: 'Acme',
          supportsImage: true,
        },
      ],
      [{ id: 'text-only', name: 'Text only', provider: 'acme', input: ['text'] }],
    );

    expect(model?.supportsImage).toBe(false);
  });
});
