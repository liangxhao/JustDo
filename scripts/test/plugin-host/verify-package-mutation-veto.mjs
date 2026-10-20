// Real manager + built package. Native inspection is a fixture, never a Gateway proof.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSync } from 'esbuild';
import { buildAppPlugin } from '../../plugins/build-app-plugins.mjs';

const temporary = await mkdtemp(path.join(tmpdir(), 'app-package-veto-'));
let manager;
try {
  const source = path.join(temporary, 'source');
  await mkdir(source);
  await writeFile(
    path.join(source, 'package.json'),
    JSON.stringify({
      name: 'package-fixture',
      version: '1.0.0',
      type: 'module',
      openclaw: { extensions: ['./index.js'] },
      app: { main: './main.js', browser: './browser.js' },
    }),
  );
  await writeFile(
    path.join(source, 'openclaw.plugin.json'),
    JSON.stringify({ id: 'package-fixture', configSchema: { type: 'object', properties: {} } }),
  );
  await writeFile(
    path.join(source, 'app.plugin.json'),
    JSON.stringify({
      manifestVersion: 1,
      apiVersion: 1,
      id: 'package-fixture',
      nativePluginId: 'package-fixture',
      version: '1.0.0',
      entries: { main: 'main.mjs', browser: 'browser.mjs' },
      capabilities: [],
      commands: ['read'],
      slots: [],
    }),
  );
  await writeFile(
    path.join(source, 'index.js'),
    "export default {id:'package-fixture',register(){}};\n",
  );
  await writeFile(path.join(source, 'browser.js'), 'export function register(){}\n');
  await writeFile(
    path.join(source, 'main.js'),
    "let checks=0;export function register(){return{commands:[{id:'read',invoke:()=>({success:true})}],beforePackageMutation:async()=>{if(++checks===2)throw new Error('unresolved');}};}\n",
  );
  const artifact = await buildAppPlugin(source, path.join(temporary, 'artifacts'));
  const binding = JSON.parse(
    await readFile(path.join(artifact.root, 'native.binding.json'), 'utf8'),
  );
  const filename = path.resolve('src/main/plugins/app/manager.ts');
  const output = buildSync({
    entryPoints: [filename],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  }).outputFiles[0].text;
  const compiled = new Module(filename);
  compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  compiled._compile(output, filename);
  const { AppPluginManager } = compiled.exports;
  let coldLeases = 0;
  let insideColdLease = false;
  let connected = true;
  let processId = 1;
  let registrationId = randomUUID();
  let resumes = 0;
  const dependencies = {
    retentionRoot: path.join(temporary, 'retained'),
    readDesiredEnabled: () => true,
    candidates: async () => [
      { root: artifact.root, nativeRoot: artifact.packageRoot, trusted: true },
    ],
    broadcast() {},
    isGatewayConnected: () => connected,
    withStoppedGateway: async operation => {
      coldLeases++;
      insideColdLease = true;
      connected = false;
      try {
        return await operation();
      } finally {
        insideColdLease = false;
      }
    },
    resources: {
      requestConnectedGateway: async () => ({
        pluginId: artifact.id, registrationId, processId, gatewayMethods: [],
        nativeEntry: path.join(artifact.packageRoot, 'index.js'), sourceSha256: binding.sha256,
      }),
      ensureReady: async () => {
        assert.equal(insideColdLease, false);
        connected = true; processId++; registrationId = randomUUID(); resumes++;
      },
    },
  };
  manager = new AppPluginManager(dependencies);
  await manager.prepare();
  manager.registry.activate();
  await manager.refresh();
  assert.equal(manager.snapshot()[0].state, 'active');
  const oldEpoch = manager.snapshot()[0].epoch;
  let mutations = 0;
  await assert.rejects(
    manager.mutatePackage(async () => {
      mutations++;
    }),
  );
  const snapshot = manager.snapshot()[0];
  const checks = {
    vetoDoesNotMutatePackage: mutations === 0,
    vetoRestoresBusinessAdmission: snapshot.state === 'active',
    vetoRetiresOldEpoch: snapshot.epoch !== oldEpoch,
    vetoDoesNotRequireRestart: snapshot.restartRequired !== true,
  };
  checks.vetoDoesNotStopGateway = coldLeases === 0;
  let withdrawnDuringMutation = false;
  await manager.mutatePackage(async () => {
    mutations++;
    withdrawnDuringMutation =
      manager.snapshot().every(item => item.state !== 'active') && insideColdLease;
  });
  checks.actualMutationUsesColdPortWithBusinessWithdrawn =
    mutations === 1 && coldLeases === 1 && withdrawnDuringMutation;
  checks.successRecoversInSameApplication = resumes === 1 && manager
    .snapshot()
    .every(item => item.state === 'active' && !item.restartRequired);
  manager.dispose();
  const { withStoppedGateway: _unused, ...withoutColdPort } = dependencies;
  manager = new AppPluginManager(withoutColdPort);
  await manager.prepare();
  manager.registry.activate();
  await manager.refresh();
  await assert.rejects(
    manager.mutatePackage(async () => {
      mutations++;
    }),
  );
  checks.missingColdPortRejectsActualMutation =
    mutations === 1 && manager.snapshot()[0].state === 'active';
  console.log(
    JSON.stringify({
      realManager: true,
      actualBuiltArtifact: true,
      fixtureNativeInspection: true,
      checks,
    }),
  );
  assert.ok(
    Object.values(checks).every(Boolean),
    'A package preflight veto must restore unchanged native availability',
  );
} finally {
  manager?.dispose();
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(tmpdir()));
  assert.ok(path.basename(temporary).startsWith('app-package-veto-'));
  await rm(temporary, { recursive: true, force: true });
}
