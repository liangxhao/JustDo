'use strict';

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { assertNoRunningGateways } = require('./app-plugin-runtime-processes.cjs');

const ID = /^[a-z][a-z0-9-]{0,95}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const stat = file => {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
};
const json = file => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
};

/** A removed source is not authority to delete a same-ID replacement or linked directory. */
function snapshot(directory) {
  const files = Object.create(null);
  let bytes = 0;
  let count = 0;
  const visit = relative => {
    const absolute = path.resolve(directory, relative);
    const entry = stat(absolute);
    if (!entry || entry.isSymbolicLink() || fs.realpathSync(absolute) !== absolute) return false;
    if (entry.isDirectory()) {
      files[relative + '/'] = 'directory';
      for (const name of fs.readdirSync(absolute).sort()) {
        if (!visit(relative ? relative + '/' + name : name)) return false;
      }
      return true;
    }
    if (!entry.isFile() || ++count > 4096 || entry.size > 64 * 1024 * 1024) return false;
    bytes += entry.size;
    if (bytes > 256 * 1024 * 1024) return false;
    files[relative] = digest(fs.readFileSync(absolute));
    return true;
  };
  return visit('') ? { files, bytes, signature: digest(JSON.stringify(files)) } : null;
}

function catalogIds(workspace) {
  const file = path.join(workspace, 'build/app-plugins/catalog.json');
  if (!stat(file)) return null;
  const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(catalog)) throw new Error('Invalid app plugin catalog');
  const ids = new Set();
  for (const entry of catalog) {
    if (
      typeof entry?.id !== 'string' ||
      typeof entry?.hash !== 'string' ||
      !ID.test(entry.id) ||
      !HASH.test(entry.hash) ||
      ids.has(entry.id)
    )
      throw new Error('Invalid app plugin catalog identity');
    ids.add(entry.id);
  }
  return ids;
}

/** Read-only plan, backed by an exact retained build package rather than a directory name. */
function findRetiredAppPlugins(repoRoot, runtimeRoot) {
  const workspace = fs.realpathSync(repoRoot);
  const ids = catalogIds(workspace);
  if (!ids || !stat(runtimeRoot)) return [];
  const runtime = fs.realpathSync(runtimeRoot);
  const extensions = path.join(runtime, 'dist/extensions');
  if (!stat(extensions)) return [];
  if (fs.realpathSync(extensions) !== extensions || stat(extensions).isSymbolicLink())
    throw new Error('App plugin runtime extensions must not be linked');
  const retired = [];
  for (const entry of fs.readdirSync(extensions, { withFileTypes: true })) {
    if (!entry.isDirectory() || !ID.test(entry.name) || ids.has(entry.name)) continue;
    if (stat(path.join(workspace, 'plugins/extensions', entry.name))) continue;
    const target = path.join(extensions, entry.name);
    const app = path.join(target, 'app');
    const index = path.join(app, 'app.artifact.json');
    if (
      fs.realpathSync(target) !== target ||
      !stat(app)?.isDirectory() ||
      stat(app).isSymbolicLink() ||
      fs.realpathSync(app) !== app ||
      !stat(index)?.isFile() ||
      stat(index).isSymbolicLink()
    )
      continue;
    const artifact = json(index);
    if (
      !artifact ||
      !HASH.test(artifact.hash) ||
      artifact.manifest?.id !== entry.name ||
      artifact.manifest?.nativePluginId !== entry.name
    )
      continue;
    const retained = path.join(workspace, 'build/app-plugins', entry.name, artifact.hash);
    const built = path.join(workspace, 'build/app-plugins/packages', entry.name, artifact.hash);
    if (!stat(retained) || !stat(built)) continue;
    const retainedTree = snapshot(retained);
    const expected = snapshot(built);
    const actual = snapshot(target);
    if (!retainedTree || !expected || !actual || actual.signature !== expected.signature) continue;
    const indexDigest = digest(JSON.stringify(artifact));
    if (
      digest(JSON.stringify(json(path.join(retained, 'app.artifact.json')))) !== indexDigest ||
      digest(JSON.stringify(json(path.join(built, 'app/app.artifact.json')))) !== indexDigest ||
      !artifact.files ||
      typeof artifact.files !== 'object' ||
      Array.isArray(artifact.files)
    )
      continue;
    const files = Object.fromEntries(
      Object.entries(artifact.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    if (digest(JSON.stringify({ manifest: artifact.manifest, files })) !== artifact.hash) continue;
    const indexed = Object.keys(retainedTree.files).filter(
      name => !name.endsWith('/') && name !== 'app.artifact.json',
    );
    if (
      indexed.length !== Object.keys(files).length ||
      indexed.some(name => retainedTree.files[name] !== files[name])
    )
      continue;
    const binding = json(path.join(retained, 'native.binding.json'));
    if (binding?.entry !== 'index.js' || binding.sha256 !== expected.files['index.js']) continue;
    const relative = path.relative(extensions, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('App plugin retirement escaped the runtime');
    retired.push({
      id: entry.name,
      hash: artifact.hash,
      target,
      signature: actual.signature,
      bytes: actual.bytes,
    });
  }
  return retired;
}

function retireAppPlugins(repoRoot, runtimeRoot, options = {}) {
  const planned = findRetiredAppPlugins(repoRoot, runtimeRoot);
  if (!planned.length) return [];
  assertNoRunningGateways(
    [path.resolve(runtimeRoot), fs.realpathSync(runtimeRoot)],
    options.findRunningGateways,
  );
  for (const candidate of planned) {
    // Recheck source absence, catalog, canonical paths and bytes after process discovery.
    const current = findRetiredAppPlugins(repoRoot, runtimeRoot).find(
      item => item.id === candidate.id,
    );
    if (
      !current ||
      current.target !== candidate.target ||
      current.signature !== candidate.signature
    )
      throw new Error(`Retired app plugin changed before removal: ${candidate.id}`);
    fs.rmSync(current.target, { recursive: true, force: false, maxRetries: 5, retryDelay: 200 });
  }
  return planned;
}

module.exports = { findRetiredAppPlugins, retireAppPlugins };
