'use strict';

/**
 * pack-openclaw-tar.cjs
 *
 * Packs directories into a single .tar file for Windows distribution.
 * NSIS installs thousands of small files very slowly on NTFS; shipping one
 * tar archive and extracting it post-install is dramatically faster.
 *
 * Used by electron-builder-hooks beforePack to pack:
 *   - OpenClaw runtime (vendor/openclaw-runtime/current -> cfmind/)
 *   - Custom skills already synchronized into the OpenClaw runtime
 *   - Python runtime (build/runtimes/python-win -> python-win/)
 *
 * Usage:
 *   Single dir:      node scripts/openclaw/pack-openclaw-tar.cjs [sourceDir] [outputTar]
 *   Windows combined: node scripts/openclaw/pack-openclaw-tar.cjs --win-combined
 *
 * Uses npm `tar` package for reliable handling of long paths, Unicode, etc.
 */

const fs = require('fs');
const path = require('path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { pipeline } = require('stream/promises');
const tar = require('tar');
const { constants: zlibConstants, createZstdCompress, zstdCompressSync } = require('zlib');
const { isLegalMetadataPath } = require('./prune-openclaw-runtime.cjs');

const WINDOWS_RUNTIME_ZSTD_LEVEL = 19;
const WINDOWS_RUNTIME_ZSTD_WINDOW_LOG = 26;
const MIB = 1024 * 1024;
// Keep the pristine runtime complete; omit deployment-only copies at packaging.
const PACKAGED_RUNTIME_EXCLUDES = Object.freeze([
  'gateway.asar',
  'dist/worker-artifacts',
  'dist/extensions/widget-kit/assets',
]);
// A 64 MiB window finds repeated SDK payloads. Level 19 costs build time while
// measured installer decoding stays comparable; existing decoder limits apply.

// ── File/dir exclusion rules (same as electron-builder.json filters) ─────────

const EXCLUDED_FILE_PATTERNS = [
  /\.pdb$/i,
  /\.map$/i,
  /\.d\.ts$/i,
  /\.d\.cts$/i,
  /\.d\.mts$/i,
  /^readme(\.(md|txt|rst))?$/i,
  /^changelog(\.(md|txt|rst))?$/i,
  /^history(\.(md|txt|rst))?$/i,
  /^license(\.(md|txt))?$/i,
  /^licence(\.(md|txt))?$/i,
  /^authors(\.(md|txt))?$/i,
  /^contributors(\.(md|txt))?$/i,
  /^\.eslintrc/i,
  /^\.prettierrc/i,
  /^\.editorconfig$/i,
  /^\.npmignore$/i,
  /^\.gitignore$/i,
  /^\.gitattributes$/i,
  /^tsconfig(\..+)?\.json$/i,
  /^jest\.config/i,
  /^vitest\.config/i,
  /^\.babelrc/i,
  /^babel\.config/i,
  /\.test\.\w+$/i,
  /\.spec\.\w+$/i,
];

const EXCLUDED_DIRS = new Set([
  'test',
  'tests',
  '__tests__',
  '__mocks__',
  '.github',
  'example',
  'examples',
  'coverage',
  '.venv',
  '.bin', // node_modules/.bin contains symlinks that break tar on cross-platform builds
]);

const EXCLUDED_ENVFILE = /^\.env(\..+)?$/i;

function isAgentKnowledgePath(entryPath) {
  const segments = entryPath.replace(/\\/g, '/').split('/');
  return !segments.includes('node_modules') &&
    (segments.includes('docs') || segments.includes('skills'));
}

function listRuntimeKnowledgeFiles(runtimeRoot) {
  const files = [];
  const visit = directory => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const relative = path.relative(runtimeRoot, target).replaceAll('\\', '/');
      if (shouldExclude(relative)) continue;
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) files.push(relative);
    }
  };
  visit(path.join(runtimeRoot, 'docs'));
  visit(path.join(runtimeRoot, 'skills'));
  for (const entry of fs.readdirSync(runtimeRoot, { withFileTypes: true })) {
    if (entry.isFile() && /\.md$/i.test(entry.name)) files.push(entry.name);
  }
  return files.sort();
}

function verifyRuntimeKnowledgeEntries(entries, prefix, runtimeRoot) {
  const required = listRuntimeKnowledgeFiles(runtimeRoot);
  const missing = required.filter(file => !entries.has(prefix + file));
  if (missing.length) {
    throw new Error('Packaged runtime knowledge is incomplete: ' + missing.join(', '));
  }
  return required.length;
}

function verifyRuntimeWorkerEntries(entries, prefix, runtimeRoot) {
  const deploymentRoot = `${prefix}dist/worker-artifacts`;
  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, '/').replace(/\/$/, '');
    if (normalized === deploymentRoot || normalized.startsWith(`${deploymentRoot}/`)) {
      throw new Error(`Packaged runtime includes unsupported Worker deployment artifacts: ${entry}`);
    }
  }
  const required = [];
  const visit = directory => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (
        entry.isDirectory() &&
        entry.name !== 'node_modules' &&
        target !== path.join(runtimeRoot, 'dist', 'worker-artifacts')
      ) {
        visit(target);
      } else if (entry.isFile() && /\.worker\.[cm]?js$/.test(entry.name)) {
        required.push(path.relative(runtimeRoot, target).replace(/\\/g, '/'));
      }
    }
  };
  visit(path.join(runtimeRoot, 'dist'));
  const missing = required.filter(file => !entries.has(prefix + file));
  if (missing.length) throw new Error(`Packaged local Workers are incomplete: ${missing.join(', ')}`);
  return required.length;
}

function verifyLegalMetadataEntries(entries, prefix, sourceRoot, excludedPaths = []) {
  const required = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const relative = path.relative(sourceRoot, target).replaceAll('\\', '/');
      if (shouldExcludeFromSource(relative, excludedPaths)) continue;
      if (entry.isDirectory() && shouldExclude(relative, true)) continue;
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && isLegalMetadataPath(relative)) required.push(relative);
    }
  };
  visit(sourceRoot);
  const missing = required.filter(file => !entries.has(prefix + file));
  if (missing.length) throw new Error('Packaged legal metadata is incomplete: ' + missing.join(', '));
  return required.length;
}

function shouldExclude(entryPath, isDirectory = false) {
  const basename = path.basename(entryPath);
  const normalized = entryPath.replace(/\\/g, '/');
  // Retired generated libraries must not survive from an older build tree.
  if (/(?:^|\/)dist\/extensions\/widget-kit\/assets(?:\/|$)/.test(normalized)) return true;
  // The official Node distribution is closed by its own source/file manifest.
  if (/^node-runtime(?:\/|$)/.test(normalized)) return false;
  // The prepared editor is a closed, hashed resource set, including legal files.
  if (/(?:^|\/)dist\/extensions\/drawio\/assets(?:\/|$)/.test(normalized)) return false;
  // Native Control UI serves the unchanged identity asset when an optional
  // encoded representation is absent. Keep its manifest and all original bytes.
  if (/^dist\/control-ui\/assets\/.+\.(?:js|css)\.(?:br|gz)$/.test(normalized)) return true;
  // Knowledge exceptions never admit credentials or local dependency caches.
  if (EXCLUDED_ENVFILE.test(basename) || /(?:^|\/)(?:\.venv|\.bin)(?:\/|$)/.test(normalized))
    return true;
  // Native knowledge is runtime input. Directory names such as docs/examples
  // and basenames such as README.md must not trigger generic npm pruning.
  if (isAgentKnowledgePath(normalized) || /\.md$/i.test(basename)) return false;
  // Traverse development-only directories to retain notices within them.
  // License files apply to every bundled dependency, regardless of plugin.
  if (isDirectory || isLegalMetadataPath(normalized)) return false;
  const isExtensionLegalMetadata =
    /(?:^|\/)dist\/extensions\/(?:acpx|mxc)\//.test(normalized) &&
    /^(?:license|licence|notice|third[_-]party[_-]notices?|readme)(?:\..+)?$/i.test(basename);
  if (isExtensionLegalMetadata) return false;

  // Check dir exclusion
  const segments = entryPath.split(/[/\\]/);
  for (const seg of segments) {
    if (EXCLUDED_DIRS.has(seg.toLowerCase())) return true;
  }

  // Check file exclusion
  if (EXCLUDED_ENVFILE.test(basename)) return true;
  if (EXCLUDED_FILE_PATTERNS.some(p => p.test(basename))) return true;

  return false;
}

function isPythonDistributionLicense(entryPath) {
  const normalized = entryPath.replace(/\\/g, '/');
  const basename = path.basename(normalized);
  const isLicenseName = /^(license|licence|copying|notice|authors)(\.(md|txt|rst))?$/i.test(
    basename,
  );
  return (
    (!normalized.includes('/') && isLicenseName) ||
    /\.dist-info\/licenses\//i.test(normalized) ||
    (/\.dist-info\//i.test(normalized) && isLicenseName)
  );
}

function shouldExcludeForSource(entryPath, preservePythonLicenses, isDirectory = false) {
  return preservePythonLicenses && isPythonDistributionLicense(entryPath)
    ? false
    : shouldExclude(entryPath, isDirectory);
}

function shouldExcludeFromSource(entryPath, excludedPaths = []) {
  const normalized = entryPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  return excludedPaths.some(excludedPath => {
    const excluded = excludedPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    return normalized === excluded || normalized.startsWith(`${excluded}/`);
  });
}

// ── Pack functions ───────────────────────────────────────────────────────────

/**
 * Pack a single source directory into a tar file.
 * The directory contents are stored under `prefix/` in the tar.
 */
function packSingleSource(sourceDir, outputTar, prefix) {
  const entries = [];
  let skipped = 0;

  // Collect entries, applying exclusion filter
  function walk(dir, relPrefix) {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    items.sort((a, b) => a.name.localeCompare(b.name));

    for (const item of items) {
      if (item.isSymbolicLink()) continue;
      const fullPath = path.join(dir, item.name);
      const relPath = relPrefix ? `${relPrefix}/${item.name}` : item.name;

      if (item.isDirectory()) {
        if (shouldExclude(relPath, true)) {
          skipped++;
          continue;
        }
        walk(fullPath, relPath);
      } else if (item.isFile()) {
        if (shouldExclude(relPath)) {
          skipped++;
          continue;
        }
        entries.push(relPath);
      }
    }
  }

  walk(sourceDir, '');

  // Use npm tar to create the archive
  tar.create(
    {
      file: outputTar,
      cwd: sourceDir,
      prefix: prefix || '',
      sync: true,
      // Follow symlinks instead of storing them (avoids Windows issues)
      follow: true,
      filter: (filePath, stat) => !shouldExclude(filePath, stat.isDirectory()),
    },
    // Pack all top-level entries (tar will recurse)
    fs.readdirSync(sourceDir).filter(name => {
      return !shouldExclude(name, true);
    }),
  );

  return { totalFiles: entries.length, skipped };
}

/**
 * Pack multiple source directories into a single tar file.
 * Each source gets its own prefix (root directory name) in the tar.
 */
function packMultipleSources(sources, outputTar) {
  let totalSkipped = 0;
  const directories = [];
  const files = [];
  const archivePaths = new Set();
  for (const { dir, prefix, exclude = [], preservePythonLicenses = false } of sources) {
    if (!fs.existsSync(dir)) {
      console.log(`[pack-openclaw-tar]   Skipping ${prefix}: ${dir} not found`);
      continue;
    }

    console.log(`[pack-openclaw-tar]   Adding ${prefix} ← ${dir}`);

    const ancestors = new Set();
    function collect(d, relativeDir = '') {
      const realDirectory = fs.realpathSync(d);
      if (ancestors.has(realDirectory)) throw new Error(`Runtime source contains a directory cycle: ${d}`);
      ancestors.add(realDirectory);
      for (const item of fs.readdirSync(d, { withFileTypes: true })) {
        const fullPath = path.join(d, item.name);
        const relativePath = relativeDir ? `${relativeDir}/${item.name}` : item.name;
        if (shouldExcludeFromSource(relativePath, exclude)) {
          totalSkipped++;
          continue;
        }
        // Match tar's existing follow:true behavior, including packaged aliases.
        const stat = fs.statSync(fullPath);
        if (shouldExcludeForSource(relativePath, preservePythonLicenses, stat.isDirectory())) {
          totalSkipped++;
          continue;
        }
        const archivePath = `${prefix}/${relativePath}`.replace(/\\/g, '/');
        if (path.posix.isAbsolute(archivePath) || path.win32.isAbsolute(archivePath) || /^[A-Za-z]:/.test(archivePath) || archivePath.split('/').some(part => part === '..')) {
          throw new Error(`Runtime archive path must be relative: ${archivePath}`);
        }
        if (archivePaths.has(archivePath)) throw new Error(`Duplicate runtime archive path: ${archivePath}`);
        archivePaths.add(archivePath);
        const entry = { absolute: path.resolve(fullPath), archivePath, relativePath, size: stat.size };
        if (stat.isDirectory()) {
          directories.push(entry);
          collect(fullPath, relativePath);
        } else if (stat.isFile()) {
          files.push(entry);
        }
      }
      ancestors.delete(realDirectory);
    }
    collect(dir);
  }

  // Similar dependency paths and duplicate files must stay within the decoder's
  // existing 64 MiB window. Keep every file independent at installation time.
  const key = entry => {
    const marker = entry.archivePath.lastIndexOf('/node_modules/');
    if (marker >= 0 && !entry.relativePath.startsWith('node-runtime/')) {
      return `c_modules/${entry.archivePath.slice(marker + '/node_modules/'.length)}`;
    }
    if (entry.relativePath === 'gateway-bundle.mjs') return 'b_chunks/zzzzgateway-bundle.mjs';
    if (/^dist\/[^/]+$/.test(entry.relativePath)) {
      return `b_chunks/${entry.relativePath.slice('dist/'.length).replace(/-[A-Za-z0-9_-]+\.mjs$/, '.mjs')}`;
    }
    return `a_files/${entry.archivePath}`;
  };
  files.sort((left, right) => key(left).localeCompare(key(right)) || left.archivePath.localeCompare(right.archivePath));
  directories.sort((left, right) => left.archivePath.localeCompare(right.archivePath));

  const sizes = new Map();
  for (const entry of files) {
    const group = sizes.get(entry.size) || [];
    group.push(entry);
    sizes.set(entry.size, group);
  }
  const copies = new Map();
  for (const group of sizes.values()) {
    if (group.length < 2 || group[0].size === 0) continue;
    for (const entry of group) {
      entry.sha256 = createHash('sha256').update(fs.readFileSync(entry.absolute)).digest('hex');
      const matches = copies.get(entry.sha256) || [];
      matches.push(entry);
      copies.set(entry.sha256, matches);
    }
  }
  const ordered = [...directories];
  const added = new Set();
  for (const entry of files) {
    if (added.has(entry)) continue;
    for (const copy of entry.sha256 ? copies.get(entry.sha256) : [entry]) {
      if (!added.has(copy)) { added.add(copy); ordered.push(copy); }
    }
  }

  // The supported tar callback changes only the output name. Absolute source
  // paths remain private build inputs; directory recursion is already complete.
  const names = new Map();
  for (const entry of ordered) {
    const queue = names.get(entry.absolute) || [];
    queue.push(entry.archivePath);
    names.set(entry.absolute, queue);
  }
  class IndependentFileLinkCache extends Map {
    get() { return undefined; }
    set() { return this; }
  }
  tar.create({
    file: outputTar, sync: true, follow: true, noDirRecurse: true,
    preservePaths: true, linkCache: new IndependentFileLinkCache(),
    onWriteEntry(entry) {
      const archivePath = names.get(path.resolve(entry.absolute))?.shift();
      if (!archivePath) throw new Error(`Unexpected runtime source entry: ${entry.absolute}`);
      entry.path = entry.type === 'Directory' ? `${archivePath}/` : archivePath;
    },
  }, ordered.map(entry => entry.absolute));
  const missing = [...names.values()].flat();
  if (missing.length) throw new Error(`Runtime archive entries were not written: ${missing.join(', ')}`);

  return { totalFiles: files.length, skipped: totalSkipped };
}

/**
 * Compress the staging tar before electron-builder embeds it. Zstandard keeps
 * the archive small while remaining fast to decode into Windows' native tar
 * process during installation. NSIS stores this extraResource without trying
 * to recompress it.
 */
function resolveCompressionWorkers(sourceBytes, options = {}) {
  const requested = options.workers ?? process.env.RUNTIME_COMPRESSION_WORKERS;
  if (requested !== undefined && !/^[0-8]$/.test(String(requested))) {
    throw new Error('RUNTIME_COMPRESSION_WORKERS must be an integer from 0 to 8 (0 uses streaming compression).');
  }
  if (String(requested) === '0') return 0;
  const cpuCount = options.cpuCount ?? os.availableParallelism();
  const availableMemory = options.availableMemory ?? Math.min(os.freemem(), process.availableMemory());
  // Buffered compression needs input/output headroom plus native per-worker
  // tables. Bound it before spawning; large/low-memory builds keep streaming.
  const memoryLimit = Math.max(0, Math.floor((availableMemory - sourceBytes * 3 - 512 * MIB) / (768 * MIB)));
  if (sourceBytes > 1024 * MIB || (!requested && sourceBytes < 8 * MIB)) return 0;
  const workers = Math.min(Number(requested ?? 4), Math.max(0, cpuCount - 1), memoryLimit);
  return workers >= 2 ? workers : 0;
}

function compressionOptions(workers = 0) {
  return { params: {
    [zlibConstants.ZSTD_c_compressionLevel]: WINDOWS_RUNTIME_ZSTD_LEVEL,
    [zlibConstants.ZSTD_c_windowLog]: WINDOWS_RUNTIME_ZSTD_WINDOW_LOG,
    [zlibConstants.ZSTD_c_enableLongDistanceMatching]: 1,
    [zlibConstants.ZSTD_c_nbWorkers]: workers,
  } };
}

async function compressTarArchive(sourceTar, outputArchive, options = {}) {
  const workers = resolveCompressionWorkers(fs.statSync(sourceTar).size, options);
  const temporaryArchive = `${outputArchive}.${process.pid}.${randomUUID()}.tmp`;
  console.log(`[pack-openclaw-tar] Compression: ${workers || 1} thread(s), ${workers ? 'isolated process' : 'streaming'}, level 19, 64 MiB window.`);
  try {
    if (workers) {
      // Node 24 streaming Zstd with nbWorkers can signal premature EOF on large
      // inputs. One-shot compression finishes synchronously inside an isolated
      // process while native Zstd workers run in parallel. Exit releases its RAM.
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [__filename, '--compress-worker', sourceTar, temporaryArchive, String(workers)], {
          stdio: 'inherit', windowsHide: true,
        });
        child.once('error', reject);
        child.once('close', (code, signal) => code === 0 ? resolve()
          : reject(new Error(`Runtime compression process failed: ${signal || `exit ${code}`}`)));
      });
    } else {
      await pipeline(fs.createReadStream(sourceTar), createZstdCompress(compressionOptions()), fs.createWriteStream(temporaryArchive));
    }
    fs.renameSync(temporaryArchive, outputArchive);
    return { workers };
  } finally {
    fs.rmSync(temporaryArchive, { force: true });
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  const projectRoot = path.join(__dirname, '../..');
  const isWinCombined = process.argv.includes('--win-combined');

  if (isWinCombined) {
    const outputTar = path.join(projectRoot, 'build', 'tar', 'win-resources.tar');
    fs.mkdirSync(path.dirname(outputTar), { recursive: true });

    // Remove old tar if exists
    if (fs.existsSync(outputTar)) fs.unlinkSync(outputTar);

    const sources = [
      {
        dir: path.join(projectRoot, 'vendor', 'openclaw-runtime', 'current'),
        prefix: 'cfmind',
        exclude: PACKAGED_RUNTIME_EXCLUDES,
      },
      {
        dir: path.join(projectRoot, 'build', 'runtimes', 'python-win'),
        prefix: 'python-win',
        preservePythonLicenses: true,
      },
      {
        dir: path.join(projectRoot, 'build', 'runtimes', 'local-tts'),
        prefix: 'local-tts',
        preservePythonLicenses: true,
        exclude: [
          'win-x64/kokoro-int8-multi-lang-v1_1',
          'win-x64/sherpa-onnx-whisper-tiny',
          'win-x64/KOKORO-LICENSE.txt',
          'win-x64/WHISPER-LICENSE.txt',
          'win-x64/.justdo-local-tts-version',
        ],
      },
    ];

    console.log(`[pack-openclaw-tar] Packing combined Windows tar: ${outputTar}`);
    const t0 = Date.now();
    const { totalFiles, skipped } = packMultipleSources(sources, outputTar);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const sizeMB = (fs.statSync(outputTar).size / (1024 * 1024)).toFixed(1);
    console.log(
      `[pack-openclaw-tar] Done in ${elapsed}s: ${totalFiles} files, ${skipped} skipped, ${sizeMB} MB`,
    );
    return;
  }

  // Single directory mode
  const sourceDir =
    process.argv[2] || path.join(projectRoot, 'vendor', 'openclaw-runtime', 'current');
  const outputTar =
    process.argv[3] || path.join(projectRoot, 'vendor', 'openclaw-runtime', 'cfmind.tar');

  if (!fs.existsSync(sourceDir)) {
    console.error(`[pack-openclaw-tar] Source directory not found: ${sourceDir}`);
    process.exit(1);
  }

  // Remove old tar if exists
  if (fs.existsSync(outputTar)) fs.unlinkSync(outputTar);

  console.log(`[pack-openclaw-tar] Packing: ${sourceDir}`);
  console.log(`[pack-openclaw-tar] Output:  ${outputTar}`);

  const t0 = Date.now();
  const basename = path.basename(outputTar, '.tar');
  const { totalFiles, skipped } = packSingleSource(sourceDir, outputTar, basename);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const sizeMB = (fs.statSync(outputTar).size / (1024 * 1024)).toFixed(1);
  console.log(
    `[pack-openclaw-tar] Done in ${elapsed}s: ${totalFiles} files, ${skipped} skipped, ${sizeMB} MB`,
  );
}

if (require.main === module) {
  if (process.argv[2] === '--compress-worker') {
    const workers = Number(process.argv[5]);
    if (process.argv.length !== 6 || !Number.isInteger(workers) || workers < 2 || workers > 8) {
      throw new Error('Invalid runtime compression worker arguments.');
    }
    fs.writeFileSync(process.argv[4], zstdCompressSync(fs.readFileSync(process.argv[3]), compressionOptions(workers)));
  } else {
    main();
  }
}

module.exports = { PACKAGED_RUNTIME_EXCLUDES, resolveCompressionWorkers, compressTarArchive, packSingleSource, packMultipleSources, listRuntimeKnowledgeFiles, verifyRuntimeKnowledgeEntries, verifyRuntimeWorkerEntries, verifyLegalMetadataEntries };
