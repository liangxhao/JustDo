import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

import type { AppPluginManifest } from '../../../../plugins/sdk/app-plugin-sdk/contracts';
import { artifactDigest, inspectAppArtifact } from './artifact';
import { appAssetPath, publishAppAssets, readAppAsset } from './assets';
import { startAppDevelopmentAssets } from './developmentAssets';
import { AppPluginManager } from './manager';
import type { AppHostResources } from './registry';

const releases: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0).reverse()) await release();
});
const sha = (source: string) => createHash('sha256').update(source).digest('hex');
async function fixture(
  presentation = "import './display.mjs'; export const presentation = {};",
  overrides: Record<string, string> = {},
) {
  const directory = await mkdtemp(path.join(tmpdir(), 'app-history-presentation-'));
  releases.push(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'app');
  await mkdir(root);
  const manifest: AppPluginManifest = {
    manifestVersion: 1,
    apiVersion: 1,
    id: 'history-fixture',
    nativePluginId: 'history-fixture',
    version: '1.0.0',
    entries: { main: 'main.mjs', browser: 'browser.mjs', presentation: 'presentation.mjs' },
    capabilities: [],
    slots: [],
    commands: [],
  };
  const native = 'export default {};';
  await writeFile(path.join(directory, 'index.js'), native);
  const sources: Record<string, string> = {
    'main.mjs': "import './private.mjs'; export const register=()=>({commands:[]});",
    'private.mjs': "import 'node:fs'; export const privateValue=1;",
    'browser.mjs': "import './ui.mjs'; export const register=()=>{};",
    'ui.mjs': 'export const view=1;',
    'presentation.mjs': presentation,
    'display.mjs': 'export const text=source=>source;',
    'browser.css': '.fixture { color: red; }',
    'native.binding.json': JSON.stringify({
      entry: 'index.js',
      profile: 'single-file-v1',
      sha256: sha(native),
    }),
    ...overrides,
  };
  const files = Object.fromEntries(
    Object.entries(sources).map(([name, source]) => [name, sha(source)]),
  );
  for (const [name, source] of Object.entries(sources))
    await writeFile(path.join(root, name), source);
  await writeFile(
    path.join(root, 'app.artifact.json'),
    JSON.stringify({ manifest, files, hash: artifactDigest(manifest, files) }),
  );
  return { directory, root };
}

test('publishes only the verified graph for each lease and old release cannot remove a new owner', async () => {
  const { root } = await fixture();
  const artifact = await inspectAppArtifact(root);
  const route = (epoch: string, file: string) => appAssetPath(artifact.artifact.hash, epoch, file);
  releases.push(publishAppAssets(artifact, 'business'));
  const old = publishAppAssets(artifact, 'presentation', 'presentation');
  releases.push(old);
  releases.push(publishAppAssets(artifact, 'presentation', 'presentation'));
  old();
  expect(await readAppAsset(route('presentation', 'presentation.mjs'))).not.toBeNull();
  expect(await readAppAsset(route('presentation', 'display.mjs'))).not.toBeNull();
  for (const file of [
    'main.mjs',
    'private.mjs',
    'browser.mjs',
    'ui.mjs',
    'native.binding.json',
    'browser.css',
  ])
    expect(await readAppAsset(route('presentation', file))).toBeNull();
  expect(await readAppAsset(route('business', 'ui.mjs'))).not.toBeNull();
  for (const file of [
    'main.mjs',
    'private.mjs',
    'presentation.mjs',
    'display.mjs',
    'native.binding.json',
  ])
    expect(await readAppAsset(route('business', file))).toBeNull();
  const reading = readAppAsset(route('presentation', 'presentation.mjs'));
  releases.pop()!();
  expect(await reading).toBeNull();
});

test('serves URL-mounted workers, standalone browser modules and shared chunks without exposing Main or broadening pure assets', async () => {
  const { root, directory } = await fixture(
    "import './display.mjs'; import './shared.mjs'; export const presentation = {};",
    {
      'main.mjs':
        "import './private.mjs'; import './shared.mjs'; export const register=()=>({commands:[]});",
      'browser.mjs':
        "import './ui.mjs'; import './shared.mjs'; export const worker=new URL('./worker.mjs', import.meta.url); export const register=()=>{};",
      'worker.mjs': "import './shared.mjs'; export const workerValue=1;",
      'standalone.mjs': 'export const mountedSeparately=1;',
      'shared.mjs': 'export const sharedValue=1;',
    },
  );
  const artifact = await inspectAppArtifact(root);
  releases.push(publishAppAssets(artifact, 'business'));
  releases.push(publishAppAssets(artifact, 'presentation', 'presentation'));
  const descriptor = path.join(directory, 'development-assets.json');
  releases.push(await startAppDevelopmentAssets(descriptor));
  const { port, token } = JSON.parse(await readFile(descriptor, 'utf8')) as {
    port: number;
    token: string;
  };
  const read = async (epoch: string, file: string) => {
    const response = await fetch(
      `http://127.0.0.1:${port}/${appAssetPath(artifact.artifact.hash, epoch, file)}`,
      {
        headers: { 'x-app-assets': token },
      },
    );
    await response.arrayBuffer();
    return response.status;
  };
  expect(await read('business', 'worker.mjs')).toBe(200);
  expect(await read('business', 'standalone.mjs')).toBe(200);
  expect(await read('business', 'shared.mjs')).toBe(200);
  expect(await read('presentation', 'shared.mjs')).toBe(200);
  for (const file of ['main.mjs', 'private.mjs']) {
    expect(await readAppAsset(appAssetPath(artifact.artifact.hash, 'business', file))).toBeNull();
    expect(await read('business', file)).toBe(404);
  }
  for (const file of ['worker.mjs', 'standalone.mjs', 'main.mjs', 'private.mjs', 'browser.mjs'])
    expect(await read('presentation', file)).toBe(404);
});

test.each([
  "import './main.mjs'; export const register=()=>{};",
  "export const mainURL=new URL('./main.mjs', import.meta.url); export const register=()=>{};",
])('rejects a browser reference to even a Node-free Main entry', async browser => {
  const { root } = await fixture(undefined, {
    'main.mjs': 'export const register=()=>({commands:[]});',
    'browser.mjs': browser,
    'private.mjs': 'export const detachedBrowserSafe=1;',
  });
  await expect(inspectAppArtifact(root)).rejects.toThrow('Browser module referenced Main entry');
});

test.each([
  "import './main.mjs'; export const presentation={};",
  "const runtime=globalThis[Symbol.for('app-plugin.browser-runtime.v1')]; export const presentation={};",
])('rejects a pure graph importing the business entry or host runtime', async source => {
  const { root } = await fixture(source);
  await expect(inspectAppArtifact(root)).rejects.toThrow(/presentation imported/);
});

test.each([
  { trusted: true, cleanupOnly: false },
  { trusted: true, cleanupOnly: true },
  { trusted: false, cleanupOnly: false },
])(
  'only current approved installed owners publish display independent of Native readiness: %j',
  async options => {
    const { root, directory } = await fixture();
    const manager = new AppPluginManager({
      retentionRoot: path.join(directory, 'retained'),
      resources: {} as AppHostResources,
      readDesiredEnabled: () => false,
      candidates: async () => [{ root, nativeRoot: directory, ...options }],
      isGatewayConnected: () => false,
      broadcast: () => {},
      loadModule: async () => ({ register: () => ({ commands: [] }) }),
    });
    releases.push(() => manager.dispose());
    await manager.prepare();
    const display = manager.snapshot().find(snapshot => snapshot.presentationEntry);
    if (options.trusted && !options.cleanupOnly) {
      expect(display?.state).not.toBe('active');
      expect(await readAppAsset(display!.presentationEntry!.slice(1))).not.toBeNull();
      expect(display?.browserEntry).toBeUndefined();
      await manager.refresh();
      expect(manager.snapshot()[0].presentationEntry).toBe(display?.presentationEntry);
    } else expect(display).toBeUndefined();
  },
);
