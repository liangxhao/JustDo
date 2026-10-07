import { expect, test, vi } from 'vitest';

import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import { runExtensionMcpOperation } from './extensionMcpRuntime';
import { McpServices } from './mcpServices';

vi.mock('./extensionMcpRuntime', () => ({ runExtensionMcpOperation: vi.fn() }));

test('routes extension probes and resource reads to native ownership without creating stored MCP records', async () => {
  const manager = {} as OpenClawEngineManager;
  const getDatabase = vi.fn();
  const services = new McpServices({
    getDatabase,
    getManager: () => manager,
    syncOpenClawConfig: vi.fn(),
  });
  vi.mocked(runExtensionMcpOperation)
    .mockResolvedValueOnce({ available: true })
    .mockResolvedValueOnce({ contents: [] });
  expect(await services.probeServer('extension:plugin:echo')).toEqual({ available: true });
  expect(await services.readResource('extension:plugin:echo', 'fixture://data')).toEqual({
    contents: [],
  });
  expect(runExtensionMcpOperation).toHaveBeenNthCalledWith(
    1,
    manager,
    'probe',
    'extension:plugin:echo',
  );
  expect(runExtensionMcpOperation).toHaveBeenNthCalledWith(
    2,
    manager,
    'read',
    'extension:plugin:echo',
    'fixture://data',
  );
  expect(getDatabase).not.toHaveBeenCalled();
});
