import { beforeEach, expect, test, vi } from 'vitest';

import type { McpServerRecord } from './mcpStore';

const mocks = vi.hoisted(() => ({
  mcpProbeFetch: vi.fn(),
  transportFetch: undefined as unknown,
  eventSourceFetch: undefined as unknown,
}));

vi.mock('../../core/mainProcessFetch', () => ({
  mainProcessMcpProbeFetch: mocks.mcpProbeFetch,
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    constructor(_url: URL, options: { fetch?: unknown }) {
      mocks.transportFetch = options.fetch;
    }

    async close() {}
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class {
    constructor(_url: URL, options: { fetch?: unknown; eventSourceInit?: { fetch?: unknown } }) {
      mocks.transportFetch = options.fetch;
      mocks.eventSourceFetch = options.eventSourceInit?.fetch;
    }

    async close() {}
  },
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    async connect() {}
    async ping() {}
    async listTools() {
      return { tools: [] };
    }
    async listResources() {
      return { resources: [] };
    }
    async listPrompts() {
      return { prompts: [] };
    }
    async readResource() {
      return { contents: [] };
    }
    getServerVersion() {
      return undefined;
    }
    getInstructions() {
      return undefined;
    }
    getServerCapabilities() {
      return {};
    }
  },
}));

import { probeMcpServer, readMcpResource } from './mcpProbeService';

const buildServer = (transportType: 'http' | 'sse'): McpServerRecord => ({
  id: 'mcp-server',
  name: 'MCP server',
  description: '',
  enabled: true,
  transportType,
  url: 'https://mcp.example/api',
  headers: { Authorization: 'Bearer server-token' },
  isBuiltIn: false,
  createdAt: 1,
  updatedAt: 1,
});

beforeEach(() => {
  mocks.transportFetch = undefined;
  mocks.eventSourceFetch = undefined;
});

test.each(['http', 'sse'] as const)(
  'routes %s MCP probe transport requests through the outbound-header fetch',
  async transportType => {
    const result = await probeMcpServer(buildServer(transportType));

    expect(result.available).toBe(true);
    expect(mocks.transportFetch).toBe(mocks.mcpProbeFetch);
    if (transportType === 'sse') {
      expect(mocks.eventSourceFetch).toBe(mocks.mcpProbeFetch);
    }
  },
);

test('keeps ordinary MCP resource reads outside the probe-only outbound-header path', async () => {
  await readMcpResource(buildServer('http'), 'resource://example');

  expect(mocks.transportFetch).toBeUndefined();
});
