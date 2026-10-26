'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const RUNTIME_BUNDLED_DEPENDENCIES_FILENAME = 'runtime-bundled-dependencies.json';
const FORMAT_VERSION = 1;
const SHA256 = /^[a-f0-9]{64}$/;

function fail(message) {
  throw new Error(`[openclaw-bundled-dependencies] ${message}`);
}

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sha512(value) {
  if (typeof value !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const encoded = value.slice(7);
  const bytes = Buffer.from(encoded, 'base64');
  return bytes.length === 64 && bytes.toString('base64') === encoded;
}

function sourceIdentity(sourceLock) {
  if (
    sourceLock?.name !== 'openclaw' ||
    typeof sourceLock.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(sourceLock.version) ||
    !SHA256.test(sourceLock.tarballSha256) ||
    !sha512(sourceLock.integrity)
  ) fail('Invalid locked OpenClaw source identity.');
  return {
    name: sourceLock.name,
    version: sourceLock.version,
    tarballSha256: sourceLock.tarballSha256,
    integrity: sourceLock.integrity,
  };
}

function stat(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') fail(`Missing required path: ${file}`);
    throw error;
  }
}

function exists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function directoryRoot(directory) {
  const info = stat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) fail(`Expected a regular directory: ${directory}`);
  // The caller may use the repository's vendor parent junction. Establish the
  // physical trust root once; every component below it must be an ordinary path.
  return fs.realpathSync(directory);
}

function safeSegment(segment) {
  return (
    segment !== '.' && segment !== '..' && segment.length > 0 &&
    !/[<>:"/\\|?*\x00-\x1f]/.test(segment) && !/[. ]$/.test(segment) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
  );
}

function child(root, relative) {
  if (typeof relative !== 'string' || !relative.split('/').every(safeSegment)) {
    fail(`Unsafe relative path: ${String(relative)}`);
  }
  const target = path.resolve(root, ...relative.split('/'));
  const fromRoot = path.relative(root, target);
  if (!fromRoot || fromRoot.startsWith(`..${path.sep}`) || fromRoot === '..' || path.isAbsolute(fromRoot)) {
    fail(`Path escapes its owner: ${relative}`);
  }
  return target;
}

function regularFile(file) {
  const info = stat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    fail(`Expected a regular file without links: ${file}`);
  }
  return info;
}

function readJson(file) {
  regularFile(file);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    fail(`Invalid JSON: ${file}`);
  }
}

function regularDirectoryBelow(root, relative) {
  let current = root;
  for (const segment of relative.split('/')) {
    current = child(current, segment);
    const info = stat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      fail(`Expected a regular directory without links: ${current}`);
    }
  }
  return current;
}

function bundleNames(pkg) {
  const declarations = ['bundleDependencies', 'bundledDependencies']
    .filter(key => pkg[key] !== undefined)
    .map(key => {
      const values = pkg[key];
      if (!Array.isArray(values)) fail(`Expected an explicit ${key} array.`);
      const names = new Set();
      const folded = new Set();
      for (const name of values) {
        if (
          typeof name !== 'string' ||
          !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) ||
          !name.split('/').every(safeSegment) || names.has(name) || folded.has(name.toLowerCase())
        ) fail(`Invalid or duplicate bundled dependency: ${String(name)}`);
        names.add(name);
        folded.add(name.toLowerCase());
      }
      return [...names].sort(compare);
    });
  if (declarations.length > 1 && !same(declarations[0], declarations[1])) {
    fail('Conflicting bundled dependency declarations.');
  }
  return declarations[0] || [];
}

function packageIdentity(pkg, expected, description) {
  if (pkg?.name !== expected.name || pkg?.version !== expected.version) {
    fail(`${description} package identity does not match the locked source.`);
  }
}

function inventory(root) {
  const files = [];
  function visit(directory, prefix) {
    const entries = fs.readdirSync(directory).sort(compare);
    const folded = new Set();
    for (const entry of entries) {
      if (!safeSegment(entry) || folded.has(entry.toLowerCase())) fail(`Unsafe or colliding tree entry: ${entry}`);
      folded.add(entry.toLowerCase());
      const relative = prefix ? `${prefix}/${entry}` : entry;
      const file = child(root, relative);
      const info = stat(file);
      if (info.isSymbolicLink()) fail(`Links are forbidden in bundled dependencies: ${relative}`);
      if (info.isDirectory()) visit(file, relative);
      else {
        regularFile(file);
        const bytes = fs.readFileSync(file);
        files.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) });
      }
    }
  }
  visit(root, '');
  files.sort((a, b) => compare(a.path, b.path));
  return { treeSha256: digest(JSON.stringify(files)), files };
}

function inspectPackage(root, source) {
  const pkg = readJson(child(root, 'package.json'));
  packageIdentity(pkg, source, 'OpenClaw');
  return { pkg, names: bundleNames(pkg) };
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const childValue of Object.values(value)) deepFreeze(childValue);
    Object.freeze(value);
  }
  return value;
}

// Archive consumers need safe declared prefixes before those subtrees have
// been extracted. This validates metadata only; it is not a file-tree proof.
function readBundledDependencyPaths(runtimeDir, { sourceLock } = {}) {
  const root = directoryRoot(runtimeDir);
  const { names } = inspectPackage(root, sourceIdentity(sourceLock));
  return names.map(name => `node_modules/${name}`);
}

// The archive consumer first admits a declared bundle prefix. Validate every
// remaining segment before extraction, including Windows alternate streams and
// reserved device names; a later tree inventory cannot discover those safely.
function assertBundledDependencyArchiveEntry(relative, type) {
  if (!['File', 'Directory'].includes(type) || typeof relative !== 'string') {
    fail('Bundled dependency archive entries must be regular files or directories.');
  }
  const normalized = type === 'Directory' && relative.endsWith('/') ? relative.slice(0, -1) : relative;
  if (!normalized.split('/').every(safeSegment)) fail('Unsafe bundled dependency archive path.');
  return normalized;
}

// The installer calls this only after it has authenticated the enclosing npm
// archive against source-lock.json. Keep this proof across npm's mutable install.
function inspectPristineBundledDependencies(pristinePackageDir, { sourceLock } = {}) {
  const source = sourceIdentity(sourceLock);
  const root = directoryRoot(pristinePackageDir);
  const { pkg, names } = inspectPackage(root, source);
  const dependencies = names.map(name => {
    const relative = `node_modules/${name}`;
    const directory = regularDirectoryBelow(root, relative);
    const dependency = readJson(child(directory, 'package.json'));
    if (typeof dependency.version !== 'string' || pkg.dependencies?.[name] !== dependency.version) {
      fail(`Bundled dependency ${name} must have the exact declared production version.`);
    }
    packageIdentity(dependency, { name, version: dependency.version }, 'Bundled');
    return { name, version: dependency.version, path: relative, ...inventory(directory) };
  });
  return deepFreeze({ formatVersion: FORMAT_VERSION, source, dependencies });
}

function origins(runtimeRoot, dependencies) {
  if (dependencies.length === 0) return [];
  const lockName = exists(child(runtimeRoot, 'npm-shrinkwrap.json'))
    ? 'npm-shrinkwrap.json' : 'package-lock.json';
  const lock = readJson(child(runtimeRoot, lockName));
  const runtimePackage = readJson(child(runtimeRoot, 'package.json'));
  if (lock.name !== runtimePackage.name || lock.version !== runtimePackage.version) {
    fail('Installed dependency lock has a different root package identity.');
  }
  return dependencies.map(dependency => {
    const entry = lock.packages?.[dependency.path];
    if (entry?.version !== dependency.version || entry.inBundle !== true || !sha512(entry.integrity)) {
      fail(`Missing recorded inBundle registry origin for ${dependency.name}.`);
    }
    let url;
    try { url = new URL(entry.resolved); } catch { fail(`Invalid registry origin for ${dependency.name}.`); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
      fail(`Unsafe registry origin for ${dependency.name}.`);
    }
    return { version: entry.version, resolved: entry.resolved, integrity: entry.integrity, inBundle: true };
  });
}

function inspectTargets(runtimeRoot, proof) {
  const { pkg, names } = inspectPackage(runtimeRoot, proof.source);
  if (!same(names, proof.dependencies.map(dependency => dependency.name))) {
    fail('Staging bundled dependency declarations differ from the pristine source.');
  }
  for (const dependency of proof.dependencies) {
    if (pkg.dependencies?.[dependency.name] !== dependency.version) fail('Staging dependency declaration changed.');
    const directory = regularDirectoryBelow(runtimeRoot, dependency.path);
    packageIdentity(readJson(child(directory, 'package.json')), dependency, 'Installed bundled');
    // Validate even the stock install before replacing it: never traverse a link
    // or delete a tree that can belong to another filesystem owner.
    inventory(directory);
  }
  return origins(runtimeRoot, proof.dependencies);
}

function restorePristineBundledDependencies(runtimeDir, pristinePackageDir, options = {}) {
  const source = directoryRoot(pristinePackageDir);
  const runtime = directoryRoot(runtimeDir);
  for (const [owner, candidate] of [[source, runtime], [runtime, source]]) {
    const relative = path.relative(owner, candidate);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      fail('Pristine and staging runtime directories must be disjoint.');
    }
  }
  const proof = inspectPristineBundledDependencies(source, options);
  if (!options.pristineProof || !same(proof, options.pristineProof)) {
    fail('Pristine bundled dependency bytes changed after source authentication.');
  }
  const baseOrigins = inspectTargets(runtime, proof);
  const manifestPath = child(runtime, RUNTIME_BUNDLED_DEPENDENCIES_FILENAME);
  for (const marker of [
    RUNTIME_BUNDLED_DEPENDENCIES_FILENAME,
    'runtime-build-info.json',
    'runtime-patch-manifest.json',
    '.initial-bundle-pending',
  ]) {
    if (exists(child(runtime, marker))) {
      fail(`Application build marker ${marker} already exists; a fresh staging runtime is required.`);
    }
  }
  const manifest = {
    formatVersion: FORMAT_VERSION,
    source: proof.source,
    dependencies: proof.dependencies.map((dependency, index) => ({
      name: dependency.name, version: dependency.version, path: dependency.path,
      baseOrigin: baseOrigins[index], treeSha256: dependency.treeSha256, files: dependency.files,
    })),
  };
  const temporary = fs.mkdtempSync(path.join(runtime, '.bundled-dependencies-'));
  const changed = [];
  let manifestInstalled = false;
  let retainRecoveryDirectory = false;
  try {
    for (let index = 0; index < proof.dependencies.length; index++) {
      const dependency = proof.dependencies[index];
      const copied = child(temporary, `copy-${index}`);
      fs.cpSync(child(source, dependency.path), copied, {
        recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true,
      });
      if (!same(inventory(copied), { treeSha256: dependency.treeSha256, files: dependency.files })) {
        fail(`Copied bundled dependency bytes changed: ${dependency.name}`);
      }
    }
    // Complete every source, target and lock check before replacing any package.
    if (!same(inspectPristineBundledDependencies(source, options), proof) ||
        !same(inspectTargets(runtime, proof), baseOrigins)) fail('Bundled dependency inputs changed during preparation.');
    const stagedManifest = child(temporary, 'manifest.json');
    fs.writeFileSync(stagedManifest, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
    for (let index = 0; index < proof.dependencies.length; index++) {
      const target = child(runtime, proof.dependencies[index].path);
      const backup = child(temporary, `backup-${index}`);
      fs.renameSync(target, backup);
      const entry = { target, backup, installed: false };
      changed.push(entry);
      fs.renameSync(child(temporary, `copy-${index}`), target);
      entry.installed = true;
    }
    fs.renameSync(stagedManifest, manifestPath);
    manifestInstalled = true;
    verifyBundledDependencies(runtime, { sourceLock: options.sourceLock });
    return manifest;
  } catch (error) {
    try {
      if (manifestInstalled) fs.unlinkSync(manifestPath);
      for (const entry of changed.reverse()) {
        if (entry.installed) fs.rmSync(entry.target, { recursive: true, force: true });
        fs.renameSync(entry.backup, entry.target);
      }
    } catch (rollbackError) {
      retainRecoveryDirectory = true;
      throw new AggregateError([error, rollbackError], 'Bundled dependency restoration rollback failed.');
    }
    throw error;
  } finally {
    if (!retainRecoveryDirectory) {
      fs.rmSync(child(runtime, path.basename(temporary)), { recursive: true, force: true });
    }
  }
}

function verifyBundledDependencies(runtimeDir, { sourceLock } = {}) {
  const runtime = directoryRoot(runtimeDir);
  const source = sourceIdentity(sourceLock);
  const manifest = readJson(child(runtime, RUNTIME_BUNDLED_DEPENDENCIES_FILENAME));
  if (manifest?.formatVersion !== FORMAT_VERSION || !same(manifest.source, source) || !Array.isArray(manifest.dependencies)) {
    fail('Bundled dependency proof has an invalid format or source identity.');
  }
  const { names } = inspectPackage(runtime, source);
  if (!same(names, manifest.dependencies.map(dependency => dependency?.name))) {
    fail('Bundled dependency proof does not cover the complete declared bundle.');
  }
  const baseOrigins = inspectTargets(runtime, manifest);
  for (let index = 0; index < manifest.dependencies.length; index++) {
    const dependency = manifest.dependencies[index];
    if (dependency.path !== `node_modules/${dependency.name}` || !same(dependency.baseOrigin, baseOrigins[index])) {
      fail(`Bundled dependency origin or path changed: ${dependency.name}`);
    }
    const actual = inventory(regularDirectoryBelow(runtime, dependency.path));
    if (!same(actual, { treeSha256: dependency.treeSha256, files: dependency.files })) {
      fail(`Bundled dependency tree changed: ${dependency.name}`);
    }
  }
  return manifest;
}

module.exports = {
  RUNTIME_BUNDLED_DEPENDENCIES_FILENAME,
  readBundledDependencyPaths,
  assertBundledDependencyArchiveEntry,
  inspectPristineBundledDependencies,
  restorePristineBundledDependencies,
  verifyBundledDependencies,
};
