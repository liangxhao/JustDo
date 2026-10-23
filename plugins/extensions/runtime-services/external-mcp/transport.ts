import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { isPidDefinitelyDead, signalProcessTree } from 'openclaw/plugin-sdk/process-runtime';

import { type ExternalMcpServer, isExternalMcpPlatformSupported } from '../contracts/external-mcp';
import {
  MAX_CATALOG_BYTES,
  MAX_RESULT_BYTES,
  MAX_TOOLS,
  record,
  type RecordValue,
  REQUEST_TIMEOUT_MS,
  STARTUP_TIMEOUT_MS,
} from './validation';

export interface ExternalMcpCatalogTool {
  name: string;
  description?: string;
  inputSchema: RecordValue;
}

export interface ExternalMcpConnection {
  tools: ExternalMcpCatalogTool[];
  invoke(name: string, args: RecordValue, signal: AbortSignal): Promise<RecordValue>;
  close(): Promise<void>;
}

/** Each connection owns one configured process. No default servers or download paths. */
export async function connectExternalMcpServer(
  server: ExternalMcpServer,
  cwd: string,
  signal: AbortSignal,
  platform: string = process.platform,
): Promise<ExternalMcpConnection> {
  if (!isExternalMcpPlatformSupported(platform))
    throw new Error(
      'Session stdio MCP is unavailable on this platform: process-tree cleanup cannot be confirmed.',
    );
  const client = new Client(
    { name: 'external-agent-tools', version: '1.0.0' },
    {
      capabilities: {},
      // Discovery must start the requested program once, without sibling probes.
      versionNegotiation: { mode: 'legacy' },
      inputRequired: { autoFulfill: false },
      // Tool output schemas have independent $id and local-reference namespaces.
      jsonSchemaValidator: {
        getValidator: schema => new AjvJsonSchemaValidator().getValidator(schema),
      },
    },
  );
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: Object.fromEntries(server.env.map(entry => [entry.name, entry.value])),
    cwd,
    stderr: 'ignore',
    maxBufferSize: MAX_RESULT_BYTES,
  });
  let unavailable = false;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      unavailable = true;
      const pid = transport.pid;
      // Retire the owned tree while its leader still exists, before the SDK
      // closes stdin. This also handles wrappers around the actual MCP server.
      if (pid && !isPidDefinitelyDead(pid))
        await new Promise<void>(resolve =>
          signalProcessTree(pid, 'SIGKILL', { detached: false, onComplete: resolve }),
        );
      await client.close();
      if (pid && !isPidDefinitelyDead(pid))
        throw new Error('External MCP process cleanup could not be confirmed.');
    })();
    return closing;
  };
  client.onerror = () => {
    unavailable = true;
  };
  client.onclose = () => {
    unavailable = true;
  };
  try {
    await client.connect(transport, { signal, timeout: STARTUP_TIMEOUT_MS });
    const tools: ExternalMcpCatalogTool[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await client.listTools(cursor ? { cursor } : {}, {
        signal,
        timeout: STARTUP_TIMEOUT_MS,
        maxTotalTimeout: STARTUP_TIMEOUT_MS,
      });
      for (const tool of result.tools) {
        if (
          typeof tool.name !== 'string' ||
          !tool.name ||
          tool.name.length > 128 ||
          /[\0\r\n]/.test(tool.name) ||
          names.has(tool.name) ||
          !record(tool.inputSchema) ||
          tool.inputSchema.type !== 'object' ||
          tools.length >= MAX_TOOLS ||
          Buffer.byteLength(JSON.stringify(tool.inputSchema)) > 64 * 1024
        )
          throw new Error('Invalid external MCP catalog.');
        names.add(tool.name);
        tools.push({
          name: tool.name,
          ...(typeof tool.description === 'string'
            ? { description: tool.description.slice(0, 8192) }
            : {}),
          inputSchema: structuredClone(tool.inputSchema),
        });
      }
      if (Buffer.byteLength(JSON.stringify(tools)) > MAX_CATALOG_BYTES)
        throw new Error('External MCP catalog is too large.');
      cursor = result.nextCursor;
      if (cursor && (cursors.has(cursor) || cursors.size >= MAX_TOOLS))
        throw new Error('Invalid external MCP catalog cursor.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (signal.aborted || unavailable) throw new Error('External MCP connection is unavailable.');
    return {
      tools,
      async invoke(name, args, callSignal) {
        if (unavailable || callSignal.aborted || !names.has(name))
          throw new Error('External MCP connection is unavailable.');
        try {
          const result = await client.callTool(
            { name, arguments: args },
            {
              signal: callSignal,
              timeout: REQUEST_TIMEOUT_MS,
              maxTotalTimeout: REQUEST_TIMEOUT_MS,
            },
          );
          if (!record(result) || Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES)
            throw new Error('Invalid external MCP result.');
          return result;
        } catch {
          // A timeout/disconnect can follow real side effects. Retire this
          // connection and never replay a tool call under a new request ID.
          await close();
          throw new Error('External MCP call failed; its execution outcome may be unknown.');
        }
      },
      close,
    };
  } catch {
    await close();
    throw new Error('External MCP server could not be prepared.');
  }
}
