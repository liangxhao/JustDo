import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { resolveNativeSmokeTarget } from './native-smoke-target.mjs';

const { runtimeRoot } = resolveNativeSmokeTarget();

test('the frozen local extensions register with the actual native loader without activation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-registration-native-'));
  const previous = { ...process.env };
  const ids = [
    'acpx', 'agent-team', 'ask-user-question', 'automation-permission', 'drawio',
    'embedded-browser', 'openai', 'plan-mode', 'runtime-services', 'stt-local-cli',
    'swarm-workflow', 'typesafe', 'widget-kit',
  ];
  let inspection;
  try {
    for (const key of Object.keys(process.env))
      if (key.toUpperCase().startsWith('OPENCLAW_')) delete process.env[key];
    const workspaceDir = path.join(root, 'workspace');
    fs.mkdirSync(workspaceDir);
    const config = {
      agents: { entries: { main: {} },
        defaults: { workspace: workspaceDir, embeddedAgent: { cyberFailover: { mode: 'off' } } } },
      plugins: {
        allow: ids,
        slots: { memory: 'none' },
        entries: Object.fromEntries(ids.map(id => [id, { enabled: true }])),
      },
    };
    Object.assign(process.env, {
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: path.join(root, 'state'),
      OPENCLAW_CONFIG_PATH: path.join(root, 'openclaw.json'),
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(runtimeRoot, 'dist/extensions'),
    });
    fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
    const dist = path.join(runtimeRoot, 'dist');
    const owners = fs.readdirSync(dist).filter(name => /^loader-runtime-load-[A-Za-z0-9_-]+\.mjs$/.test(name));
    assert.equal(owners.length, 1, 'target native plugin loader has one owner');
    const module = await import(pathToFileURL(path.join(dist, owners[0])).href);
    const loaders = Object.values(module).filter(value =>
      typeof value === 'function' && value.name === 'acquirePluginRegistryForInspection');
    assert.equal(loaders.length, 1, 'target native registry loader is exported');
    inspection = await loaders[0]({
      config, workspaceDir, env: process.env, onlyPluginIds: ids,
      activate: false, runtimeSideEffects: false, cache: false, throwOnLoadError: true,
      preferBuiltPluginArtifacts: true,
    });
    const { registry } = inspection;
    for (const id of ids) {
      const records = registry.plugins.filter(plugin => plugin.id === id);
      assert.equal(records.length, 1, `${id} has one native registration`);
      assert.equal(records[0].status, 'loaded', `${id}: ${records[0].error ?? records[0].status}`);
    }
    assert.deepEqual(registry.diagnostics.filter(diagnostic => diagnostic.level === 'error'), []);
    assert.ok(registry.services.some(service => service.pluginId === 'acpx'));
    assert.ok(registry.services.some(service => service.pluginId === 'agent-team'));
    assert.ok(registry.services.some(service => service.pluginId === 'swarm-workflow'));
    assert.ok(registry.providers.some(provider => provider.pluginId === 'openai'));
    assert.ok(registry.gatewayHandlers['runtimeServices.historyMessage']);
  } finally {
    let released = false;
    try {
      await inspection?.release();
      released = true;
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
      assert.equal(path.dirname(root), os.tmpdir());
      assert.ok(path.basename(root).startsWith('extension-registration-native-'));
      if (released) fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
