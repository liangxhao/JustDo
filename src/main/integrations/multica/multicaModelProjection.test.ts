import { describe, expect, test } from 'vitest';

import {
  getMulticaModelDiscoveryKind,
  MULTICA_MODEL_CATALOG_ARGV,
  projectMulticaModelCatalog,
} from './multicaModelProjection';

const providers = JSON.stringify({
  custom0: {
    apiKey: 'must-not-cross',
    models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
  },
  nvidia: {
    models: [{ id: 'minimaxai/minimax-m3' }],
  },
});

describe('Multica model projection', () => {
  test('recognizes only the two model-discovery command shapes', () => {
    expect(getMulticaModelDiscoveryKind(['config', 'get', 'agents.list', '--json'])).toBe('config');
    expect(getMulticaModelDiscoveryKind(['agents', 'list', '--json'])).toBe('registry');
    expect(
      getMulticaModelDiscoveryKind(['config', 'get', 'models.providers', '--json']),
    ).toBeNull();
    expect(MULTICA_MODEL_CATALOG_ARGV).toEqual(['config', 'get', 'models.providers', '--json']);
  });

  test('projects configured models into unbranded temporary agents', () => {
    const configEntries = JSON.parse(projectMulticaModelCatalog(providers, 'config')!) as Array<{
      id: string;
      model: { primary: string };
      identity: { name: string };
    }>;
    const registryEntries = JSON.parse(
      projectMulticaModelCatalog(providers, 'registry')!,
    ) as Array<{ id: string; name: string; model: string }>;

    expect(configEntries).toHaveLength(2);
    expect(configEntries.map(entry => entry.model.primary)).toEqual([
      'custom0/deepseek-v4-flash',
      'nvidia/minimaxai/minimax-m3',
    ]);
    expect(configEntries[0]).toMatchObject({
      identity: { name: 'DeepSeek V4 Flash' },
    });
    expect(configEntries.some(entry => 'default' in entry)).toBe(false);
    expect(registryEntries.map(entry => entry.name)).toEqual([
      'DeepSeek V4 Flash',
      'minimaxai/minimax-m3',
    ]);
    expect(registryEntries.every(entry => /^model-[a-f0-9]{20}$/.test(entry.id))).toBe(true);
    expect(JSON.stringify({ configEntries, registryEntries })).not.toMatch(
      /justdo|scheduler|must-not-cross/i,
    );
  });

  test('fails closed for malformed provider output', () => {
    expect(projectMulticaModelCatalog('not json', 'registry')).toBeNull();
    expect(projectMulticaModelCatalog('[]', 'config')).toBeNull();
  });
});
