// Normal native MCP tool materialization and App admission, without a model or user state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtimeRoot = path.join(root, 'vendor/openclaw-runtime/current');
const dist = path.join(runtimeRoot, 'dist');
const state = fs.mkdtempSync(path.join(root, '.agent-tasks/drawio/native-'));
const workspaceDir = path.join(state, 'workspace');
fs.mkdirSync(workspaceDir);
Object.assign(process.env, {
  OPENCLAW_HOME: state,
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: path.join(state, 'openclaw.json'),
  OPENCLAW_NO_RESPAWN: '1',
});
const cfg = {
  agents: { defaults: { workspace: workspaceDir } },
  plugins: { enabled: true, allow: ['drawio'], entries: { drawio: { enabled: true } } },
  mcp: { apps: { enabled: true } },
};
fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(cfg));
const load = async (prefix, name) => {
  for (const file of fs
    .readdirSync(dist)
    .filter(file => file.startsWith(prefix) && /\.m?js$/.test(file))) {
    const module = await import(pathToFileURL(path.join(dist, file)).href);
    const fn = Object.values(module).find(
      value => typeof value === 'function' && value.name === name,
    );
    if (fn) return fn;
  }
  throw new Error(`Missing native export ${name}`);
};
const registry = await load('manifest-registry-', 'loadPluginManifestRegistryCore');
const loadMcp = await load('bundle-mcp-', 'loadEnabledBundleMcpConfig');
const manifestRegistry = registry({ config: cfg, workspaceDir });
assert.ok(
  manifestRegistry.plugins.some(plugin => plugin.id === 'drawio' && plugin.origin === 'bundled'),
);
const definitions = loadMcp({ cfg, manifestRegistry, workspaceDir });
assert.equal(definitions.pluginIdsByServer.drawio, 'drawio');
assert.equal(definitions.config.mcpServers.drawio.command, 'node');
assert.ok(
  fs
    .realpathSync(definitions.config.mcpServers.drawio.args[0])
    .startsWith(fs.realpathSync(runtimeRoot) + path.sep),
);
const { createSessionMcpRuntime } = await import(
  pathToFileURL(path.join(dist, 'agents/agent-bundle-mcp-runtime.js')).href
);
const { materializeBundleMcpToolsForRun } = await import(
  pathToFileURL(path.join(dist, 'agents/agent-bundle-mcp-materialize.js')).href
);
const runtime = await createSessionMcpRuntime({
  sessionId: 'diagram-offline-test',
  sessionKey: 'agent:main:diagram-offline-test',
  workspaceDir,
  cfg,
  manifestRegistry,
});
let materialized;
try {
  const catalog = await runtime.getCatalog();
  assert.equal(
    catalog.tools.find(tool => tool.toolName === 'create_diagram')?.uiResourceUri,
    'ui://drawio/editor',
  );
  materialized = await materializeBundleMcpToolsForRun({ runtime, agentId: 'main' });
  const tool = materialized.tools.find(tool => tool.name.includes('create_diagram'));
  assert.ok(tool, 'Bundled tool is available to the model');
  const result = await tool.execute('diagram-offline-call', {
    xml: fs.readFileSync(path.join(root, 'plugins/extensions/drawio/tests/fixture.xml'), 'utf8'),
    title: '采购审批流程',
  });
  const preview = result.details.mcpAppPreview;
  assert.equal(preview.kind, 'canvas');
  assert.equal(preview.mcpApp.serverName, 'drawio');
  assert.equal(preview.mcpApp.toolName, 'create_diagram');
  assert.equal(preview.mcpApp.toolCallId, 'diagram-offline-call');
  assert.equal(preview.mcpApp.uiResourceUri, 'ui://drawio/editor');
  console.log(
    'Native bundled draw.io discovery, model tool execution and MCP App admission passed.',
  );
} finally {
  await materialized?.dispose();
  await runtime.dispose();
  await runtime.joinCleanup?.();
}
