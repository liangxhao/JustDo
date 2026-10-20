// Exercise the real Vite middleware against the private Main asset server.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { createServer } from 'vite';
import { appPluginAssetsPlugin } from '../../plugins/vite-app-plugin-assets.mjs';

const temporary = await mkdtemp(path.join(tmpdir(), 'app-dev-assets-'));
let vite;
let closeMain;
let withdraw;
try {
  const compiled = path.join(temporary, 'assets.cjs');
  await build({
    stdin: {
      contents: `export { startAppDevelopmentAssets } from './src/main/plugins/app/developmentAssets'; export { publishAppAssets, appAssetPath } from './src/main/plugins/app/assets'; export { inspectAppArtifact } from './src/main/plugins/app/artifact';`,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: compiled,
  });
  const api = createRequire(import.meta.url)(compiled);
  const catalog = JSON.parse(await readFile('build/app-plugins/catalog.json', 'utf8'));
  const item = catalog[0];
  const artifact = await api.inspectAppArtifact(
    path.resolve('build/app-plugins', item.id, item.hash),
  );
  const descriptor = path.join(temporary, 'build/app-plugins/development-assets.json');
  closeMain = await api.startAppDevelopmentAssets(descriptor);
  withdraw = api.publishAppAssets(artifact, 'probe-epoch');
  await writeFile(path.join(temporary, 'loader.ts'),
    'export const load = (url: string) => import(/* @vite-ignore */ url);');
  vite = await createServer({
    configFile: false,
    root: temporary,
    server: { host: '127.0.0.1', port: 0 },
    plugins: [appPluginAssetsPlugin(temporary)],
  });
  await vite.listen();
  const port = vite.httpServer.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const url =
    '/' + api.appAssetPath(item.hash, 'probe-epoch', artifact.artifact.manifest.entries.browser);
  const response = await fetch(origin + url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /javascript/);
  assert.equal(
    await response.text(),
    await readFile(path.join(artifact.root, artifact.artifact.manifest.entries.browser), 'utf8'),
  );
  const loader = await (await fetch(origin + '/loader.ts')).text();
  assert.match(loader, /__vite__injectQuery\(url, ['"]import['"]\)/u);
  const imported = await fetch(origin + url + '?import');
  assert.equal(imported.status, 200, 'Vite variable imports retain access to admitted UI');
  assert.equal(await imported.text(), await readFile(
    path.join(artifact.root, artifact.artifact.manifest.entries.browser), 'utf8'));
  for (const query of ['?raw', '?t=1', '?import=1', '?import&extra=1', '?import?import'])
    assert.equal((await fetch(origin + url + query)).status, 404);
  for (const file of [
    artifact.artifact.manifest.entries.main,
    'native.binding.json',
    'app.artifact.json',
  ])
    for (const query of ['', '?import'])
      assert.equal(
        (await fetch(origin + '/' + api.appAssetPath(item.hash, 'probe-epoch', file) + query)).status,
        404,
      );
  const direct = JSON.parse(await readFile(descriptor, 'utf8'));
  assert.equal((await fetch(`http://127.0.0.1:${direct.port}${url}`)).status, 404);
  assert.equal((await fetch(origin + url, { method: 'POST' })).status, 404);
  withdraw();
  withdraw = undefined;
  assert.equal((await fetch(origin + url)).status, 404);
  assert.equal((await fetch(origin + url + '?import')).status, 404);
  console.log(
    JSON.stringify({
      actualViteMiddleware: true,
      actualPrivateMainServer: true,
      builtArtifact: item.id,
      sameOriginAsset: true,
      actualViteDynamicImportMarker: true,
      unknownQueriesDenied: true,
      mainBindingIndexHidden: true,
      privateTokenRequired: true,
      wrongMethodDenied: true,
      withdrawalDenied: true,
    }),
  );
} finally {
  withdraw?.();
  await vite?.close();
  await closeMain?.();
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(tmpdir()));
  assert.ok(path.basename(temporary).startsWith('app-dev-assets-'));
  await rm(temporary, { recursive: true, force: true });
}
