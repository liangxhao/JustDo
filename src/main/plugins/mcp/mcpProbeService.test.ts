import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { beforeEach, expect, test, vi } from 'vitest';

import type { McpServerRecord } from './mcpStore';

const mocks = vi.hoisted(() => ({
  mcpProbeFetch: vi.fn(),
  stdioLaunch: vi.fn<(options: StdioServerParameters) => void>(),
  transportFetch: undefined as unknown,
  eventSourceFetch: undefined as unknown,
  tools: [] as unknown[],
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getAppPath: () => path.join(process.resourcesPath, 'app.asar'),
    getPath: () => path.join(process.resourcesPath, 'user-data'),
  },
}));

vi.mock('../../core/network/mainProcessFetch', () => ({
  mainProcessMcpProbeFetch: mocks.mcpProbeFetch,
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  getDefaultEnvironment: () => ({ PATH: 'C:\\Windows\\System32' }),
  StdioClientTransport: class {
    constructor(options: StdioServerParameters) {
      mocks.stdioLaunch(options);
    }

    async close() {}
  },
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
      return { tools: mocks.tools };
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

const buildServer = (transportType: McpServerRecord['transportType']): McpServerRecord => ({
  id: 'mcp-server',
  name: 'MCP server',
  description: '',
  enabled: true,
  transportType,
  ...(transportType === 'stdio'
    ? { command: 'python' }
    : { url: 'https://mcp.example/api', headers: { Authorization: 'Bearer server-token' } }),
  isBuiltIn: false,
  createdAt: 1,
  updatedAt: 1,
});

beforeEach(() => {
  mocks.stdioLaunch.mockClear();
  mocks.transportFetch = undefined;
  mocks.eventSourceFetch = undefined;
  mocks.tools = [];
});

test('starts a user MCP test with bundled Python ahead of the system PATH', async () => {
  const resourcesPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-probe-resources-'));
  const pythonRoot = path.join(resourcesPath, 'python-win');
  try {
    fs.mkdirSync(pythonRoot);
    vi.stubGlobal(
      'process',
      Object.create(process, {
        platform: { value: 'win32' },
        resourcesPath: { value: resourcesPath },
      }),
    );

    const result = await probeMcpServer({ ...buildServer('stdio'), env: { MCP_MODE: 'custom' } });

    expect(result.available).toBe(true);
    const launch = mocks.stdioLaunch.mock.calls[0]?.[0];
    expect(launch?.command).toBe('python');
    const pathEntries = launch?.env?.PATH?.split(';');
    expect(pathEntries?.[0]).toBe(pythonRoot);
    expect(pathEntries).toContain('C:\\Windows\\System32');
    expect(launch?.env?.MCP_MODE).toBe('custom');
  } finally {
    vi.unstubAllGlobals();
    fs.rmdirSync(pythonRoot);
    fs.rmdirSync(resourcesPath);
  }
});

test('projects interactive capability without copying unrelated tool metadata', async () => {
  mocks.tools = [{ name: 'diagram', _meta: { ui: { resourceUri: 'ui://diagram/view' }, unrelated: 'private' } }];
  const result = await probeMcpServer(buildServer('http'));
  expect(result.tools[0].uiResourceUri).toBe('ui://diagram/view');
  expect(result.tools[0]._meta).toBeUndefined();
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

test('tests a disabled user MCP without changing its saved definition', async () => {
  const server = { ...buildServer('http'), enabled: false };
  const before = structuredClone(server);
  const result = await probeMcpServer(server);

  expect(result.available).toBe(true);
  expect(server).toEqual(before);
});
