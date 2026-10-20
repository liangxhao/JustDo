// Real manager/registry and disposable persisted config; Native handshakes are fixtures.
// No Gateway, Electron, SQLite, user configuration or native ABI is touched.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSync } from 'esbuild';
import { parseAppPluginManifest } from '../../../packages/app-plugin-sdk/contracts.ts';

const temporary = await mkdtemp(path.join(tmpdir(), 'app-offline-toggle-'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let manager;
try {
  const nativeRoot = path.join(temporary, 'package');
  const root = path.join(nativeRoot, 'app');
  await mkdir(root, { recursive: true });
  const id = 'offline-fixture';
  const manifest = parseAppPluginManifest({
    manifestVersion: 1,
    apiVersion: 1,
    id,
    nativePluginId: id,
    version: '1.0.0',
    entries: { main: 'main.mjs', browser: 'browser.mjs' },
    capabilities: [],
    slots: [],
    commands: ['read'],
  });
  const native = `export default {id:'${id}',register(){}};`;
  await writeFile(path.join(nativeRoot, 'index.js'), native);
  const content = {
    'main.mjs':
      "export function register(){return{commands:[{id:'read',invoke:()=>({success:true})}]};}",
    'browser.mjs': 'export function register(){}',
    'native.binding.json': JSON.stringify({
      entry: 'index.js',
      sha256: sha(native),
      profile: 'single-file-v1',
    }),
  };
  const files = Object.fromEntries(
    Object.entries(content)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([file, value]) => [file, sha(value)]),
  );
  for (const [file, value] of Object.entries(content))
    await writeFile(path.join(root, file), value);
  await writeFile(
    path.join(root, 'app.artifact.json'),
    JSON.stringify({ manifest, files, hash: sha(JSON.stringify({ manifest, files })) }),
  );
  const filename = path.resolve('src/main/plugins/app/manager.ts');
  const output = buildSync({
    entryPoints: [filename],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    logLevel: 'silent',
  }).outputFiles[0].text;
  const compiled = new Module(filename);
  compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  compiled._compile(output, filename);
  const { AppPluginManager } = compiled.exports;
  const checks = {};
  const observations = {};
  const configFile = path.join(temporary, 'config.json');
  const save = enabled => writeFile(configFile, JSON.stringify({ enabled }));
  const read = () => {
    const value = JSON.parse(readFileSync(configFile, 'utf8'));
    if (typeof value.enabled !== 'boolean') throw new Error('configuration unknown');
    return value.enabled;
  };
  let connected = false;
  let nativeEnabled = true;
  const dependencies = {
    retentionRoot: path.join(temporary, 'retained'),
    readDesiredEnabled: read,
    candidates: async () => [{ root, nativeRoot, trusted: true }],
    broadcast() {},
    isGatewayConnected: () => connected,
    resources: {
      requestConnectedGateway: async method => {
        assert.equal(method, `${id}.app.handshake`);
        if (!nativeEnabled) throw new Error('Native plugin is disabled');
        return {
          pluginId: id,
          registrationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          processId: 123,
          gatewayMethods: [],
          nativeEntry: path.join(nativeRoot, 'index.js'),
          sourceSha256: sha(native),
        };
      },
    },
  };
  for (const scenario of [
    'saved',
    'ackWithoutWrite',
    'explicitFailure',
    'throwAfterWrite',
    'unreadableSave',
  ]) {
    connected = false;
    nativeEnabled = true;
    await save(false);
    manager = new AppPluginManager(dependencies);
    await manager.prepare();
    await manager.activate();
    try {
      await manager.mutate(id, true, async () => {
        if (scenario === 'unreadableSave') await writeFile(configFile, '{');
        else if (scenario !== 'ackWithoutWrite') await save(true);
        if (scenario === 'throwAfterWrite') throw new Error('unknown outcome');
        return { success: scenario !== 'explicitFailure' };
      });
    } catch {
      /* Failure outcomes must remain fenced. */
    }
    const waiting = manager.snapshot()[0];
    const request = { id, epoch: waiting.epoch, command: 'read', args: [] };
    checks[`${scenario}:noBusinessBeforeNativeProof`] =
      (await manager.invoke(request)).success === false && waiting.state !== 'active';
    const beforeNativeProof = waiting.state;
    await save(true);
    connected = true;
    await manager.refresh();
    const afterNativeProof = manager.snapshot()[0].state;
    observations[scenario] = { beforeNativeProof, afterNativeProof };
    checks[`${scenario}:expectedRecovery`] =
      scenario === 'saved'
        ? beforeNativeProof === 'cleanup' && afterNativeProof === 'active'
        : beforeNativeProof === 'blocked' && afterNativeProof === 'blocked';
    manager.dispose();
    manager = undefined;
  }
  await save(true);
  connected = true;
  nativeEnabled = true;
  manager = new AppPluginManager(dependencies);
  await manager.prepare();
  await manager.activate();
  await manager.refresh();
  const active = manager.snapshot()[0];
  assert.equal(active.state, 'active');
  connected = false;
  checks.disconnectedRefreshWithdrawsExistingNativeProof =
    (await manager.invoke({ id, epoch: active.epoch, command: 'read', args: [] })).success ===
    false;
  manager.invalidate();
  await manager.mutate(id, false, async () => {
    await save(false);
    return { success: true };
  });
  checks.offlineDisableWaitsWithoutPermanentBlock = manager.snapshot()[0].state === 'cleanup';
  checks.offlineDisableRetiresOldFrame =
    (await manager.invoke({ id, epoch: active.epoch, command: 'read', args: [] })).success ===
    false;
  connected = true;
  nativeEnabled = false;
  await manager.refresh();
  checks.nativeDisabledProofKeepsBusinessClosed = manager.snapshot()[0].state === 'cleanup';
  console.log(
    JSON.stringify({
      realManagerAndRegistry: true,
      realDisposablePersistedConfig: true,
      nativeHandshakesAreFixtures: true,
      observations,
      checks,
    }),
  );
  assert.ok(
    Object.values(checks).every(Boolean),
    'Only confirmed local saves may await native proof without permanent blocking',
  );
} finally {
  manager?.dispose();
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(tmpdir()));
  assert.ok(path.basename(temporary).startsWith('app-offline-toggle-'));
  await rm(temporary, { recursive: true, force: true });
}
