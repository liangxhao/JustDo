import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import {
  discoverExtensionMcpOverrideNames,
  discoverExtensionMcpServers,
  parseExtensionMcpInventory,
} from './extensionMcpDiscovery';

it('does not prepare or inspect the native runtime when there are no extension overrides to retain', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ownership-'));
  try {
    const configPath = path.join(directory, 'openclaw.json');
    const manager = { getConfigPath: () => configPath } as OpenClawEngineManager;
    const discover = vi.fn();
    expect(await discoverExtensionMcpOverrideNames(manager, new Set(), discover)).toEqual(
      new Set(),
    );
    fs.writeFileSync(
      configPath,
      JSON.stringify({ mcp: { servers: { user: { command: 'node' } } } }),
    );
    expect(await discoverExtensionMcpOverrideNames(manager, new Set(['user']), discover)).toEqual(
      new Set(),
    );
    expect(discover).not.toHaveBeenCalled();
    fs.writeFileSync(configPath, '{ damaged JSON');
    expect(await discoverExtensionMcpOverrideNames(manager, new Set(), discover)).toEqual(
      new Set(),
    );
    expect(discover).not.toHaveBeenCalled();
    fs.writeFileSync(
      configPath,
      JSON.stringify({ mcp: { servers: { user: { command: 'node' } } } }),
    );
    discover.mockResolvedValue([{ name: 'plugin-server' }]);
    expect(await discoverExtensionMcpOverrideNames(manager, new Set(), discover)).toEqual(
      new Set(['plugin-server']),
    );
    discover.mockRejectedValue(new Error('metadata unavailable'));
    await expect(discoverExtensionMcpOverrideNames(manager, new Set(), discover)).rejects.toThrow(
      'metadata unavailable',
    );
  } finally {
    expect(path.dirname(path.resolve(directory))).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(directory).startsWith('mcp-ownership-')).toBe(true);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('parseExtensionMcpInventory', () => {
  it('returns MCP servers from enabled bundle extensions', () => {
    expect(
      parseExtensionMcpInventory([
        {
          plugin: {
            id: 'calendar-bundle',
            name: 'Calendar Bundle',
            description: 'Calendar integration',
            enabled: true,
            status: 'loaded',
            format: 'bundle',
            origin: 'bundled',
          },
          mcpServers: [
            { name: 'calendar', hasStdioTransport: true },
            { name: 'remote-calendar', hasStdioTransport: false },
          ],
        },
      ]),
    ).toEqual([
      {
        id: 'extension:calendar-bundle:calendar',
        name: 'calendar',
        providerId: 'calendar-bundle',
        providerName: 'Calendar Bundle',
        providerDescription: 'Calendar integration',
        enabled: true,
        supported: true,
        scope: 'system',
      },
      {
        id: 'extension:calendar-bundle:remote-calendar',
        name: 'remote-calendar',
        providerId: 'calendar-bundle',
        providerName: 'Calendar Bundle',
        providerDescription: 'Calendar integration',
        enabled: true,
        supported: true,
        scope: 'system',
      },
    ]);
  });

  it.each(['bundle', 'openclaw'])(
    'uses native transport support flags for %s extension MCP servers',
    format => {
      expect(
        parseExtensionMcpInventory([
          {
            plugin: { id: 'transport-demo', format, origin: 'global', enabled: true },
            mcpServers: [
              { name: 'stdio', hasStdioTransport: true },
              { name: 'http', hasStdioTransport: false },
              { name: 'invalid', hasStdioTransport: false, unsupported: true },
            ],
          },
        ]).map(({ name, supported }) => ({ name, supported })),
      ).toEqual([
        { name: 'stdio', supported: true },
        { name: 'http', supported: true },
        { name: 'invalid', supported: false },
      ]);
    },
  );

  it('keeps MCP servers from disabled or failed bundles as inactive', () => {
    const makeEntry = (overrides: Record<string, unknown>) => ({
      plugin: {
        id: 'ignored',
        enabled: true,
        status: 'loaded',
        format: 'bundle',
        ...overrides,
      },
      mcpServers: [{ name: 'server', hasStdioTransport: true }],
    });

    expect(parseExtensionMcpInventory([makeEntry({ enabled: false })])).toMatchObject([
      { name: 'server', enabled: false },
    ]);
    expect(parseExtensionMcpInventory([makeEntry({ status: 'error' })])).toMatchObject([
      { name: 'server', enabled: false },
    ]);
    expect(parseExtensionMcpInventory([makeEntry({ format: 'unknown' })])).toEqual([]);
  });

  it('returns native extension MCP servers with parent-owned enablement', () => {
    const makeEntry = (enabled: boolean) => ({
      plugin: {
        id: 'plugin-smoke-demo',
        name: 'Plugin Smoke Demo',
        format: 'openclaw',
        origin: 'global',
        enabled,
        status: enabled ? 'loaded' : 'disabled',
      },
      mcpServers: [{ name: 'plugin-smoke-demo', hasStdioTransport: true }],
    });

    expect(parseExtensionMcpInventory([makeEntry(true)])).toEqual([
      {
        id: 'extension:plugin-smoke-demo:plugin-smoke-demo',
        name: 'plugin-smoke-demo',
        providerId: 'plugin-smoke-demo',
        providerName: 'Plugin Smoke Demo',
        providerDescription: '',
        enabled: true,
        supported: true,
        scope: 'personal',
      },
    ]);
    expect(parseExtensionMcpInventory([makeEntry(false)])).toMatchObject([{ enabled: false }]);
  });

  it('keeps user bundle MCP servers out of the system scope', () => {
    expect(
      parseExtensionMcpInventory([
        {
          plugin: { id: 'user-bundle', format: 'bundle', origin: 'workspace', enabled: true },
          mcpServers: [{ name: 'echo', hasStdioTransport: true }],
        },
      ]),
    ).toMatchObject([{ scope: 'personal', enabled: true }]);
  });

  it('reads native MCP metadata without loading the plugin CLI or entry modules', async () => {
    const manager = {
      buildCliEnvironment: vi.fn(async () => ({
        env: {
          OPENCLAW_STATE_DIR: 'state',
          JUSTDO_ELECTRON_PATH: process.execPath,
        },
        runtimeRoot: 'runtime',
        openclawEntry: 'openclaw.mjs',
      })),
    } as unknown as OpenClawEngineManager;
    const commandRunner = vi.fn(async () => ({ stdout: 'JUSTDO_EXTENSION_MCP=[]' }));

    await expect(discoverExtensionMcpServers(manager, commandRunner)).resolves.toEqual([]);
    expect(commandRunner).toHaveBeenCalledWith(
      process.execPath,
      ['--input-type=module', '-e', expect.stringContaining('loadPluginManifestRegistryCore')],
      {
        cwd: 'runtime',
        env: {
          OPENCLAW_STATE_DIR: 'state',
          JUSTDO_ELECTRON_PATH: process.execPath,
          ELECTRON_RUN_AS_NODE: '1',
          JUSTDO_EXTENSION_MCP_MODE: 'list',
          JUSTDO_EXTENSION_MCP_ID: '',
          JUSTDO_EXTENSION_MCP_URI: '',
        },
      },
    );
  });
});
