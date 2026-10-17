// Opt-in: real native CLI and application adapters with disposable local state.
// No Gateway is started, no models are called, and the running app is untouched.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

assert.equal(process.versions.electron, undefined, 'Run this isolated CLI probe with Node.js 24');

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(import.meta.url);
const { buildSync } = require('esbuild');
const execute = promisify(execFile);
const runtimeRoot = path.join(root, 'vendor/openclaw-runtime/current');
const artifacts = path.join(root, '.agent-tasks/plugin-hub');

test('native extension install, policy-preserving update, toggles and uninstall', async () => {
  fs.mkdirSync(artifacts, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(artifacts, 'native-'));
  const state = path.join(fixture, 'state');
  const source = path.join(fixture, 'source');
  const configPath = path.join(state, 'openclaw.json');
  const id = 'plugin-page-fixture';
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.toUpperCase().startsWith('OPENCLAW_') &&
    !['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE'].includes(key.toUpperCase())));
  Object.assign(env, {
    OPENCLAW_HOME: fixture,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_GATEWAY_PORT: String(port),
    OPENCLAW_GATEWAY_TOKEN: randomBytes(24).toString('hex'),
  });
  try {
    fs.mkdirSync(state);
    fs.mkdirSync(source);
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { mode: 'local', port, auth: { mode: 'token', token: env.OPENCLAW_GATEWAY_TOKEN } },
      agents: { defaults: { workspace: path.join(fixture, 'workspace') } },
      plugins: { allow: [id] },
    }));
    fs.writeFileSync(path.join(source, 'openclaw.plugin.json'), JSON.stringify({
      id, configSchema: { type: 'object', properties: {} },
    }));
    fs.writeFileSync(path.join(source, 'index.js'), `export default { id: '${id}', register() {} };`);
    const writeVersion = version => fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({
      name: id, version, type: 'module', openclaw: { extensions: ['./index.js'] },
    }));
    writeVersion('1.0.0');
    const adapterFile = path.join(fixture, 'adapter.cjs');
    buildSync({ entryPoints: [path.join(root, 'src/main/plugins/extensions/openclawExtensionImportService.ts')],
      bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: adapterFile });
    const { OpenClawExtensionImportService } = require(adapterFile);
    const manager = {
      getStatus: () => ({ phase: 'ready' }),
      getBaseDir: () => fixture,
      getStateDir: () => state,
      getConfigPath: () => configPath,
      getRuntimeRoot: () => runtimeRoot,
      buildCliEnvironment: async () => ({ env, runtimeRoot, openclawEntry: path.join(runtimeRoot, 'openclaw.mjs') }),
    };
    const service = new OpenClawExtensionImportService({ getOpenClawEngineManager: () => manager });
    const install = options => service.importPath(source, undefined, undefined,
      { trustMarketplaceSource: true, ...options });
    assert.deepEqual(await install(), { success: true, extensionId: id, installPath: path.join(state, 'extensions', id) });
    assert.equal(service.listInstalled().find(entry => entry.id === id)?.version, '1.0.0');
    assert.equal((await service.setEnabled(id, false)).success, true);
    assert.equal(service.listInstalled().find(entry => entry.id === id)?.enabled, false);
    writeVersion('1.0.1');
    assert.deepEqual(await install({ preserveActivation: true }), { success: true, extensionId: id, installPath: path.join(state, 'extensions', id) });
    const updated = service.listInstalled().find(entry => entry.id === id);
    assert.equal(updated?.version, '1.0.1');
    assert.equal(updated?.enabled, false);
    assert.equal((await service.setEnabled(id, true)).success, true);
    assert.equal(service.listInstalled().find(entry => entry.id === id)?.enabled, true);
    assert.equal((await service.delete(id)).success, true);
    assert.equal(service.listInstalled().some(entry => entry.id === id), false);
    const listed = await execute(process.execPath, [path.join(runtimeRoot, 'openclaw.mjs'), 'plugins', 'list', '--json'],
      { cwd: runtimeRoot, env, windowsHide: true, timeout: 30_000, maxBuffer: 4_000_000 });
    const inventory = JSON.parse(listed.stdout.slice(listed.stdout.indexOf('{')));
    assert.equal(inventory.plugins.some(entry => entry.id === id), false);
  } finally {
    assert.equal(path.dirname(path.resolve(fixture)), path.resolve(artifacts));
    assert.ok(path.basename(fixture).startsWith('native-'));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
