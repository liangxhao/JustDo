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
      },
      {
        id: 'extension:calendar-bundle:remote-calendar',
        name: 'remote-calendar',
        providerId: 'calendar-bundle',
        providerName: 'Calendar Bundle',
        providerDescription: 'Calendar integration',
        enabled: true,
        supported: false,
      },
    ]);
  });

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
    expect(parseExtensionMcpInventory([makeEntry({ format: 'openclaw' })])).toEqual([]);
  });

  it('uses the OpenClaw plugin inspection JSON command', async () => {
    const manager = {
      buildCliEnvironment: vi.fn(async () => ({
        env: { OPENCLAW_STATE_DIR: 'state' },
        runtimeRoot: 'runtime',
        openclawEntry: 'openclaw.mjs',
      })),
    } as unknown as OpenClawEngineManager;
    const commandRunner = vi.fn(async () => ({ stdout: '[]' }));

    await expect(discoverExtensionMcpServers(manager, commandRunner)).resolves.toEqual([]);
    expect(commandRunner).toHaveBeenCalledWith(
      process.execPath,
      ['openclaw.mjs', 'plugins', 'inspect', '--all', '--json'],
      {
        cwd: 'runtime',
        env: { OPENCLAW_STATE_DIR: 'state' },
      },
    );
  });
});
