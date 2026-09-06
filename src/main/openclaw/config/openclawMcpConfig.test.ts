import { describe, expect, it } from 'vitest';

import type { McpServerRecord } from '../../plugins/mcp';
import { buildOpenClawMcpServers } from './openclawConfigSync';

const record = (overrides: Partial<McpServerRecord>): McpServerRecord => ({
  id: 'id',
  name: 'server',
  description: '',
  enabled: true,
  transportType: 'stdio',
  isBuiltIn: false,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

describe('buildOpenClawMcpServers', () => {
  it('maps stdio configuration to OpenClaw native MCP configuration', () => {
    expect(
      buildOpenClawMcpServers([
        record({ command: 'npx', args: ['-y', 'example-mcp'], env: { TOKEN: 'secret' } }),
      ]),
    ).toEqual({
      server: {
        enabled: true,
        requestTimeoutMs: 60_000,
        command: 'npx',
        args: ['-y', 'example-mcp'],
        env: { TOKEN: 'secret' },
      },
    });
  });

  it('maps remote transports to OpenClaw transport names', () => {
    expect(
      buildOpenClawMcpServers(
        [
          record({
            name: 'events',
            transportType: 'sse',
            url: 'https://example.com/sse',
            requestTimeoutSeconds: 900,
          }),
          record({
            name: 'http',
            transportType: 'http',
            url: 'https://example.com/mcp',
            headers: { Authorization: 'Bearer token' },
          }),
        ],
        300,
      ),
    ).toEqual({
      events: {
        enabled: true,
        requestTimeoutMs: 900_000,
        url: 'https://example.com/sse',
        transport: 'sse',
      },
      http: {
        enabled: true,
        requestTimeoutMs: 300_000,
        url: 'https://example.com/mcp',
        transport: 'streamable-http',
        headers: { Authorization: 'Bearer token' },
      },
    });
  });

  it('preserves OpenClaw fields that the JustDo form does not model', () => {
    expect(
      buildOpenClawMcpServers([
        record({
          name: 'privateDocs',
          transportType: 'http',
          url: 'https://example.com/mcp',
          openClawConfig: {
            url: 'https://example.com/mcp',
            transport: 'streamable-http',
            requestTimeoutMs: 1_500,
            headers: { RetryCount: 3, Enabled: true },
            auth: 'oauth',
            oauth: { identity: 'per-requester' },
            toolFilter: { include: ['search_*'] },
          },
        }),
      ]),
    ).toEqual({
      privateDocs: {
        enabled: true,
        url: 'https://example.com/mcp',
        transport: 'streamable-http',
        requestTimeoutMs: 1_500,
        headers: { RetryCount: 3, Enabled: true },
        auth: 'oauth',
        oauth: { identity: 'per-requester' },
        toolFilter: { include: ['search_*'] },
      },
    });
  });
});
