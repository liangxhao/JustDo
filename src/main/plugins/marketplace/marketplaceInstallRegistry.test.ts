import { expect, test } from 'vitest';

import { PluginKind } from '../../../shared/plugins/marketplace';
import {
  type MarketplaceInstallRecordStore,
  MarketplaceInstallRegistry,
} from './marketplaceInstallRegistry';

const createRegistry = () => {
  const values = new Map<string, unknown>();
  const store: MarketplaceInstallRecordStore = {
    get: <T>(key: string) => values.get(key) as T | undefined,
    set: <T>(key: string, value: T) => {
      values.set(key, value);
    },
  };
  return new MarketplaceInstallRegistry(() => store);
};

test('persists one marketplace identity per runtime plugin', () => {
  const registry = createRegistry();
  registry.upsert({
    sourceId: 'enterprise',
    kind: PluginKind.SKILL,
    marketplacePluginId: 'catalog-writer',
    runtimeId: 'writer',
    installedVersion: '1.0.0',
    installPath: 'C:\\skills\\writer',
  });

  expect(registry.list(PluginKind.SKILL)).toEqual([
    expect.objectContaining({ marketplacePluginId: 'catalog-writer', runtimeId: 'writer' }),
  ]);
});

test('only removes a layered skill identity when its install path matches', () => {
  const registry = createRegistry();
  registry.upsert({
    sourceId: 'enterprise',
    kind: PluginKind.SKILL,
    marketplacePluginId: 'catalog-writer',
    runtimeId: 'writer',
    installPath: 'C:\\managed\\skills\\writer',
  });

  registry.removeRuntime(PluginKind.SKILL, 'writer', 'C:\\project\\skills\\writer');
  expect(registry.list()).toHaveLength(1);

  registry.removeRuntime(
    PluginKind.SKILL,
    'writer',
    process.platform === 'win32' ? 'c:\\managed\\skills\\writer' : 'C:\\managed\\skills\\writer',
  );
  expect(registry.list()).toEqual([]);
});

test('ignores corrupt persisted records', () => {
  const values = new Map<string, unknown>([
    ['plugin_marketplace_installations_v1', [{ sourceId: 'enterprise', token: 'secret' }]],
  ]);
  const registry = new MarketplaceInstallRegistry(() => ({
    get: <T>(key: string) => values.get(key) as T | undefined,
    set: <T>(key: string, value: T) => values.set(key, value),
  }));

  expect(registry.list()).toEqual([]);
});

test('resolves only the exact installed directory without exporting local paths', () => {
  const registry = createRegistry();
  registry.upsert({
    sourceId: 'enterprise',
    kind: PluginKind.SKILL,
    marketplacePluginId: 'catalog-writer',
    runtimeId: 'writer',
    installPath: '/managed/writer',
  });
  expect(
    registry.resolve({
      kind: PluginKind.SKILL,
      installed: [{ id: 'writer', installPath: '/project/writer' }],
    }),
  ).toEqual([]);
  expect(registry.resolve({ kind: PluginKind.SKILL, installed: [{ id: 'writer' }] })).toEqual([]);
  expect(
    registry.resolve({
      kind: PluginKind.SKILL,
      installed: [{ id: 'writer', installPath: '/managed/writer' }],
    }),
  ).toEqual([{ sourceId: 'enterprise', pluginId: 'catalog-writer', runtimeId: 'writer' }]);
  expect(registry.resolve({ kind: PluginKind.SKILL, installed: [] })).toEqual([]);
});

test('rejects ambiguous inventory and resolves MCP through its runtime identity', () => {
  const registry = createRegistry();
  registry.upsert({
    sourceId: 'enterprise',
    kind: PluginKind.MCP,
    marketplacePluginId: 'catalog-mcp',
    runtimeId: 'generated-id',
  });
  expect(registry.resolve({ kind: PluginKind.MCP, installed: [{ id: 'catalog-mcp' }] })).toEqual(
    [],
  );
  expect(
    registry.resolve({
      kind: PluginKind.MCP,
      installed: [{ id: 'generated-id' }, { id: 'generated-id' }],
    }),
  ).toEqual([]);
  expect(registry.resolve({ kind: PluginKind.MCP, installed: [{ id: 'generated-id' }] })).toEqual([
    { sourceId: 'enterprise', pluginId: 'catalog-mcp', runtimeId: 'generated-id' },
  ]);
});
