import { describe, expect, it, vi } from 'vitest';

import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import { discoverExtensionMcpServers, parseExtensionMcpInventory } from './extensionMcpDiscovery';

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

  it('uses the OpenClaw plugin inspection JSON command', async () => {
    const manager = {
      buildCliEnvironment: vi.fn(async () => ({
        env: {
          OPENCLAW_STATE_DIR: 'state',
          JUSTDO_ELECTRON_PATH: 'electron-node-runtime',
        },
        runtimeRoot: 'runtime',
        openclawEntry: 'openclaw.mjs',
      })),
    } as unknown as OpenClawEngineManager;
    const commandRunner = vi.fn(async () => ({ stdout: '[]' }));

    await expect(discoverExtensionMcpServers(manager, commandRunner)).resolves.toEqual([]);
    expect(commandRunner).toHaveBeenCalledWith(
      'electron-node-runtime',
      ['openclaw.mjs', 'plugins', 'inspect', '--all', '--json'],
      {
        cwd: 'runtime',
        env: {
          OPENCLAW_STATE_DIR: 'state',
          JUSTDO_ELECTRON_PATH: 'electron-node-runtime',
          ELECTRON_RUN_AS_NODE: '1',
        },
      },
    );
  });
});
