import path from 'node:path';

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
      buildOpenClawMcpServers(
        [record({ command: 'npx', args: ['-y', 'example-mcp'], env: { TOKEN: 'secret' } })],
        60,
        null,
      ),
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

  it('projects the effective Windows package command without mutating stored MCP settings', () => {
    const runtime = {
      electronPath: 'C:\\App 中文\\desktop.exe',
      npmBinDir: 'C:\\App 中文\\resources\\app.asar\\node_modules\\npm\\bin',
      preloadPath: 'C:\\User Data\\cowork\\bin\\hide-child-process-windows.cjs',
    };
    const server = record({
      command: 'npm',
      args: ['ignored'],
      openClawConfig: {
        command: 'NPX.cmd',
        args: ['-y', 'example-mcp', 'argument with spaces'],
        env: { TOKEN: 'fixture-token', RETRY_COUNT: 3 },
        cwd: 'C:\\Project 中文',
        toolFilter: { include: ['search_*'] },
      },
    });
    const before = structuredClone(server);
    const config = buildOpenClawMcpServers([server], 60, runtime).server;
    expect(config).toMatchObject({
      command: runtime.electronPath,
      args: [
        '--require',
        runtime.preloadPath,
        path.join(runtime.npmBinDir, 'npx-cli.js'),
        '-y',
        'example-mcp',
        'argument with spaces',
      ],
      env: { TOKEN: 'fixture-token', RETRY_COUNT: 3, ELECTRON_RUN_AS_NODE: '1' },
      cwd: 'C:\\Project 中文',
      toolFilter: { include: ['search_*'] },
    });
    expect(server).toEqual(before);
  });

  it('keeps explicit executables and remote transports out of package-runner projection', () => {
    const runtime = {
      electronPath: 'electron.exe',
      npmBinDir: 'npm-bin',
      preloadPath: 'preload.cjs',
    };
    const configs = buildOpenClawMcpServers(
      [
        record({ name: 'custom', command: 'C:\\Custom\\npx.cmd', args: ['custom'] }),
        record({ name: 'remote', transportType: 'http', url: 'https://example.com/mcp' }),
      ],
      60,
      runtime,
    );
    expect(configs.custom).toMatchObject({ command: 'C:\\Custom\\npx.cmd', args: ['custom'] });
    expect(configs.custom).not.toHaveProperty('env');
    expect(configs.remote).not.toHaveProperty('command');
    expect(configs.remote).not.toHaveProperty('env');
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
