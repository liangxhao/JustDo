import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';

import type { McpServerRecord } from './mcpStore';

const MCP_PROBE_TIMEOUT_MS = 8_000;
const MCP_PROBE_REQUEST_TIMEOUT_MS = 3_000;

export interface McpProbeTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  [key: string]: unknown;
}

export interface McpProbeResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  [key: string]: unknown;
}

export interface McpResourceContent {
  uri?: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  [key: string]: unknown;
}

export interface McpReadResourceResult {
  contents: McpResourceContent[];
}

export interface McpProbePrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
  [key: string]: unknown;
}

export interface McpProbeResult {
  available: boolean;
  serverName?: string;
  serverVersion?: string;
  instructions?: string;
  capabilities?: {
    tools: boolean;
    resources: boolean;
    prompts: boolean;
  };
  tools: McpProbeTool[];
  resources: McpProbeResource[];
  prompts: McpProbePrompt[];
  latencyMs: number;
  error?: string;
}

type McpProbeListKind = 'tools' | 'resources' | 'prompts';

const isMethodNotFoundError = (error: unknown): boolean => {
  if (error && typeof error === 'object' && 'code' in error) {
    return (error as { code?: unknown }).code === ErrorCode.MethodNotFound;
  }
  const message = String(error);
  return message.includes('-32601') || /method not found/i.test(message);
};

const toErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  return String(error);
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const listBestEffort = async <T>(
  listKind: McpProbeListKind,
  listPage: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>,
): Promise<T[]> => {
  const items: T[] = [];
  let cursor: string | undefined;
  try {
    do {
      const page = await listPage(cursor);
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
  } catch (error) {
    if (isMethodNotFoundError(error)) {
      return [];
    }
    console.warn(`[McpProbe] ${listKind} listing failed:`, toErrorMessage(error));
    return [];
  }
  return items;
};

const createTransport = (server: McpServerRecord): Transport => {
  if (server.transportType === 'stdio') {
    if (!server.command) {
      throw new Error('stdio MCP server command is required');
    }
    return new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      env: {
        ...getDefaultEnvironment(),
        ...(server.env ?? {}),
      },
      stderr: 'pipe',
    });
  }

  if (!server.url) {
    throw new Error('MCP server URL is required');
  }

  const requestInit = {
    headers: server.headers ?? {},
  };
  const url = new URL(server.url);
  if (server.transportType === 'sse') {
    return new SSEClientTransport(url, {
      eventSourceInit: {
        fetch: (input, init) => fetch(input, { ...init, ...requestInit }),
      },
      requestInit,
    });
  }

  return new StreamableHTTPClientTransport(url, {
    requestInit,
  });
};

const compactImplementationVersion = (version: { name?: string; version?: string } | undefined) => {
  if (!version) return {};
  return {
    serverName: version.name,
    serverVersion: version.version,
  };
};

export const probeMcpServer = async (server: McpServerRecord): Promise<McpProbeResult> => {
  const startedAt = Date.now();
  let transport: Transport | null = null;
  const client = new Client({ name: 'justdo-mcp-probe', version: '1.0.0' });

  try {
    transport = createTransport(server);
    await withTimeout(client.connect(transport), MCP_PROBE_TIMEOUT_MS, 'MCP connection');
    await client.ping({ timeout: MCP_PROBE_REQUEST_TIMEOUT_MS });

    const [tools, resources, prompts] = await Promise.all([
      listBestEffort('tools', async cursor => {
        const page = await client.listTools(
          cursor ? { cursor } : undefined,
          { timeout: MCP_PROBE_REQUEST_TIMEOUT_MS },
        );
        return {
          items: page.tools.map(tool => ({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
          })),
          nextCursor: page.nextCursor,
        };
      }),
      listBestEffort('resources', async cursor => {
        const page = await client.listResources(
          cursor ? { cursor } : undefined,
          { timeout: MCP_PROBE_REQUEST_TIMEOUT_MS },
        );
        return {
          items: page.resources.map(resource => ({ ...resource })),
          nextCursor: page.nextCursor,
        };
      }),
      listBestEffort('prompts', async cursor => {
        const page = await client.listPrompts(
          cursor ? { cursor } : undefined,
          { timeout: MCP_PROBE_REQUEST_TIMEOUT_MS },
        );
        return {
          items: page.prompts.map(prompt => ({ ...prompt })),
          nextCursor: page.nextCursor,
        };
      }),
    ]);

    return {
      available: true,
      ...compactImplementationVersion(client.getServerVersion()),
      instructions: client.getInstructions(),
      capabilities: {
        tools: Boolean(client.getServerCapabilities()?.tools),
        resources: Boolean(client.getServerCapabilities()?.resources),
        prompts: Boolean(client.getServerCapabilities()?.prompts),
      },
      tools,
      resources,
      prompts,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      available: false,
      tools: [],
      resources: [],
      prompts: [],
      latencyMs: Date.now() - startedAt,
      error: toErrorMessage(error),
    };
  } finally {
    try {
      await transport?.close();
    } catch (error) {
      console.warn('[McpProbe] transport close failed:', toErrorMessage(error));
    }
  }
};

export const readMcpResource = async (
  server: McpServerRecord,
  uri: string,
): Promise<McpReadResourceResult> => {
  let transport: Transport | null = null;
  const client = new Client({ name: 'justdo-mcp-resource-reader', version: '1.0.0' });

  try {
    transport = createTransport(server);
    await withTimeout(client.connect(transport), MCP_PROBE_TIMEOUT_MS, 'MCP connection');
    const result = await client.readResource(
      { uri },
      { timeout: MCP_PROBE_REQUEST_TIMEOUT_MS },
    );
    return {
      contents: result.contents.map(content => ({ ...content })),
    };
  } finally {
    try {
      await transport?.close();
    } catch (error) {
      console.warn('[McpProbe] transport close failed:', toErrorMessage(error));
    }
  }
};
