import { describe, expect, it } from 'vitest';

import type { McpServerRecord } from '../../mcp/mcpStore';
import { buildOpenClawMcpServers } from './openclawConfigSync';

const record = (overrides: Partial<McpServerRecord>): McpServerRecord => ({
  id: 'id',
  name: 'server',
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
        command: 'npx',
        args: ['-y', 'example-mcp'],
        env: { TOKEN: 'secret' },
      },
    });
  });

  it('maps remote transports to OpenClaw transport names', () => {
    expect(
      buildOpenClawMcpServers([
        record({ name: 'events', transportType: 'sse', url: 'https://example.com/sse' }),
        record({
          name: 'http',
          transportType: 'http',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'Bearer token' },
        }),
      ]),
    ).toEqual({
      events: { enabled: true, url: 'https://example.com/sse', transport: 'sse' },
      http: {
        enabled: true,
        url: 'https://example.com/mcp',
        transport: 'streamable-http',
        headers: { Authorization: 'Bearer token' },
      },
    });
  });
});
