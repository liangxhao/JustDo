// Negative control for the native single-file claim using the real artifact builder.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildAppPlugin } from '../../plugins/build-app-plugins.mjs';

const temporary = await mkdtemp(path.join(tmpdir(), 'app-native-graph-'));
try {
  const source = path.join(temporary, 'source');
  await mkdir(path.join(source, 'skills'), { recursive: true });
  // This module-graph control runs outside Gateway and never registers its Native
  // entry. Supply only the public SDK import, failing if it is actually invoked;
  // the real dispatcher and registration are verified by the Gateway probe.
  const sdkFixture = path.join(temporary, 'node_modules', 'openclaw');
  await mkdir(sdkFixture, { recursive: true });
  await writeFile(path.join(sdkFixture, 'package.json'), JSON.stringify({
    name: 'openclaw', type: 'module',
    exports: { './plugin-sdk/gateway-method-runtime': './gateway-method-runtime.js' },
  }));
  await writeFile(path.join(sdkFixture, 'gateway-method-runtime.js'),
    'export function dispatchGatewayMethod(){throw new Error("Unexpected Native dispatch in module-graph control");}\n');
  await writeFile(
    path.join(source, 'package.json'),
    JSON.stringify({
      name: 'native-graph-fixture',
      version: '1.0.0',
      type: 'module',
      openclaw: { extensions: ['./index.js'] },
      app: { main: './main.js', browser: './browser.js' },
    }),
  );
  await writeFile(
    path.join(source, 'app.plugin.json'),
    JSON.stringify({
      manifestVersion: 1,
      apiVersion: 1,
      id: 'native-graph-fixture',
      nativePluginId: 'native-graph-fixture',
      version: '1.0.0',
      entries: { main: 'main.js', browser: 'browser.js' },
      capabilities: [],
      commands: [],
      slots: [],
    }),
  );
  await writeFile(
    path.join(source, 'openclaw.plugin.json'),
    JSON.stringify({
      id: 'native-graph-fixture',
      configSchema: { type: 'object', additionalProperties: false, properties: {} },
    }),
  );
  await writeFile(
    path.join(source, 'main.js'),
    'export function register(){return {commands:[]};}\n',
  );
  await writeFile(path.join(source, 'browser.js'), 'export function register(){}\n');
  await writeFile(
    path.join(source, 'index.js'),
    `
import {createRequire} from 'node:module';
const dependency = createRequire(import.meta.url);
export function actualEffect(){return dependency('./skills/business.cjs').value;}
export default {id:'native-graph-fixture',register(api){api.registerGatewayMethod('nativeGraph.read',({respond})=>respond(true,{value:actualEffect()}),{scope:'operator.read'});}};
`,
  );
  await writeFile(path.join(source, 'skills/business.cjs'), "exports.value='old';\n");
  await assert.rejects(
    buildAppPlugin(source, path.join(temporary, 'unsupported')),
    /must bundle business dependencies|Dynamic native|Computed native/u,
    'The supported single-file profile must reject opaque native dependency loading',
  );
  await writeFile(
    path.join(source, 'index.js'),
    `
import {value} from './skills/business.mjs';
export function actualEffect(){return value;}
export default {id:'native-graph-fixture',register(api){api.registerGatewayMethod('nativeGraph.read',({respond})=>respond(true,{value:actualEffect()}),{scope:'operator.read'});}};
`,
  );
  const results = [];
  for (const value of ['old', 'changed']) {
    await writeFile(
      path.join(source, 'skills/business.mjs'),
      `export const value=${JSON.stringify(value)};\n`,
    );
    const artifact = await buildAppPlugin(source, path.join(temporary, value));
    const binding = JSON.parse(
      await readFile(path.join(artifact.root, 'native.binding.json'), 'utf8'),
    );
    const entry = path.join(artifact.packageRoot, 'index.js');
    const native = await import(pathToFileURL(entry).href);
    const entryBytesDigest = createHash('sha256').update(await readFile(entry)).digest('hex');
    assert.equal(
      entryBytesDigest,
      binding.sha256,
      'The immutable package binds its complete native entry bytes',
    );
    results.push({
      hash: artifact.hash,
      entryDigest: binding.sha256,
      entryBytesDigest,
      effect: native.actualEffect(),
    });
  }
  assert.notEqual(
    results[0].hash,
    results[1].hash,
    'Changing a bundled dependency must change the companion identity',
  );
  assert.notEqual(results[0].entryDigest, results[1].entryDigest);
  assert.notEqual(results[0].effect, results[1].effect);
  console.log(
    JSON.stringify({
      actualArtifactBuilder: true,
      nativeExecutedEffects: results,
      opaqueNativeDependencyRejected: true,
      bundledDependencyChangesIdentity: true,
    }),
  );
} finally {
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(tmpdir()));
  assert.ok(path.basename(temporary).startsWith('app-native-graph-'));
  await rm(temporary, { recursive: true, force: true });
}
