import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import { EXTENSION_MCP_SCRIPT, runExtensionMcpOperation } from './extensionMcpRuntime';

test('passes a server identity as data and projects only the native result', async () => {
  const manager = {
    buildCliEnvironment: vi.fn(async () => ({
      runtimeRoot: 'runtime',
      env: { JUSTDO_ELECTRON_PATH: '/bundled/node.exe' },
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
    '/bundled/node.exe',
    ['--input-type=module', '-e', expect.any(String)],
    {
      cwd: 'runtime',
      env: {
        JUSTDO_ELECTRON_PATH: '/bundled/node.exe',
        ELECTRON_RUN_AS_NODE: '1',
        JUSTDO_EXTENSION_MCP_MODE: 'probe',
        JUSTDO_EXTENSION_MCP_ID: id,
        JUSTDO_EXTENSION_MCP_URI: '',
      },
    },
  );
});

test.each([false, true])('data discovery loads only the required native modules (managed declarations: %s)', managed => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-mcp-data-'));
  try {
    const dist = path.join(root, 'dist');
    fs.mkdirSync(dist);
    const writeModule = (name: string, source: string) => fs.writeFileSync(path.join(dist, `${name}.mjs`), source);
    writeModule('io.runtime-test', 'export const getRuntimeConfig = () => ({});');
    writeModule('control-plane-workspace-test', 'export const resolvePluginControlPlaneWorkspace = () => ({});');
    const declaration = { command: 'node', env: { PLUGIN_DATA: '${PLUGIN_DATA}' } };
    const nativePlugins = managed ? [
      { id: 'selected', mcpServers: { shared: declaration, disabled: declaration } },
      { id: 'unselected', mcpServers: { shared: declaration } },
    ] : [{ id: 'ordinary', mcpServers: { plain: { command: 'node' } } }];
    writeModule('manifest-registry-test', `export const loadPluginManifestRegistryCore = () => ({ plugins: ${JSON.stringify(nativePlugins)} });`);
    if (managed) writeModule('bundle-mcp-test', `export function loadEnabledBundleMcpConfig({ manifestRegistry }) {
      if (manifestRegistry.plugins.length !== 2) throw new Error('Expected the full registry');
      return { pluginIdsByServer: { shared: 'selected' }, config: { mcpServers: { shared: { command: 'node', args: ['resolved'] } } } };
    }`);

    const output = execFileSync(process.execPath, ['--input-type=module', '-e', EXTENSION_MCP_SCRIPT], {
      cwd: root, env: { ...process.env, JUSTDO_EXTENSION_MCP_MODE: 'data' }, encoding: 'utf8', windowsHide: true,
    });

    expect(output).toBe(`JUSTDO_EXTENSION_MCP=${JSON.stringify(managed ? [
      { pluginId: 'selected', servers: { shared: { command: 'node', args: ['resolved'] } } },
    ] : [])}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
