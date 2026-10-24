import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const extensionIds = ['agent-team', 'swarm-workflow'];
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

function verifyFiles(root, records) {
  assert.ok(Array.isArray(records) && records.length > 0);
  const seen = new Set();
  for (const record of records) {
    assert.ok(!seen.has(record.path), `Duplicate assembly input: ${record.path}`);
    seen.add(record.path);
    const file = inside(root, record.path);
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
 * Read-only reproduction of the two official native extension bundles.
 * Callers must first admit the current frozen core; this never prepares a runtime.
 */
export function verifyCollaborationExtensionAssembly(requestedRuntime) {
  const runtime = fs.realpathSync(requestedRuntime);
  const manifestFile = path.join(runtime, 'runtime-patch-manifest.json');
  const manifestSha256 = hashFile(manifestFile);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const sourcePaths = new Set();
  const entries = [];
  for (const id of extensionIds) {
    const directory = path.join(repository, 'plugins/extensions', id);
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    assert.equal(pkg.justdo.bundle, true);
    assert.equal(pkg.openclaw.extensions.length, 1);
    const output = path.join(runtime, 'dist/extensions', id, 'index.js');
    const compiled = buildSync({ absWorkingDir: repository,
      entryPoints: [inside(directory, pkg.openclaw.extensions[0])], outfile: output,
      bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external',
      write: false, metafile: true });
    assert.equal(compiled.outputFiles.length, 1);
    assert.ok(Buffer.from(compiled.outputFiles[0].contents).equals(fs.readFileSync(output)),
      `Current native ${id} bundle does not match the production source closure.`);
    for (const input of Object.keys(compiled.metafile.inputs)) {
      assert.ok(!input.startsWith('<'), `Unbound virtual assembly input: ${input}`);
      const relative = slash(path.relative(repository, path.resolve(repository, input)));
      inside(repository, relative);
      sourcePaths.add(relative);
    }
    for (const name of ['package.json', 'openclaw.plugin.json'])
      sourcePaths.add(`plugins/extensions/${id}/${name}`);
    entries.push({ id, path: slash(path.relative(runtime, output)), sha256: hashFile(output) });
  }
  const sources = [...sourcePaths].sort().map(relative => ({ path: relative,
    sha256: hashFile(inside(repository, relative)) }));
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
    verifyFiles(repository, receipt.sources);
    assert.deepEqual(receipt.sources.map(({ path: relative, sha256 }) => ({ path: relative, sha256 })), sources,
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
