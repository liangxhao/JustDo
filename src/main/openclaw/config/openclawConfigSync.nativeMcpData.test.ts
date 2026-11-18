import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { EnginePhase } from '../../../shared/openclaw/engineStatus';
import type { NativeMcpDataBinding } from '../../plugins/data/nativeMcpData';
import { nativeMcpDataDirectory } from '../../plugins/data/nativeMcpData';
import { OpenClawConfigSyncService } from './openclawConfigSyncService';

const roots: string[] = [];
const binding = {
  pluginId: 'documents-app',
  servers: {
    documents: { command: 'node', args: ['./server.cjs'], env: { PLUGIN_DATA: '${PLUGIN_DATA}' } },
  },
} satisfies NativeMcpDataBinding;

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('native-mcp-change-'))
      throw new Error('Unexpected test profile location');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture({ offline = false, unavailable = false } = {}) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'native-mcp-change-'));
  roots.push(state);
  const configPath = path.join(state, 'openclaw.json');
  const original = {
    plugins: { entries: { [binding.pluginId]: { enabled: true } } },
    mcp: {
      apps: { enabled: true },
      servers: { independent: { command: 'node', args: ['custom.cjs'] } },
    },
  };
  const write = (config: unknown) => fs.writeFileSync(configPath, JSON.stringify(config));
  const read = () => JSON.parse(fs.readFileSync(configPath, 'utf8'));
  write(original);
  let processGeneration = 4;
  const waitForReload = vi.fn(async () => true);
  const request = vi.fn(async () => {
    const content = fs.readFileSync(configPath, 'utf8');
    const revision = createHash('sha256').update(content).digest('hex');
    const projection = JSON.parse(content);
    if (projection.mcp.servers.documents?.env)
      projection.mcp.servers.documents.env.PLUGIN_DATA = '__OPENCLAW_REDACTED__';
    return { valid: true, configRevisionHash: revision, appliedConfigHash: revision, sourceConfig: projection };
  });
  const client = offline || unavailable ? null : { request };
  const discover = vi.fn<() => Promise<readonly NativeMcpDataBinding[]>>(async () => [binding]);
  const manager = {
    getConfigPath: () => configPath,
    getStateDir: () => state,
    getStatus: () => ({ phase: offline ? EnginePhase.Ready : EnginePhase.Running }),
    getGatewayProcessId: () => offline ? null : 808,
    getGatewayProcessGeneration: () => processGeneration,
    getGatewayLifecycleGeneration: () => 2,
    getGatewayConfigReloadGeneration: () => 7,
    waitForGatewayConfigReload: waitForReload,
    startGateway: vi.fn(),
    stopGateway: vi.fn(),
    restartGateway: vi.fn(),
  };
  const connectGatewayClient = vi.fn();
  const service = new OpenClawConfigSyncService({
    getOpenClawEngineManager: () => manager,
    getGatewayClient: () => client,
    getMcpStore: () => ({ listServers: () => [] }),
    getNativeMcpDataBindings: discover,
    connectGatewayClient,
  } as never);
  const expectNoRuntimeMutation = () => {
    expect(manager.startGateway).not.toHaveBeenCalled();
    expect(manager.stopGateway).not.toHaveBeenCalled();
    expect(manager.restartGateway).not.toHaveBeenCalled();
    expect(connectGatewayClient).not.toHaveBeenCalled();
  };
  return {
    service, state, configPath, original, read, write, discover, request, waitForReload,
    expectNoRuntimeMutation,
    replaceProcess: () => { processGeneration += 1; },
  };
}

it('applies the owned data directory online and withdraws the same projection after disable', async () => {
  const f = fixture();
  await expect(f.service.syncNativeMcpDataAfterMutation()).resolves.toBe(true);
  const directory = nativeMcpDataDirectory(f.state, binding.pluginId);
  expect(f.read()).toEqual({
    plugins: { entries: { [binding.pluginId]: { enabled: true, config: { dataDirectory: directory } } } },
    mcp: {
      ...f.original.mcp,
      servers: { ...f.original.mcp.servers, documents: { ...binding.servers.documents, env: { PLUGIN_DATA: directory } } },
    },
  });
  expect(f.request.mock.calls).toEqual([
    ['config.get', {}, { timeoutMs: 5_000 }],
    ['config.get', {}, { timeoutMs: 5_000 }],
  ]);
  expect(f.waitForReload).toHaveBeenCalledOnce();
  f.request.mockClear();
  await expect(f.service.syncNativeMcpDataAfterMutation()).resolves.toBe(false);
  expect(f.request).not.toHaveBeenCalled();

  const disabled = f.read();
  disabled.plugins.entries[binding.pluginId].enabled = false;
  f.write(disabled);
  f.discover.mockResolvedValue([]);
  await expect(f.service.syncNativeMcpDataAfterMutation()).resolves.toBe(true);
  expect(f.read().mcp).toEqual(f.original.mcp);
  expect(f.read().plugins.entries[binding.pluginId]).toEqual({ enabled: false, config: {} });
  expect(nativeMcpDataDirectory(f.state, binding.pluginId)).toBe(directory);
  f.expectNoRuntimeMutation();
});

it('does not touch configuration or Gateway for a catalog without managed data', async () => {
  const f = fixture({ unavailable: true });
  f.discover.mockResolvedValue([]);

  await expect(f.service.syncNativeMcpDataAfterMutation()).resolves.toBe(false);
  expect(f.read()).toEqual(f.original);
  expect(fs.existsSync(`${f.configPath}.plugin-data.json`)).toBe(false);
  expect(f.request).not.toHaveBeenCalled();
  expect(f.waitForReload).not.toHaveBeenCalled();
  f.expectNoRuntimeMutation();
});

it('publishes for a later startup while the engine is proven offline', async () => {
  const f = fixture({ offline: true });

  await expect(f.service.syncNativeMcpDataAfterMutation()).resolves.toBe(true);
  expect(f.read().mcp.servers.documents.env.PLUGIN_DATA).toBe(nativeMcpDataDirectory(f.state, binding.pluginId));
  expect(f.request).not.toHaveBeenCalled();
  expect(f.waitForReload).not.toHaveBeenCalled();
  f.expectNoRuntimeMutation();
});

it('preserves an operator-modified server and removes only matching generated settings', async () => {
  const f = fixture({ offline: true });
  await expect(f.service.syncNativeMcpDataAfterMutation()).resolves.toBe(true);
  const modified = f.read();
  modified.mcp.servers.documents.args = ['edited.cjs'];
  f.write(modified);
  f.discover.mockResolvedValue([]);

  await expect(f.service.syncNativeMcpDataAfterMutation()).resolves.toBe(true);
  expect(f.read().mcp.servers.documents).toEqual(modified.mcp.servers.documents);
  expect(f.read().plugins.entries[binding.pluginId].config).toEqual({});
  f.expectNoRuntimeMutation();
});

it('does not publish a generated definition over an operator-owned MCP include', async () => {
  const f = fixture({ offline: true });
  const included = { documents: { command: 'node', args: ['user-owned.cjs'] } };
  const includePath = path.join(f.state, 'servers.json');
  fs.writeFileSync(includePath, JSON.stringify(included));
  const config = { ...f.original, mcp: { ...f.original.mcp, servers: { $include: 'servers.json' } } };
  f.write(config);

  await expect(f.service.syncNativeMcpDataAfterMutation()).rejects.toThrow('owned by an included file');
  expect(f.read()).toEqual(config);
  expect(JSON.parse(fs.readFileSync(includePath, 'utf8'))).toEqual(included);
  expect(fs.existsSync(`${f.configPath}.plugin-data.json`)).toBe(false);
  f.expectNoRuntimeMutation();
});

it('leaves a newer configuration untouched if the source changes during discovery', async () => {
  const f = fixture();
  const newest = { ...f.original, logging: { level: 'debug' } };
  f.discover.mockImplementationOnce(async () => {
    f.write(newest);
    return [binding];
  });

  await expect(f.service.syncNativeMcpDataAfterMutation()).rejects.toThrow('could not be confirmed');
  expect(f.read()).toEqual(newest);
  expect(fs.existsSync(`${f.configPath}.plugin-data.json`)).toBe(false);
  expect(f.request).not.toHaveBeenCalled();
  f.expectNoRuntimeMutation();
});

it('refuses a stale applied revision and keeps the published configuration without restarting', async () => {
  const f = fixture();
  const before = { valid: true, configRevisionHash: 'old', appliedConfigHash: 'old', sourceConfig: f.original };
  f.request.mockResolvedValue(before);

  await expect(f.service.syncNativeMcpDataAfterMutation()).rejects.toThrow('could not be confirmed');
  expect(f.read().mcp.servers.documents.env.PLUGIN_DATA).toBe(nativeMcpDataDirectory(f.state, binding.pluginId));
  expect(f.request).toHaveBeenCalledTimes(2);
  f.expectNoRuntimeMutation();
});

it('does not verify the published revision through a replacement engine', async () => {
  const f = fixture();
  f.waitForReload.mockImplementationOnce(async () => {
    f.replaceProcess();
    return true;
  });

  await expect(f.service.syncNativeMcpDataAfterMutation()).rejects.toThrow('could not be confirmed');
  expect(f.request).toHaveBeenCalledOnce();
  f.expectNoRuntimeMutation();
});
