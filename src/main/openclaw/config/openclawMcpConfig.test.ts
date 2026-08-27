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
        timeout: 60,
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
      events: { enabled: true, timeout: 900, url: 'https://example.com/sse', transport: 'sse' },
      http: {
        enabled: true,
        timeout: 300,
        url: 'https://example.com/mcp',
        transport: 'streamable-http',
        headers: { Authorization: 'Bearer token' },
      },
    });
  });
});
