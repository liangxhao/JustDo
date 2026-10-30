import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { parseAppPluginManifest } from '@app-plugin/sdk/contracts';
import { APP_NATIVE_PROFILE } from '@app-plugin/sdk/native-profile';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const receiptName = 'extension-assembly-receipt.json';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hashFile = file => sha(fs.readFileSync(file));
const slash = value => value.replaceAll('\\', '/');

function inside(root, relative) {
  assert.equal(typeof relative, 'string');
  assert.ok(relative.length > 0 && !path.isAbsolute(relative));
  const resolved = path.resolve(root, relative);
  const child = path.relative(root, resolved);
  assert.ok(child && child !== '..' && !child.startsWith('..' + path.sep) && !path.isAbsolute(child),
    `Assembly path escapes its owner: ${relative}`);
  return resolved;
}

function verifyFiles(root, records, sourceRoot = root) {
  assert.ok(Array.isArray(records) && records.length > 0);
  const seen = new Set();
  for (const record of records) {
    assert.ok(!seen.has(record.path), `Duplicate assembly input: ${record.path}`);
    seen.add(record.path);
    assert.ok(record.root === undefined || record.root === 'source');
    const file = inside(record.root === 'source' ? sourceRoot : root, record.path);
    if (record.link !== undefined) {
      assert.equal(typeof record.link, 'string');
      assert.ok(fs.lstatSync(file).isSymbolicLink());
      assert.equal(fs.readlinkSync(file), record.link);
    } else {
      assert.ok(fs.lstatSync(file).isFile(), `Assembly file is not a regular file: ${record.path}`);
      assert.equal(hashFile(file), record.sha256, `Assembly bytes changed: ${record.path}`);
      if (record.size !== undefined) assert.equal(fs.statSync(file).size, record.size);
    }
  }
}

function extensionPaths(runtime) {
  const paths = [];
  const visit = directory => {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) visit(file);
      else {
        assert.ok(stat.isFile() || stat.isSymbolicLink(), `Unsupported assembly entry: ${file}`);
        paths.push(slash(path.relative(runtime, file)));
      }
    }
  };
  visit(path.join(runtime, 'dist/extensions'));
  return paths.sort();
}

/**
 * Read-only reproduction of explicitly selected or currently declared app extension bundles.
 * Callers must first admit the current frozen core; this never prepares a runtime.
 */
export function verifyCollaborationExtensionAssembly(requestedRuntime, options = {}) {
  const sourceRoot = path.resolve(options.sourceRoot ??
    process.env.APP_PLUGIN_PROBE_SOURCE_ROOT ?? path.join(repository, 'plugins/extensions'));
  let directories;
  try {
    directories = fs.readdirSync(sourceRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    directories = [];
  }
  const available = [];
  for (const entry of directories) {
    if (!entry.isDirectory()) continue;
    const file = path.join(sourceRoot, entry.name, 'app.plugin.json');
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    assert.ok(/^[a-z][a-z0-9-]{0,95}$/u.test(entry.name));
    assert.equal(manifest.id, entry.name);
    available.push(entry.name);
  }
  const extensionIds = options.extensionIds ?? available.sort();
  assert.ok(Array.isArray(extensionIds) && extensionIds.every(id => available.includes(id)),
    'An explicitly selected extension source is missing');
  const runtime = fs.realpathSync(requestedRuntime);
  const manifestFile = path.join(runtime, 'runtime-patch-manifest.json');
  const manifestSha256 = hashFile(manifestFile);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const sourcePaths = new Map();
  const addSource = file => {
    const relative = slash(path.relative(repository, file));
    const external = relative === '..' || relative.startsWith('../') || path.isAbsolute(relative);
    const record = external
      ? { root: 'source', path: slash(path.relative(sourceRoot, file)) }
      : { path: relative };
    inside(external ? sourceRoot : repository, record.path);
    sourcePaths.set(`${record.root ?? 'host'}:${record.path}`, record);
  };
  const entries = [];
  for (const id of extensionIds) {
    const directory = path.join(sourceRoot, id);
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    assert.ok(pkg.app && typeof pkg.app === 'object', 'App extensions require independent app build declarations');
    assert.equal(pkg.openclaw.extensions.length, 1);
    const appManifest = parseAppPluginManifest(JSON.parse(fs.readFileSync(path.join(directory, 'app.plugin.json'), 'utf8')));
    assert.equal(appManifest.id, id);
    assert.equal(appManifest.nativePluginId, id);
    assert.equal(pkg.version, appManifest.version);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'openclaw.plugin.json'), 'utf8')).id, id);
    assert.ok(fs.lstatSync(inside(directory, pkg.app.main)).isFile());
    assert.ok(fs.lstatSync(inside(directory, pkg.app.browser)).isFile());
    const nativeEntry = inside(directory, pkg.openclaw.extensions[0]);
    const output = path.join(runtime, 'dist/extensions', id, 'index.js');
    // Reproduce the public builder's Native surface, including its authenticated
    // dispatch wrapper and bundled npm/SDK closure. Main/UI are checked below as
    // an immutable companion; this guard does not claim a fresh UI source build.
    const compiled = buildSync({
      absWorkingDir: directory,
      tsconfigRaw: {},
      nodePaths: [path.join(repository, 'node_modules')],
      stdin: {
        contents: `
          import * as entry from ${JSON.stringify(nativeEntry)};
          export * from ${JSON.stringify(nativeEntry)};
          import { dispatchGatewayMethod } from 'openclaw/plugin-sdk/gateway-method-runtime';
          import { withAppNative } from '@app-plugin/sdk/native';
          export default withAppNative(entry.default ?? entry, dispatchGatewayMethod);
        `,
        resolveDir: directory, sourcefile: 'app-native-entry.mjs', loader: 'js',
      },
      bundle: true, platform: 'node', format: 'esm', target: 'node24',
      external: ['openclaw/plugin-sdk/*'], write: false, metafile: true,
    });
    assert.equal(compiled.outputFiles.length, 1);
    assert.ok(Buffer.from(compiled.outputFiles[0].contents).equals(fs.readFileSync(output)),
      `Current native ${id} bundle does not match the production source closure.`);
    for (const input of Object.keys(compiled.metafile.inputs)) {
      if (input === 'app-native-entry.mjs') continue; // The public builder's fixed virtual entry.
      assert.ok(!input.startsWith('<'), `Unbound virtual assembly input: ${input}`);
      addSource(path.resolve(directory, input));
    }
    for (const name of ['package.json', 'openclaw.plugin.json', 'app.plugin.json'])
      addSource(path.join(directory, name));
    const installedRoot = path.dirname(output);
    const installedPackage = JSON.parse(fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf8'));
    assert.deepEqual(installedPackage.openclaw.extensions, ['./index.js']);
    assert.equal(installedPackage.name, pkg.name);
    assert.equal(installedPackage.version, appManifest.version);
    for (const field of ['app', 'scripts', 'dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])
      assert.equal(installedPackage[field], undefined, `Install packages must not retain source declaration ${field}`);
    const nativeManifest = JSON.parse(fs.readFileSync(path.join(installedRoot, 'openclaw.plugin.json'), 'utf8'));
    assert.equal(nativeManifest.id, id);
    assert.ok(nativeManifest.contracts.gatewayMethodDispatch.includes('authenticated-request'));
    const companion = path.join(installedRoot, 'app');
    const artifact = JSON.parse(fs.readFileSync(path.join(companion, 'app.artifact.json'), 'utf8'));
    assert.deepEqual(artifact.manifest, appManifest);
    assert.equal(artifact.hash, sha(JSON.stringify({ manifest: artifact.manifest, files: artifact.files })));
    for (const required of [appManifest.entries.main, appManifest.entries.browser, ...(appManifest.entries.presentation ? [appManifest.entries.presentation] : []), 'native.binding.json'])
      assert.ok(Object.hasOwn(artifact.files, required), `Missing companion file: ${required}`);
    verifyFiles(companion, Object.entries(artifact.files).map(([name, sha256]) => ({ path: name, sha256 })));
    const nativeBinding = JSON.parse(fs.readFileSync(path.join(companion, 'native.binding.json'), 'utf8'));
    assert.equal(nativeBinding.entry, 'index.js');
    assert.equal(nativeBinding.profile, APP_NATIVE_PROFILE);
    assert.equal(nativeBinding.sha256, hashFile(output));
    entries.push({ id, path: slash(path.relative(runtime, output)), sha256: hashFile(output) });
  }
  const sources = [...sourcePaths.values()].sort((left, right) =>
    (`${left.root ?? 'host'}:${left.path}` < `${right.root ?? 'host'}:${right.path}` ? -1 : 1))
    .map(record => ({ ...record,
      sha256: hashFile(inside(record.root === 'source' ? sourceRoot : repository, record.path)) }));
  let receiptSha256;
  const receiptFile = path.join(runtime, receiptName);
  if (fs.existsSync(receiptFile)) {
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    assert.equal(receipt.formatVersion, 1);
    assert.equal(receipt.core.manifestSha256, manifestSha256);
    assert.equal(receipt.core.buildRecipeSha256, manifest.buildRecipeSha256);
    assert.equal(receipt.core.patchSetSha256, manifest.patchSetSha256);
    assert.equal(receipt.core.gatewayBundleSha256, hashFile(path.join(runtime, 'gateway-bundle.mjs')));
    assert.equal(receipt.core.gatewayAsarSha256, hashFile(path.join(runtime, 'gateway.asar')));
    const requiredSources = options.extensionIds
      ? receipt.sources.filter(record => sourcePaths.has(`${record.root ?? 'host'}:${record.path}`))
      : receipt.sources;
    verifyFiles(repository, requiredSources, sourceRoot);
    assert.deepEqual(requiredSources.map(({ path: relative, sha256, root }) =>
      ({ ...(root ? { root } : {}), path: relative, sha256 })), sources,
      'The assembly receipt must contain the complete current production source closure.');
    assert.ok(receipt.outputs.every(record => slash(record.path).startsWith('dist/extensions/')));
    verifyFiles(runtime, receipt.outputs);
    assert.deepEqual(receipt.outputs.map(record => slash(record.path)).sort(), extensionPaths(runtime),
      'The receipt must cover the complete extension output inventory.');
    verifyFiles(repository, receipt.tools);
    for (const entry of entries) {
      assert.equal(receipt.extensions[entry.id].entry, entry.path);
      assert.equal(receipt.extensions[entry.id].sha256, entry.sha256);
    }
    receiptSha256 = hashFile(receiptFile);
  }
  const assemblySha256 = sha(JSON.stringify({ manifestSha256, sources, entries }));
  return { manifestSha256, assemblySha256, sources, entries,
    ...(receiptSha256 ? { receiptSha256 } : {}) };
}
