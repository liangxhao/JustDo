import { describe, expect, test } from 'vitest';

import { OpenClawExtensionId } from '../../../../shared/openclawExtensions';
import {
  buildBundledExtensionEntries,
  buildBundledExtensionToolContracts,
} from './openclawExtensionRegistry';

describe('buildBundledExtensionEntries', () => {
  test('builds configuration only for available extensions', () => {
    const entries = buildBundledExtensionEntries(
      {
        mcpBridge: {
          callbackUrl: 'http://localhost/mcp',
          askUserCallbackUrl: 'http://localhost/ask',
          secret: 'runtime-only',
          tools: [{ server: 'files', name: 'read', description: '', inputSchema: {} }],
        },
      },
      id => id === OpenClawExtensionId.MCP_BRIDGE,
    );

    expect(Object.keys(entries)).toEqual([OpenClawExtensionId.MCP_BRIDGE]);
    expect(entries[OpenClawExtensionId.MCP_BRIDGE]).toMatchObject({
      enabled: true,
      config: {
        callbackUrl: 'http://localhost/mcp',
        secret: '${JUSTDO_MCP_BRIDGE_SECRET}',
      },
    });
  });

  test('keeps extensions enabled before their host configuration is ready', () => {
    const entries = buildBundledExtensionEntries({ mcpBridge: null }, () => true);

    expect(entries).toEqual({
      [OpenClawExtensionId.MCP_BRIDGE]: { enabled: true },
      [OpenClawExtensionId.ASK_USER_QUESTION]: { enabled: true },
    });
  });

  test('builds deterministic unique tool contract names through descriptors', () => {
    const contracts = buildBundledExtensionToolContracts(
      {
        mcpBridge: {
          callbackUrl: 'http://localhost/mcp',
          askUserCallbackUrl: 'http://localhost/ask',
          secret: 'runtime-only',
          tools: [
            { server: 'My Server', name: 'Read File', description: '', inputSchema: {} },
            { server: 'My Server', name: 'Read File', description: '', inputSchema: {} },
          ],
        },
      },
      () => true,
    );

    expect(contracts).toEqual([
      {
        id: OpenClawExtensionId.MCP_BRIDGE,
        tools: ['mcp_my_server_read_file', 'mcp_my_server_read_file_2'],
      },
    ]);
  });
});
