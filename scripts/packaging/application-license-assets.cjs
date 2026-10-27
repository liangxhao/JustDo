'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { fileURLToPath } = require('node:url');
const { isLegalMetadataFile } = require('../openclaw/prune-openclaw-runtime.cjs');

const REQUIRED_APPLICATION_LICENSE_SCOPES = Object.freeze([
  'renderer', 'main', 'preload', 'imagePreviewPreload', 'browserGuestPreload', 'widgetViewerPreload', 'webpageEmbedPreload',
]);
const SOURCE_PROOF = 'source-proof.json';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const posix = value => value.replaceAll('\\', '/');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sortedJson = value => JSON.stringify(value, null, 2) + '\n';
const isCodeOutput = file => /\.(?:[cm]?js|css|html)$/i.test(file) && !/\.map$/i.test(file);

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function locations(options) {
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '../..'));
  const outputRoot = path.resolve(options.outputRoot || path.join(repoRoot, 'build/application-licenses'));
  if (!isWithin(path.join(repoRoot, 'build'), outputRoot) || outputRoot === path.join(repoRoot, 'build')) {
    throw new Error('Application license assets must stay inside a dedicated repository build directory.');
  }
  return { repoRoot, outputRoot };
}

function assertOrdinaryDirectory(directory) {
  if (fs.existsSync(directory) && (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink())) {
    throw new Error('Application license directory must not be a link: ' + directory);
  }
}

function assertOwnedBuildPath(repoRoot, target) {
  const buildRoot = path.join(repoRoot, 'build');
  if (!isWithin(buildRoot, target)) throw new Error('Application license path escapes repository build: ' + target);
  const physicalBuildRoot = path.join(fs.realpathSync(repoRoot), 'build');
  let current = repoRoot;
  for (const segment of path.relative(repoRoot, target).split(path.sep)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) break;
    assertOrdinaryDirectory(current);
    if (!isWithin(physicalBuildRoot, fs.realpathSync(current))) throw new Error('Application license ancestor escapes repository build: ' + current);
  }
}

function moduleFile(id, dependencyRoot) {
  let file = id.replace(/^\0+/, '').replace(/\?.*$/, '').replace(/#.*$/, '');
  if (file.startsWith('file:')) file = fileURLToPath(file);
  if (file.startsWith('/@fs/')) file = file.slice(5);
  if (process.platform === 'win32' && /^\/[A-Za-z]:\//.test(file)) file = file.slice(1);
  if (!path.isAbsolute(file)) return null;
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
    if (posix(file).includes('/node_modules/') || (dependencyRoot && isWithin(dependencyRoot, file))) throw new Error('Bundled dependency module source is missing: ' + file);
    return null;
  }
  const realFile = fs.realpathSync(file);
  if (!posix(file).includes('/node_modules/') && !posix(realFile).includes('/node_modules/') &&
      !(dependencyRoot && isWithin(dependencyRoot, realFile))) return null;
  return realFile;
}

function packageOwner(file) {
  let directory = path.dirname(file);
  while (true) {
    const manifestPath = path.join(directory, 'package.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = readJson(manifestPath);
      // Export-condition subdirectories often contain only { type: 'module' }.
      if (typeof manifest.name === 'string' && typeof manifest.version === 'string') return { directory, manifest };
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Bundled dependency has no package owner: ' + file);
    directory = parent;
  }
}

function legalFiles(directory) {
  const files = ['package.json'];
  const physicalRoot = fs.realpathSync(directory);
  if (!isWithin(physicalRoot, fs.realpathSync(path.join(directory, 'package.json')))) throw new Error('Dependency package metadata escapes its owner: ' + directory);
  const visited = new Set();
  function visit(target, relative) {
    const physical = fs.realpathSync(target);
    if (!isWithin(physicalRoot, physical)) throw new Error('Dependency legal metadata escapes its package: ' + target);
    const stat = fs.statSync(target);
    if (stat.isFile()) { files.push(posix(relative)); return; }
    if (!stat.isDirectory()) throw new Error('Unsupported dependency legal metadata: ' + target);
    if (visited.has(physical)) throw new Error('Dependency legal directory has a cycle: ' + target);
    visited.add(physical);
    for (const entry of fs.readdirSync(target).sort()) visit(path.join(target, entry), path.join(relative, entry));
    visited.delete(physical);
  }
  for (const entry of fs.readdirSync(directory).sort()) {
    if (isLegalMetadataFile(entry)) visit(path.join(directory, entry), entry);
  }
  return [...new Set(files)].sort();
}

function packageInventory(directory) {
  return legalFiles(directory).map(file => {
    const bytes = fs.readFileSync(path.join(directory, file));
    return { path: file, size: bytes.length, sha256: sha256(bytes) };
  });
}

function fileInventory(directory, excludeSourceProof = false) {
  const entries = [];
  function visit(target, relative = '') {
    for (const entry of fs.readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = relative ? relative + '/' + entry.name : entry.name;
      if (excludeSourceProof && (file === SOURCE_PROOF || REQUIRED_APPLICATION_LICENSE_SCOPES.some(scope => file === scope + '/' + SOURCE_PROOF))) continue;
      const absolute = path.join(target, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Application legal payload contains a link: ' + absolute);
      if (entry.isDirectory()) visit(absolute, file);
      else if (entry.isFile()) {
        const bytes = fs.readFileSync(absolute);
        entries.push({ path: file, size: bytes.length, sha256: sha256(bytes) });
      } else throw new Error('Unsupported application legal payload entry: ' + absolute);
    }
  }
  visit(directory);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function writeScope(options, outputOptions, bundle) {
  const { repoRoot, outputRoot } = locations(options);
  const { scope } = options;
  if (!REQUIRED_APPLICATION_LICENSE_SCOPES.includes(scope)) throw new Error('Unknown application license scope: ' + scope);
  const outputDirectory = path.resolve(outputOptions.dir || path.dirname(outputOptions.file));
  const modules = [...new Set(Object.values(bundle).flatMap(output => output.type === 'chunk' ? Object.keys(output.modules) : []))].sort();
  const dependencyDirectory = path.join(repoRoot, 'node_modules');
  const dependencyRoot = fs.existsSync(dependencyDirectory) ? fs.realpathSync(dependencyDirectory) : null;
  const ownerDirectories = new Set(modules.map(id => moduleFile(id, dependencyRoot)).filter(Boolean).map(file => packageOwner(file).directory));
  const packages = new Map();
  const sources = [];
  for (const directory of [...ownerDirectories].sort()) {
    const manifest = readJson(path.join(directory, 'package.json'));
    const files = packageInventory(directory);
    const id = sha256(JSON.stringify({ name: manifest.name, version: manifest.version, files })).slice(0, 24);
    const entry = { id, name: manifest.name, version: manifest.version, license: manifest.license ?? null,
      noSeparateLegalFiles: files.length === 1, files };
    packages.set(id, entry);
    sources.push({ id, directory });
  }
  const outputs = Object.keys(bundle).filter(isCodeOutput).sort().map(file => {
    const absolute = path.resolve(outputDirectory, file);
    if (!isWithin(outputDirectory, absolute)) throw new Error('Bundled output escapes its directory: ' + file);
    return { path: posix(file), sha256: sha256(fs.readFileSync(absolute)) };
  });
  if (!outputs.length) throw new Error('Application license scope emitted no code: ' + scope);
  assertOwnedBuildPath(repoRoot, outputRoot);
  fs.mkdirSync(outputRoot, { recursive: true });
  const scopeRoot = path.join(outputRoot, scope);
  assertOwnedBuildPath(repoRoot, scopeRoot);
  const staging = path.join(outputRoot, scope + '-' + randomUUID() + '.tmp');
  assertOwnedBuildPath(repoRoot, staging);
  fs.mkdirSync(staging);
  try {
    for (const source of sources) {
      for (const file of packages.get(source.id).files) {
        const target = path.join(staging, 'packages', source.id, file.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(source.directory, file.path), target);
      }
    }
    const manifest = { schemaVersion: 1, scope, packages: [...packages.values()].sort((a, b) => a.id.localeCompare(b.id)) };
    fs.writeFileSync(path.join(staging, 'manifest.json'), sortedJson(manifest));
    const payload = fileInventory(staging);
    fs.writeFileSync(path.join(staging, SOURCE_PROOF), sortedJson({ schemaVersion: 1, scope, outputDirectory, outputs, sources, payload }));
    // Each scope owns only its own tree; concurrent Electron bundles never remove siblings.
    if (fs.existsSync(scopeRoot)) {
      assertOwnedBuildPath(repoRoot, scopeRoot);
      fs.rmSync(scopeRoot, { recursive: true, force: true });
    }
    fs.renameSync(staging, scopeRoot);
  } finally {
    if (fs.existsSync(staging)) {
      assertOwnedBuildPath(repoRoot, staging);
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
}

function createApplicationLicensePlugin(options) {
  return { name: 'application-license-assets-' + options.scope, apply: 'build', enforce: 'post',
    writeBundle(outputOptions, bundle) { writeScope(options, outputOptions, bundle); } };
}

function verifyApplicationLicenseAssets(options = {}) {
  const { repoRoot, outputRoot } = locations(options);
  assertOwnedBuildPath(repoRoot, outputRoot);
  const scopes = fs.readdirSync(outputRoot).sort();
  const expectedScopes = [...REQUIRED_APPLICATION_LICENSE_SCOPES].sort();
  if (JSON.stringify(scopes) !== JSON.stringify(expectedScopes)) throw new Error('Application license scopes are missing, stale or unexpected. Rebuild the application.');
  let packages = 0;
  let files = 0;
  for (const scope of expectedScopes) {
    const directory = path.join(outputRoot, scope);
    assertOrdinaryDirectory(directory);
    const manifest = readJson(path.join(directory, 'manifest.json'));
    const proof = readJson(path.join(directory, SOURCE_PROOF));
    if (proof.schemaVersion !== 1 || manifest.schemaVersion !== 1 || proof.scope !== scope || manifest.scope !== scope) {
      throw new Error('Application license proof identity mismatch: ' + scope);
    }
    const actual = fileInventory(directory, true);
    if (JSON.stringify(actual) !== JSON.stringify(proof.payload)) throw new Error('Application license assets changed, are missing or have unexpected files: ' + scope);
    for (const output of proof.outputs) {
      if (sha256(fs.readFileSync(path.join(proof.outputDirectory, output.path))) !== output.sha256) throw new Error('Bundled application output changed; rebuild license assets: ' + scope + '/' + output.path);
    }
    for (const source of proof.sources) {
      const expected = manifest.packages.find(entry => entry.id === source.id);
      const current = readJson(path.join(source.directory, 'package.json'));
      if (!expected || current.name !== expected.name || current.version !== expected.version ||
          JSON.stringify(packageInventory(source.directory)) !== JSON.stringify(expected.files)) {
        throw new Error('Bundled dependency legal source changed; rebuild application: ' + source.directory);
      }
    }
    const declared = ['manifest.json', ...manifest.packages.flatMap(entry => entry.files.map(file => 'packages/' + entry.id + '/' + file.path))].sort();
    if (JSON.stringify(actual.map(file => file.path).sort()) !== JSON.stringify(declared)) throw new Error('Application license manifest does not describe its exact payload: ' + scope);
    packages += manifest.packages.length;
    files += actual.length;
  }
  if (options.packagedRoot) {
    assertOrdinaryDirectory(options.packagedRoot);
    if (JSON.stringify(fileInventory(outputRoot, true)) !== JSON.stringify(fileInventory(options.packagedRoot))) {
      throw new Error('Packaged application legal metadata is missing, changed or unexpected.');
    }
  }
  return { scopes: expectedScopes.length, packages, files };
}

module.exports = { REQUIRED_APPLICATION_LICENSE_SCOPES, createApplicationLicensePlugin, verifyApplicationLicenseAssets };
