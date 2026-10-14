#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const runtimeInfo = () => ({
  startedByNpx: process.env.npm_command === 'exec',
  electronNodeMode: process.env.ELECTRON_RUN_AS_NODE === '1',
  windowsHidePreload: spawn.name === 'hiddenWindowsSpawn',
  nodeVersion: process.versions.node,
  electronVersion: process.versions.electron ?? null,
  platform: process.platform,
});

// Used only to prime the offline npm cache before configuring the application.
if (process.argv.includes('--self-check')) {
  process.stdout.write(JSON.stringify(runtimeInfo()) + '\n');
} else {
  const tools = [
    {
      name: 'npx_smoke_echo',
      description: 'Echo a short test message without accessing files or the network.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', maxLength: 4096 } },
        required: ['text'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'npx_smoke_runtime_info',
      description: 'Report whether npx, Electron Node mode and the Windows preload are active.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
  ];
  const error = (code, message) => ({ error: { code, message } });
  const result = value => ({ result: value });
  const textResult = text => result({ content: [{ type: 'text', text }] });

  const handle = request => {
    if (request.method === 'initialize') {
      return result({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mcp-npx-smoke', version: '0.0.1' },
      });
    }
    if (request.method === 'ping') return result({});
    if (request.method === 'tools/list') return result({ tools });
    if (request.method === 'tools/call') {
      const { name, arguments: args = {} } = request.params ?? {};
      if (!args || typeof args !== 'object' || Array.isArray(args))
        return error(-32602, 'Tool arguments must be an object.');
      if (name === 'npx_smoke_runtime_info' && Object.keys(args).length === 0)
        return textResult(JSON.stringify(runtimeInfo()));
      if (
        name === 'npx_smoke_echo' &&
        typeof args.text === 'string' &&
        args.text.length <= 4096 &&
        Object.keys(args).length === 1
      )
        return textResult(args.text);
      return error(-32602, 'Unknown tool or invalid tool arguments.');
    }
    return error(-32601, 'Method not found.');
  };

  // Standard MCP newline-delimited JSON-RPC. Never print diagnostics to stdout.
  createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      process.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', id: null, ...error(-32700, 'Parse error.') }) + '\n',
      );
      return;
    }
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request?.id ?? null,
          ...error(-32600, 'Invalid request.'),
        }) + '\n',
      );
      return;
    }
    if (request.id === undefined) return;
    process.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: request.id, ...handle(request) }) + '\n',
    );
  });
}
