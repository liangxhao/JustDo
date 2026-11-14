import { describe, expect, it } from 'vitest';

import type { McpServerConfig } from './mcp';
import { parseMcpImport, serializeMcpExport, toMcpExportRow } from './mcpTransferFormat';

function parse(text: string) {
  const result = parseMcpImport(text);
  if (!result.success) throw new Error(result.code);
  return result.value;
}

const httpServer: McpServerConfig = {
  id: 'internal-id',
  name: 'internal-search',
  description: '搜索内部知识库',
  transportType: 'http',
  url: 'https://search.example.com/mcp',
  headers: { Authorization: 'Bearer sample-token' },
  requestTimeoutSeconds: 50,
  registryId: 'market-id',
  enabled: true,
  isBuiltIn: false,
  createdAt: 1,
  updatedAt: 2,
};

describe('MCP configuration transfer', () => {
  it('reads VS Code JSONC and leaves URL-only connections for explicit transport selection', () => {
    const result = parse(
      '\uFEFF' +
        [
          '{',
          '  // Credentials are supplied by the destination.',
          '  "servers": {',
          '    "lookup": {',
          '      "url": "https://example.com/mcp?token=sample",',
          '      "headers": {"Authorization": "Bearer \${input:secret}"},',
          '    },',
          '  },',
          '}',
        ].join('\n'),
    );

    expect(result).toMatchObject({
      format: 'servers',
      rows: [
        {
          preview: {
            name: 'lookup',
            connectionSummary: 'https://example.com/mcp?…',
            missingCredentials: ['Authorization'],
          },
          config: { url: 'https://example.com/mcp?token=sample' },
        },
      ],
    });
    expect(result.rows[0].config?.transportType).toBeUndefined();
    expect(result.rows[0].config?.headers).toEqual({ Authorization: '' });
    expect(JSON.stringify(result.rows[0].preview)).not.toContain('token=sample');
  });

  it('isolates ambiguous and unsupported rows without dropping a valid connection', () => {
    const result = parse(
      '{"mcpServers":{' +
        '"same":{"command":"one"},"same":{"command":"two"},' +
        '"guarded":{"type":"stdio","command":"node","sandboxEnabled":true},' +
        '"unsafe-map":{"command":"node","env":{"__proto__":"example"}},' +
        '"valid":{"type":"streamableHttp","url":"https://example.com/mcp","description":"Lookup"},' +
        '"local":{"command":"node","env":{"LOG_LEVEL":2}},' +
        '"unset":{"command":"node","env":{"LOG_LEVEL":null}}' +
        '}}',
    );

    expect(result.rows.map(row => row.preview.issue)).toEqual([
      'duplicate-name',
      'duplicate-name',
      'unsupported-fields',
      'invalid-config',
      undefined,
      undefined,
      'unsupported-fields',
    ]);
    expect(result.rows[4].config).toMatchObject({
      name: 'valid',
      transportType: 'http',
      description: 'Lookup',
    });
    expect(result.rows[5].config?.env).toEqual({ LOG_LEVEL: '2' });
  });

  it('round-trips a description and credential names without exporting credential values or local metadata', () => {
    const json = serializeMcpExport([httpServer]);

    expect(JSON.parse(json)).toEqual({
      mcpServers: {
        'internal-search': {
          type: 'http',
          url: 'https://search.example.com/mcp',
          description: '搜索内部知识库',
          headers: { Authorization: '' },
        },
      },
    });
    expect(parse(json).rows[0]).toMatchObject({
      preview: { missingCredentials: ['Authorization'] },
      config: { name: 'internal-search', description: '搜索内部知识库', transportType: 'http' },
    });
  });

  it('excludes native-only restrictions and connections with visible secrets from export', () => {
    expect(
      toMcpExportRow({
        ...httpServer,
        openClawConfig: { toolFilter: { allow: ['search'] } },
      }).issue,
    ).toBe('unsupported-fields');
    expect(
      toMcpExportRow({
        ...httpServer,
        url: 'https://search.example.com/mcp?api_key=sample',
      }).issue,
    ).toBe('sensitive-connection');
    const stdio = toMcpExportRow({
      ...httpServer,
      transportType: 'stdio',
      command: 'node',
      args: ['server.js', '--access-token', 'sample', '--signature=another'],
      url: undefined,
    });
    expect(stdio.issue).toBe('sensitive-connection');
    expect(stdio.connectionSummary).toBe(
      'node server.js --access-token [REDACTED] --signature=[REDACTED]',
    );
  });

  it('keeps environment and request header values independently and masks opt-in previews', () => {
    const stdioServer: McpServerConfig = {
      ...httpServer,
      name: 'local',
      transportType: 'stdio',
      command: 'node',
      env: { API_KEY: 'sample-key', EMPTY: '' },
    };
    const servers = [httpServer, stdioServer];
    const envOnly = JSON.parse(serializeMcpExport(servers, { includeEnvValues: true })).mcpServers;
    const headersOnly = JSON.parse(
      serializeMcpExport(servers, { includeHeaderValues: true }),
    ).mcpServers;
    const masked = JSON.parse(
      serializeMcpExport(servers, { includeEnvValues: true, includeHeaderValues: true }, true),
    ).mcpServers;

    expect(envOnly.local.env).toEqual(stdioServer.env);
    expect(envOnly['internal-search'].headers).toEqual({ Authorization: '' });
    expect(headersOnly.local.env).toEqual({ API_KEY: '', EMPTY: '' });
    expect(headersOnly['internal-search'].headers).toEqual(httpServer.headers);
    expect(masked.local.env).toEqual({ API_KEY: '••••', EMPTY: '' });
    expect(masked['internal-search'].headers).toEqual({ Authorization: '••••' });
  });
});
