import { expect, it } from 'vitest';

import type { ProviderRawConfig } from '../../providers/providerApiConfig';
import { buildMulticaModelCatalog } from './multicaModelCatalog';

it('uses native custom-provider identity, qualified model IDs, names and default selection', () => {
  const providers: ProviderRawConfig[] = [
    {
      providerName: 'custom_one',
      displayName: 'AcmeProxy',
      baseURL: 'https://example.invalid/v1',
      apiKey: 'test-key',
      apiType: 'openai',
      models: [
        { id: 'vendor/model', name: 'Model One', enabled: true },
        { id: 'disabled', name: 'Disabled', enabled: false },
        { id: 'vendor/model', name: 'Duplicate', enabled: true },
      ],
      embeddingModels: [{ id: 'embedding', name: 'Embedding' }],
    },
  ];
  expect(buildMulticaModelCatalog(providers, 'acmeproxy/vendor/model')).toEqual([
    {
      id: 'acmeproxy/vendor/model',
      name: 'Model One (AcmeProxy)',
      isDefault: true,
    },
  ]);
});

it('keeps identically named models from different providers distinct and exposes no credentials', () => {
  const provider = (providerName: string): ProviderRawConfig => ({
    providerName,
    baseURL: 'https://example.invalid/v1',
    apiKey: 'private-test-key',
    apiType: 'openai',
    models: [{ id: 'same', name: 'Same model' }],
    embeddingModels: [],
  });
  const models = buildMulticaModelCatalog(
    [provider('openai'), provider('opencode')],
    'opencode/same',
  );
  expect(models.map(model => model.id)).toEqual(['openai/same', 'opencode/same']);
  expect(models.map(model => model.isDefault)).toEqual([false, true]);
  expect(JSON.stringify(models)).not.toContain('private-test-key');
  expect(JSON.stringify(models)).not.toContain('example.invalid');
});
