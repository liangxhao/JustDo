import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runExtensionMcpOperation } from '../../../src/main/plugins/mcp/extensionMcpRuntime.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(import.meta.url);
const runtimeRoot = path.join(root, 'vendor/openclaw-runtime/current');
const fixtureServer = String.raw`
import readline from 'node:readline';
if (process.cwd() !== process.env.EXPECTED_CWD) throw new Error('Wrong native working directory');
for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  if (request.method === process.env.FIXTURE_LIST_FAILURE) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: {
      code: -32000, message: 'Error POSTing to endpoint: private fixture response',
    } }) + '\n');
    continue;
  }
  let result;
  switch (request.method) {
    case 'initialize': result = { protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'fixture', version: '1' } }; break;
    case 'ping': result = {}; break;
    case 'tools/list': result = { tools: [{ name: process.env.FIXTURE_TOOL_NAME || 'echo', description: 'Fixture echo', inputSchema: { type: 'object' } }] }; break;
    case 'resources/list': result = { resources: [{ name: 'fixture', uri: 'fixture://data' }] }; break;
    case 'prompts/list': result = { prompts: [{ name: 'fixture-prompt' }] }; break;
    case 'resources/read': result = { contents: [{ uri: request.params.uri, text: 'native resource content' }] }; break;
    default: process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n'); continue;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
}
`;

test('native extension MCP inventory, targeted connection, resources, and parent disable', async () => {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'justdo-extension-mcp-'));
  const configPath = path.join(stateDir, 'openclaw.json');
  const config = { plugins: { allow: ['native-fixture', 'bundle-fixture'], load: { paths: [] }, entries: {
    'native-fixture': { enabled: true }, 'bundle-fixture': { enabled: true },
  } }, mcp: { servers: {} } };
  const manager = { buildCliEnvironment: async () => ({ runtimeRoot, env: { ...process.env,
    OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath, JUSTDO_ELECTRON_PATH: require('electron'),
  } }) };
  try {
    for (const format of ['native', 'bundle']) {
      const pluginDir = path.join(stateDir, `${format}-fixture`);
      mkdirSync(pluginDir);
      writeFileSync(path.join(pluginDir, 'server.mjs'), fixtureServer);
      const mcpServers = { [`${format}-echo`]: { command: process.execPath, args: ['./server.mjs'], cwd: '.', env: { EXPECTED_CWD: pluginDir, MCP_TOKEN: 'private-fixture-token' } },
        [`${format}-untested`]: { command: 'must-never-be-launched-by-targeted-probe' } };
      if (format === 'native') {
        writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({ name: 'native-fixture', type: 'module', openclaw: { extensions: ['./index.js'] } }));
        writeFileSync(path.join(pluginDir, 'index.js'), 'throw new Error("Plugin code must not execute during MCP metadata or testing");');
        writeFileSync(path.join(pluginDir, 'openclaw.plugin.json'), JSON.stringify({ id: 'native-fixture', mcpServers, configSchema: { type: 'object', properties: {} } }));
      } else {
        mkdirSync(path.join(pluginDir, '.claude-plugin'));
        writeFileSync(path.join(pluginDir, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'bundle-fixture' }));
        writeFileSync(path.join(pluginDir, '.mcp.json'), JSON.stringify({ mcpServers }));
      }
      config.plugins.load.paths.push(pluginDir);
    }
    writeFileSync(configPath, JSON.stringify(config));
    const inventory = await runExtensionMcpOperation(manager, 'list');
    assert.deepEqual(inventory.map(entry => entry.plugin.id).sort(), ['bundle-fixture', 'native-fixture']);
    for (const format of ['native', 'bundle']) {
      const entry = inventory.find(entry => entry.plugin.id === `${format}-fixture`);
      assert.equal(entry.mcpServers.find(server => server.name === `${format}-echo`).enabled, true);
      assert.equal(entry.mcpServers.find(server => server.name === `${format}-echo`).toggleable, true);
      assert.equal(entry.mcpServers.find(server => server.name === `${format}-echo`).configurable, true);
      const id = `extension:${format}-fixture:${format}-echo`;
      const definition = await runExtensionMcpOperation(manager, 'settings', id);
      assert.equal(definition.command, process.execPath);
      assert.ok(path.isAbsolute(definition.args[0]));
      assert.equal(definition.env.MCP_TOKEN, '__OPENCLAW_REDACTED__');
      assert.ok(!JSON.stringify(definition).includes('private-fixture-token'));
      const result = await runExtensionMcpOperation(manager, 'probe', id);
      assert.equal(result.available, true, JSON.stringify(result));
      assert.deepEqual(result.tools.map(tool => tool.name), ['echo']);
      assert.deepEqual(result.resources.map(resource => resource.uri), ['fixture://data']);
      assert.deepEqual(result.prompts.map(prompt => prompt.name), ['fixture-prompt']);
      const content = await runExtensionMcpOperation(manager, 'read', id, 'fixture://data');
      assert.equal(content.contents[0].text, 'native resource content');
    }
    config.mcp.servers['native-echo'] = { enabled: false };
    writeFileSync(configPath, JSON.stringify(config));
    const serverDisabled = await runExtensionMcpOperation(manager, 'list');
    assert.equal(serverDisabled.find(entry => entry.plugin.id === 'native-fixture').mcpServers.find(server => server.name === 'native-echo').enabled, false);
    const disabledMetadata = serverDisabled.find(entry => entry.plugin.id === 'native-fixture').mcpServers.find(server => server.name === 'native-echo');
    assert.equal(disabledMetadata.toggleable, true);
    assert.equal(disabledMetadata.transportType, 'stdio');
    assert.equal(disabledMetadata.requestTimeoutMs, 60000);
    for (const format of ['native', 'bundle']) {
      config.mcp.servers[`${format}-echo`] = { enabled: false };
      writeFileSync(configPath, JSON.stringify(config));
      const before = readFileSync(configPath, 'utf8');
      const id = `extension:${format}-fixture:${format}-echo`;
      const definition = await runExtensionMcpOperation(manager, 'settings', id);
      assert.equal(definition.command, process.execPath);
      assert.ok(definition.args.length > 0);
      const probe = await runExtensionMcpOperation(manager, 'probe', id);
      assert.equal(probe.available, true, JSON.stringify(probe));
      assert.deepEqual(probe.tools.map(tool => tool.name), ['echo']);
      const content = await runExtensionMcpOperation(manager, 'read', id, 'fixture://data');
      assert.equal(content.contents[0].text, 'native resource content');
      assert.equal(readFileSync(configPath, 'utf8'), before);
      const after = await runExtensionMcpOperation(manager, 'list');
      assert.equal(after.find(entry => entry.plugin.id === `${format}-fixture`).mcpServers.find(server => server.name === `${format}-echo`).enabled, false);
    }

    const nativeDir = path.join(stateDir, 'native-fixture');
    config.mcp.servers['native-echo'] = { command: process.execPath,
      args: [path.join(nativeDir, 'server.mjs')], cwd: nativeDir,
      enabled: false, env: { EXPECTED_CWD: nativeDir, FIXTURE_TOOL_NAME: 'configured_echo' } };
    writeFileSync(configPath, JSON.stringify(config));
    const disabledOverrideConfig = readFileSync(configPath, 'utf8');
    const configured = await runExtensionMcpOperation(manager, 'probe', 'extension:native-fixture:native-echo');
    assert.equal(configured.available, true);
    assert.deepEqual(configured.tools.map(tool => tool.name), ['configured_echo']);
    assert.equal(readFileSync(configPath, 'utf8'), disabledOverrideConfig);
    delete config.mcp.servers['native-echo'].enabled;
    config.plugins.entries['native-fixture'].enabled = false;
    writeFileSync(configPath, JSON.stringify(config));
    const independent = await runExtensionMcpOperation(manager, 'list');
    assert.equal(independent.find(entry => entry.plugin.id === 'native-fixture').mcpServers.find(server => server.name === 'native-echo').enabled, true);
    const independentProbe = await runExtensionMcpOperation(manager, 'probe', 'extension:native-fixture:native-echo');
    assert.deepEqual(independentProbe.tools.map(tool => tool.name), ['configured_echo']);
    config.plugins.entries['native-fixture'].enabled = true;
    for (const method of ['resources/list', 'prompts/list']) {
      config.mcp.servers['native-echo'].env.FIXTURE_LIST_FAILURE = method;
      writeFileSync(configPath, JSON.stringify(config));
      const failure = await runExtensionMcpOperation(manager, 'probe', 'extension:native-fixture:native-echo');
      assert.equal(failure.available, false);
      assert.ok(failure.error.includes('[redacted response body]'));
      assert.ok(!failure.error.includes('private fixture response'));
    }
    delete config.mcp.servers['native-echo'];
    writeFileSync(configPath, JSON.stringify(config));
    const restored = await runExtensionMcpOperation(manager, 'probe', 'extension:native-fixture:native-echo');
    assert.deepEqual(restored.tools.map(tool => tool.name), ['echo']);
    config.plugins.entries['native-fixture'].enabled = false;
    writeFileSync(configPath, JSON.stringify(config));
    const disabled = await runExtensionMcpOperation(manager, 'list');
    assert.equal(disabled.find(entry => entry.plugin.id === 'native-fixture').mcpServers[0].enabled, false);
    assert.equal(disabled.find(entry => entry.plugin.id === 'native-fixture').mcpServers[0].configurable, true);
    await assert.rejects(runExtensionMcpOperation(manager, 'probe', 'extension:native-fixture:native-echo'));
    await assert.rejects(runExtensionMcpOperation(manager, 'probe', 'extension:wrong-owner:bundle-echo'));
  } finally {
    assert.equal(path.dirname(path.resolve(stateDir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(stateDir).startsWith('justdo-extension-mcp-'));
    rmSync(stateDir, { recursive: true, force: true });
  }
});
