import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { McpServerRecord, McpStore } from './mcpStore';
import { discoverOpenClawManagedMcpServers } from './openclawMcpDiscovery';

const directories: string[] = [];

const writeConfig = (config: unknown): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-mcp-discovery-'));
  directories.push(directory);
  const configPath = path.join(directory, 'openclaw.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  return configPath;
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('discoverOpenClawManagedMcpServers', () => {
  test('imports externally installed servers and preserves native-only fields', () => {
    const configPath = writeConfig({
      mcp: {
        servers: {
          privateDocs: {
            enabled: false,
            url: 'https://mcp.example.test',
            transport: 'streamable-http',
            requestTimeoutMs: 90_000,
            auth: 'oauth',
            oauth: { identity: 'per-requester' },
            toolFilter: { include: ['search_*'] },
          },
        },
      },
    });
    const createDiscoveredServer = vi.fn(() => ({ id: 'persisted' }) as McpServerRecord);
    const store = {
      listServers: vi.fn(() => []),
      createDiscoveredServer,
    } as unknown as Pick<McpStore, 'listServers' | 'createDiscoveredServer'>;

    expect(discoverOpenClawManagedMcpServers(configPath, store)).toBe(1);
    expect(createDiscoveredServer).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'privateDocs',
        enabled: false,
        transportType: 'http',
        url: 'https://mcp.example.test',
        requestTimeoutSeconds: 90,
        openClawConfig: expect.objectContaining({
          auth: 'oauth',
          oauth: { identity: 'per-requester' },
          toolFilter: { include: ['search_*'] },
        }),
      }),
    );
  });

  test('does not duplicate a server already persisted by JustDo after restart', () => {
    const configPath = writeConfig({
      mcp: { servers: { docs: { command: 'npx', args: ['docs-mcp'] } } },
    });
    const store = {
      listServers: vi.fn(() => [{ name: 'docs' }]),
      createDiscoveredServer: vi.fn(),
    } as unknown as Pick<McpStore, 'listServers' | 'createDiscoveredServer'>;

    expect(discoverOpenClawManagedMcpServers(configPath, store)).toBe(0);
    expect(store.createDiscoveredServer).not.toHaveBeenCalled();
  });

  test('ignores malformed server entries without losing valid discoveries', () => {
    const configPath = writeConfig({
      mcp: {
        servers: {
          missingTransport: { enabled: true },
          local: { command: 'node', env: { PORT: 3210, DEBUG: true } },
        },
      },
    });
    const createDiscoveredServer = vi.fn(() => ({ id: 'persisted' }) as McpServerRecord);
    const store = {
      listServers: vi.fn(() => []),
      createDiscoveredServer,
    } as unknown as Pick<McpStore, 'listServers' | 'createDiscoveredServer'>;

    expect(discoverOpenClawManagedMcpServers(configPath, store)).toBe(1);
    expect(createDiscoveredServer).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'local', env: { PORT: '3210', DEBUG: 'true' } }),
    );
  });
});
