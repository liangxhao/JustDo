import { expect, test, vi } from 'vitest';

import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import { runExtensionMcpOperation } from './extensionMcpRuntime';

test('passes a server identity as data and projects only the native result', async () => {
  const manager = {
    buildCliEnvironment: vi.fn(async () => ({
      runtimeRoot: 'runtime',
      env: { JUSTDO_ELECTRON_PATH: 'electron-node' },
    })),
  } as unknown as OpenClawEngineManager;
  const runner = vi.fn(async () => ({
    stdout: 'diagnostic line\nJUSTDO_EXTENSION_MCP={"available":true}',
  }));
  const id = 'extension:plugin:name with spaces';
  expect(await runExtensionMcpOperation(manager, 'probe', id, '', runner)).toEqual({
    available: true,
  });
  expect(runner).toHaveBeenCalledWith(
    'electron-node',
    ['--input-type=module', '-e', expect.any(String)],
    {
      cwd: 'runtime',
      env: {
        JUSTDO_ELECTRON_PATH: 'electron-node',
        ELECTRON_RUN_AS_NODE: '1',
        JUSTDO_EXTENSION_MCP_MODE: 'probe',
        JUSTDO_EXTENSION_MCP_ID: id,
        JUSTDO_EXTENSION_MCP_URI: '',
      },
    },
  );
});
