'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const lock = require('../../src/shared/openclaw/nodeRuntime.json');

const MANIFEST = 'node-runtime-manifest.json';
const ROOT = path.resolve(__dirname, '../..');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function hostTarget() {
  const platform = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform];
  return `${platform}-${process.arch}`;
}

function targetContract(target) {
  const contract = lock.targets[target];
  if (!contract) throw new Error(`Unsupported bundled Node target: ${target}`);
  return contract;
}

function inventory(root) {
  const files = {};
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file).replace(/\\/g, '/');
      if (relative === MANIFEST) continue;
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) files[relative] = { sha256: hash(file) };
      else if (entry.isSymbolicLink()) {
        const link = fs.readlinkSync(file);
        const resolved = path.relative(root, path.resolve(path.dirname(file), link));
        if (path.isAbsolute(link) || resolved === '..' || resolved.startsWith(`..${path.sep}`)) {
          throw new Error(`Bundled Node link escapes its distribution: ${relative}`);
        }
        files[relative] = { link };
      } else throw new Error(`Unsupported bundled Node artifact: ${relative}`);
    }
  }
  visit(root);
  return files;
}

function verifyNodeRuntime(root, target, options = {}) {
  const contract = targetContract(target);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8'));
  if (manifest.version !== lock.version || manifest.target !== target ||
      manifest.archiveSha256 !== contract.sha256 || manifest.archive !== contract.archive ||
      manifest.executable !== contract.executable || !manifest.files?.[contract.executable]?.sha256) {
    throw new Error(`Bundled Node runtime target/source proof does not match ${target} Node ${lock.version}`);
  }
  for (const relative of [contract.executable, 'LICENSE', `${contract.npmBin}/npm-cli.js`, `${contract.npmBin}/npx-cli.js`]) {
    if (!fs.statSync(path.join(root, relative), { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Bundled Node distribution is incomplete: ${relative}`);
    }
  }
  if (options.complete !== false) {
    const actual = inventory(root);
    // Locale-dependent traversal order is not part of the file identity.
    if (Object.keys(actual).length !== Object.keys(manifest.files).length ||
        Object.entries(actual).some(([relative, proof]) =>
          !Object.hasOwn(manifest.files, relative) ||
          JSON.stringify(proof) !== JSON.stringify(manifest.files[relative]))) {
      throw new Error(`Bundled Node distribution has missing, changed or unexpected files: ${root}`);
    }
  } else if (hash(path.join(root, contract.executable)) !== manifest.files[contract.executable].sha256) {
    throw new Error(`Bundled Node executable changed: ${root}`);
  }
  if (options.execute && target === hostTarget()) {
    const result = spawnSync(path.join(root, contract.executable), ['-p', 'process.versions.node'], {
      encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });
    if (result.status !== 0 || result.stdout.trim() !== lock.version) {
      throw new Error(`Bundled Node execution failed: ${result.stderr || result.error || result.stdout}`);
    }
  }
  return manifest;
}

async function extractArchive(archive, destination) {
  if (!archive.endsWith('.zip')) {
    await require('tar').x({ file: archive, cwd: destination });
    return;
  }
  const yauzl = require('yauzl');
  await new Promise((resolve, reject) => {
    yauzl.open(archive, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      zip.on('error', reject);
      zip.on('end', resolve);
      zip.on('entry', entry => {
        const file = path.resolve(destination, entry.fileName);
        const relative = path.relative(destination, file);
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          zip.close(); reject(new Error('Node archive path escapes extraction root')); return;
        }
        if (entry.fileName.endsWith('/')) {
          fs.mkdirSync(file, { recursive: true }); zip.readEntry(); return;
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return reject(streamError);
          const output = fs.createWriteStream(file, { flags: 'wx' });
          stream.on('error', reject); output.on('error', reject);
          output.on('finish', () => zip.readEntry()); stream.pipe(output);
        });
      });
      zip.readEntry();
    });
  });
}

async function prepareNodeRuntime(target = hostTarget(), options = {}) {
  const contract = targetContract(target);
  const repoRoot = options.repoRoot || ROOT;
  const runtime = path.join(repoRoot, 'build/runtimes/node', target);
  try { verifyNodeRuntime(runtime, target, { execute: true }); return runtime; } catch { /* Rebuild from the locked archive. */ }
  const cache = path.join(repoRoot, 'cache/node', contract.archive);
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  if (!fs.existsSync(cache)) {
    if (!options.download) throw new Error(`Missing offline Node archive: ${cache}. Run setup:node-runtime -- --download while preparing build resources.`);
    const response = await fetch(`https://nodejs.org/dist/v${lock.version}/${contract.archive}`);
    if (!response.ok) throw new Error(`Node archive download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== contract.sha256) throw new Error('Downloaded Node archive checksum mismatch');
    fs.writeFileSync(cache, bytes, { flag: 'wx' });
  }
  if (hash(cache) !== contract.sha256) throw new Error(`Node archive checksum mismatch: ${cache}`);
  fs.mkdirSync(path.dirname(runtime), { recursive: true });
  const stage = fs.mkdtempSync(path.join(repoRoot, 'build/runtimes/node/.staging-'));
  try {
    await extractArchive(cache, stage);
    const directories = fs.readdirSync(stage);
    const source = path.join(stage, contract.archive.replace(/\.(zip|tar\.gz)$/, ''));
    if (directories.length !== 1 || !fs.statSync(source, { throwIfNoEntry: false })?.isDirectory()) throw new Error('Unexpected Node archive root');
    const manifest = { version: lock.version, target, archive: contract.archive, archiveSha256: contract.sha256, executable: contract.executable, files: inventory(source) };
    fs.writeFileSync(path.join(source, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
    verifyNodeRuntime(source, target, { execute: true });
    // The exact repository-owned preparation root is the only replacement target.
    fs.rmSync(runtime, { recursive: true, force: true });
    fs.renameSync(source, runtime);
    return runtime;
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

function copyNodeRuntime(source, destination, target) {
  verifyNodeRuntime(source, target);
  fs.cpSync(source, destination, {
    recursive: true,
    verbatimSymlinks: true,
    force: false,
    errorOnExist: true,
  });
  return verifyNodeRuntime(destination, target);
}

if (require.main === module) {
  const target = process.argv.slice(2).find(arg => !arg.startsWith('--')) || hostTarget();
  prepareNodeRuntime(target, { download: process.argv.includes('--download') })
    .then(root => console.log(`[setup-node-runtime] Verified Node ${lock.version}: ${root}`))
    .catch(error => { console.error(`[setup-node-runtime] ${error.stack || error}`); process.exitCode = 1; });
}

module.exports = { MANIFEST, hostTarget, prepareNodeRuntime, copyNodeRuntime, targetContract, verifyNodeRuntime, __testing: { inventory } };
