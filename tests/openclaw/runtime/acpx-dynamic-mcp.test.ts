import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { expect, test } from 'vitest';

test('scopes the new acpx dynamic MCP resolver to the admitted session', () => {
  const source = fs.readFileSync(path.resolve('openclaw-extensions/acpx/src/runtime.ts'), 'utf8');
  const fn = source.match(/function withManagedToolsMcpSessionEnv\([^]*?\n\}\r?\n/)?.[0];
  expect(fn).toBeDefined();
  const code = transformSync(fn!, { loader: 'ts', target: 'node24' }).code;
  const resolve = vm.runInNewContext(code + '; withManagedToolsMcpSessionEnv', {
    ACPX_PLUGIN_TOOLS_MCP_SERVER_NAME: 'openclaw-plugin-tools',
    ACPX_OPENCLAW_TOOLS_MCP_SERVER_NAME: 'openclaw-tools',
    OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY_ENV: 'OPENCLAW_AGENT_SESSION_KEY',
  });
  const context = { agent: 'codex' };
  const original = [{ name: 'openclaw-tools', command: 'node', args: [], env: [] }];
  const scoped = resolve({
    pluginToolsEnabled: false, openclawToolsEnabled: true,
    sessionKey: 'agent:main:justdo:task', agentId: 'main',
    mcpServers: (value: unknown) => { expect(value).toBe(context); return original; },
  });
  expect(scoped(context)).toEqual([{
    name: 'openclaw-tools', command: 'node', args: ['--openclaw-agent-id', 'main'],
    env: [{ name: 'OPENCLAW_AGENT_SESSION_KEY', value: 'agent:main:justdo:task' }],
  }]);
  expect(original[0].env).toEqual([]);
});
