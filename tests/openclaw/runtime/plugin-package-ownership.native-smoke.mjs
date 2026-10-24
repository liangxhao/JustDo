// One real native install with disposable state; no Gateway or model is started.
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
import { resolveNativeSmokeTarget } from './native-smoke-target.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(import.meta.url);
const { buildSync } = require('esbuild');
const execute = promisify(execFile);
const artifacts = path.join(root, '.agent-tasks/plugin-hub');
const { runtimeRoot, executable } = resolveNativeSmokeTarget();

test('native multi-entry install, catalog and marketplace identity use the same package ownership', async () => {
  assert.equal(process.versions.electron, undefined);
  fs.mkdirSync(artifacts, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(artifacts, 'ownership-native-'));
  const state = path.join(fixture, 'state');
  const source = path.join(fixture, 'source');
  const configPath = path.join(state, 'openclaw.json');
  const ownerId = 'multi-entry-fixture';
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
    JUSTDO_ELECTRON_PATH: executable,
  });
  try {
    fs.mkdirSync(state);
    fs.mkdirSync(source);
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { mode: 'local', port, auth: { mode: 'token', token: env.OPENCLAW_GATEWAY_TOKEN } },
      agents: { ownership: 'explicit', entries: { main: {} }, defaults: { workspace: path.join(fixture, 'workspace'),
        embeddedAgent: { cyberFailover: { mode: 'off' } } } },
      plugins: { allow: ['memory-core'] },
    }));
    fs.writeFileSync(path.join(source, 'openclaw.plugin.json'), JSON.stringify({
      id: ownerId, configSchema: { type: 'object', properties: {} },
    }));
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({
      name: ownerId, version: '1.0.0', type: 'module',
      openclaw: { extensions: ['./alpha.js', './beta.js'] },
    }));
    for (const name of ['alpha', 'beta'])
      fs.writeFileSync(path.join(source, `${name}.js`), `export default { id: '${ownerId}/${name}', register() {} };`);
    const entry = [
      ['OpenClawExtensionImportService', 'src/main/plugins/extensions/openclawExtensionImportService.ts'],
      ['EXTENSION_PACKAGE_OWNERSHIP_SCRIPT', 'src/main/plugins/extensions/extensionPackageOwnership.ts'],
      ['PluginInstallationService', 'src/main/plugins/installation/pluginInstallationService.ts'],
      ['PluginMarketplaceService', 'src/main/plugins/marketplace/pluginMarketplaceService.ts'],
      ['MarketplaceInstallRegistry', 'src/main/plugins/marketplace/marketplaceInstallRegistry.ts'],
    ].map(([name, file]) => `export { ${name} } from ${JSON.stringify(path.join(root, file))};`).join('\n');
    const adapterFile = path.join(fixture, 'adapter.cjs');
    buildSync({ stdin: { contents: entry, resolveDir: root, sourcefile: 'ownership-fixture.ts', loader: 'ts' },
      bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: adapterFile });
    const adapter = require(adapterFile);
    const manager = {
      getStatus: () => ({ phase: 'ready' }),
      getBaseDir: () => fixture,
      getStateDir: () => state,
      getConfigPath: () => configPath,
      getRuntimeRoot: () => runtimeRoot,
      buildCliEnvironment: async () => ({ env, runtimeRoot, openclawEntry: path.join(runtimeRoot, 'openclaw.mjs') }),
    };
    const importer = new adapter.OpenClawExtensionImportService({ getOpenClawEngineManager: () => manager });
    const installers = new adapter.PluginInstallationService();
    installers.registerInstaller({ kind: 'extension', install: async () => {
      const result = await importer.importPath(source, undefined, undefined, { trustMarketplaceSource: true });
      return { ...result, pluginId: result.extensionId };
    } });
    let stored;
    const registry = new adapter.MarketplaceInstallRegistry(() => ({ get: () => stored, set: (_key, value) => { stored = value; } }));
    const marketplace = new adapter.PluginMarketplaceService([{
      source: { id: 'fixture-catalog', name: 'Fixture', supportedKinds: ['extension'] },
      search: async () => ({ items: [] }),
      prepareInstall: async () => ({ payload: { kind: 'extension', sourcePath: source } }),
    }], installers, registry);
    const result = await marketplace.install({ sourceId: 'fixture-catalog', pluginId: 'catalog-item', kind: 'extension', version: '1.0.0' });
    assert.equal(result.success, true, result.error);
    assert.equal(result.pluginId, `${ownerId}/alpha`);
    assert.equal(result.installPath, path.join(state, 'extensions', ownerId));

    const listingScript = adapter.EXTENSION_PACKAGE_OWNERSHIP_SCRIPT + String.raw`
const listPlugins = await load('management-service-', 'listManagedPlugins');
const catalog = await listPlugins({ config, env: process.env, metadata, officialCatalog: { entries: [] } });
process.stdout.write('\nFIXTURE_NATIVE_CATALOG=' + JSON.stringify(catalog));
`;
    const listed = await execute(executable, ['--input-type=module', '--eval', listingScript],
      { cwd: runtimeRoot, env, windowsHide: true, timeout: 30_000, maxBuffer: 4_000_000 });
    const marker = 'FIXTURE_NATIVE_CATALOG=';
    const nativeCatalog = JSON.parse(listed.stdout.slice(listed.stdout.lastIndexOf(marker) + marker.length));
    const requested = [];
    const catalogService = new adapter.OpenClawExtensionImportService({
      getOpenClawEngineManager: () => manager,
      requestGateway: async method => { requested.push(method); assert.equal(method, 'plugins.list'); return nativeCatalog; },
    });
    const catalog = await catalogService.listCatalog();
    const children = catalog.filter(plugin => plugin.id === `${ownerId}/alpha` || plugin.id === `${ownerId}/beta`);
    assert.equal(children.length, 2);
    assert.ok(children.every(child => child.enabled));
    assert.ok(children.every(child => child.installPath === result.installPath));
    assert.deepEqual(requested, ['plugins.list']);
    assert.deepEqual(marketplace.resolveInstalled({ kind: 'extension', installed: children.map(({ id, installPath }) => ({ id, installPath })) }), [{
      runtimeId: result.pluginId, sourceId: 'fixture-catalog', pluginId: 'catalog-item',
    }]);

    const reviewed = new adapter.OpenClawExtensionImportService({
      getOpenClawEngineManager: () => manager,
      requestGateway: async method => {
        assert.equal(method, 'plugins.install');
        throw Object.assign(new Error('Synthetic failure after the native package persisted'), {
          details: { persistence: { operation: 'install', pluginId: ownerId } },
        });
      },
    });
    const review = await reviewed.importPath(source);
    const partial = await reviewed.importPath(source, undefined, review.capabilityReview.reviewToken);
    assert.equal(partial.success, false);
    assert.equal(partial.installationCommitted, true);
    assert.equal(partial.extensionId, result.pluginId);
    assert.equal(partial.installPath, result.installPath);
  } finally {
    assert.equal(path.dirname(path.resolve(fixture)), path.resolve(artifacts));
    assert.ok(path.basename(fixture).startsWith('ownership-native-'));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
