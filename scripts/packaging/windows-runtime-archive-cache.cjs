'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const tar = require('tar');
const { collectArchiveSources, compressTarArchive, resolveCompressionWorkers } = require('../openclaw/pack-openclaw-tar.cjs');

const OUTPUT_NAMES = ['win-resources.tar.zst', 'win-resources-metadata.json', 'win-resources-proof.json'];
const PROOF_FORMAT = 1;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const hashFile = file => sha256(fs.readFileSync(file));

function prepareArchiveInputs(sources, recipeFiles = []) {
  // Validate an explicit compression setting even when the archive is reusable.
  resolveCompressionWorkers(0);
  const prepared = collectArchiveSources(sources);
  for (const entry of prepared.files) entry.sha256 = hashFile(entry.absolute);
  const members = [
    ...prepared.directories.map(entry => ({
      path: entry.archivePath, type: 'Directory', mode: entry.mode, link: entry.link,
    })),
    ...prepared.files.map(entry => ({
      path: entry.archivePath, type: 'File', mode: entry.mode, link: entry.link,
      size: entry.size, sha256: entry.sha256,
    })),
  ].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const recipeSha256 = sha256(JSON.stringify({
    sources: sources.map(source => ({
      prefix: source.prefix, exclude: source.exclude || [],
      preservePythonLicenses: Boolean(source.preservePythonLicenses),
      exists: fs.existsSync(source.dir),
      link: fs.existsSync(source.dir) && fs.lstatSync(source.dir).isSymbolicLink()
        ? fs.readlinkSync(source.dir) : null,
    })),
    members,
    node: process.versions.node, zstd: process.versions.zstd, tar: require('tar/package.json').version,
    requestedWorkers: process.env.RUNTIME_COMPRESSION_WORKERS ?? null,
    recipe: [
      __filename, require.resolve('../openclaw/pack-openclaw-tar.cjs'),
      require.resolve('../openclaw/prune-openclaw-runtime.cjs'), ...recipeFiles,
    ].map(hashFile),
  }));
  return { prepared, recipeSha256 };
}

function readVerifiedArchiveEntries(outputTar, prepared) {
  const expected = new Map([
    ...prepared.directories.map(entry => [entry.archivePath, { ...entry, type: 'Directory' }]),
    ...prepared.files.map(entry => [entry.archivePath, { ...entry, type: 'File' }]),
  ]);
  const entries = [];
  const parser = tar.list({
    strict: true,
    onReadEntry(entry) {
      const name = entry.path.replace(/\\/g, '/').replace(/\/$/, '');
      const source = expected.get(name);
      // tar makes readable directories traversable, including Windows modes.
      const mode = source?.type === 'Directory' ? source.mode | ((source.mode & 0o444) >> 2) : source?.mode;
      if (!source || source.type !== entry.type || mode !== entry.mode ||
        (entry.type === 'File' && source.size !== entry.size)) {
        throw new Error(`Runtime archive differs from its source inventory: ${entry.path}`);
      }
      expected.delete(name); // Duplicate entries fail the same check.
      const digest = createHash('sha256');
      entry.on('data', chunk => digest.update(chunk));
      entry.on('end', () => {
        if (source.type === 'File' && digest.digest('hex') !== source.sha256) {
          throw new Error(`Runtime archive content differs from its source: ${entry.path}`);
        }
      });
      entries.push({ path: entry.path, type: entry.type, mode: entry.mode, size: entry.size });
    },
  });
  // The parser skips unsupported filesystem types before onReadEntry runs.
  // Reject those entries too; valid PAX/long-name metadata is handled normally.
  parser.on('ignoredEntry', entry => {
    throw new Error(`Runtime archive contains an unsupported entry: ${entry.path} (${entry.type})`);
  });
  parser.on('error', error => { throw error; });
  const descriptor = fs.openSync(outputTar, 'r');
  try {
    const buffer = Buffer.allocUnsafe(16 * 1024 * 1024);
    let bytesRead;
    while ((bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      parser.write(buffer.subarray(0, bytesRead));
    }
    parser.end();
  } finally {
    fs.closeSync(descriptor);
  }
  if (expected.size) throw new Error(`Runtime archive is missing source entries: ${[...expected.keys()].join(', ')}`);
  return entries;
}

function matchesArchiveProof(outputDir, recipeSha256) {
  try {
    const paths = OUTPUT_NAMES.map(name => path.join(outputDir, name));
    if (!paths.every(file => fs.lstatSync(file).isFile())) return false;
    const proof = JSON.parse(fs.readFileSync(paths[2], 'utf8'));
    return proof.formatVersion === PROOF_FORMAT && proof.recipeSha256 === recipeSha256 &&
      proof.archiveSha256 === hashFile(paths[0]) && proof.metadataSha256 === hashFile(paths[1]);
  } catch {
    return false;
  }
}

function publishArchive(stagingDir, outputDir, rename = fs.renameSync) {
  const backups = [];
  const published = [];
  try {
    for (const name of OUTPUT_NAMES) {
      const output = path.join(outputDir, name);
      if (fs.existsSync(output)) {
        const backup = path.join(stagingDir, `${name}.previous`);
        rename(output, backup);
        backups.push([output, backup]);
      }
    }
    // The proof is last. An interrupted publication cannot admit partial outputs.
    for (const name of OUTPUT_NAMES) {
      const output = path.join(outputDir, name);
      rename(path.join(stagingDir, name), output);
      published.push(output);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const output of published.reverse()) {
      try { fs.rmSync(output, { force: true }); } catch (failure) { rollbackErrors.push(failure); }
    }
    for (const [output, backup] of backups.reverse()) {
      try { fs.renameSync(backup, output); } catch (failure) { rollbackErrors.push(failure); }
    }
    if (rollbackErrors.length) {
      throw new AggregateError([error, ...rollbackErrors], `Runtime archive publication failed; backups retained in ${stagingDir}`);
    }
    throw error;
  }
}

async function prepareCachedRuntimeArchive(sources, outputDir, buildTar, options = {}) {
  fs.mkdirSync(outputDir, { recursive: true });
  const started = Date.now();
  const { prepared, recipeSha256 } = prepareArchiveInputs(sources, options.recipeFiles);
  const log = options.log || console.log;
  if (matchesArchiveProof(outputDir, recipeSha256)) {
    log(`[electron-builder-hooks] Reused verified Windows runtime archive in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
    return { reused: true };
  }
  const stagingDir = fs.mkdtempSync(path.join(outputDir, 'runtime-archive-'));
  let published = false;
  try {
    const outputTar = path.join(stagingDir, 'win-resources.tar');
    const outputArchive = path.join(stagingDir, OUTPUT_NAMES[0]);
    const outputMetadata = path.join(stagingDir, OUTPUT_NAMES[1]);
    let verified = false;
    await buildTar({ outputTar, outputMetadata, prepared, readEntries: () => {
      const entries = readVerifiedArchiveEntries(outputTar, prepared);
      verified = true;
      return entries;
    } });
    if (!verified) throw new Error('Runtime archive source verification was not completed.');
    const compressionStarted = Date.now();
    await (options.compress || compressTarArchive)(outputTar, outputArchive);
    log(`[electron-builder-hooks] Compressed Windows runtime archive in ${((Date.now() - compressionStarted) / 1000).toFixed(1)}s: ${(fs.statSync(outputArchive).size / 1024 ** 2).toFixed(1)} MB`);
    fs.writeFileSync(path.join(stagingDir, OUTPUT_NAMES[2]), `${JSON.stringify({
      formatVersion: PROOF_FORMAT, recipeSha256,
      archiveSha256: hashFile(outputArchive), metadataSha256: hashFile(outputMetadata),
    }, null, 2)}\n`);
    publishArchive(stagingDir, outputDir, options.rename);
    published = true;
    return { reused: false };
  } finally {
    // A failed rollback must not erase the last complete generation's backups.
    if (published || !fs.readdirSync(stagingDir).some(name => name.endsWith('.previous'))) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  }
}

module.exports = { prepareCachedRuntimeArchive, readVerifiedArchiveEntries };
