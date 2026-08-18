'use strict';

const fs = require('fs');
const path = require('path');
const {
  buildOpenClawPatchManifest,
  listPatchFiles,
  verifyOpenClawPatchManifest,
  writeOpenClawPatchManifest,
} = require('./verify-openclaw-runtime-patches.cjs');

const atomicRenameWaitArray = new Int32Array(new SharedArrayBuffer(4));

function renameFileWithRetry(sourcePath, destinationPath) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(sourcePath, destinationPath);
      return;
    } catch (error) {
      const retryable =
        error &&
        typeof error === 'object' &&
        ['EACCES', 'EBUSY', 'EPERM'].includes(error.code) &&
        attempt < 5;
      if (!retryable) throw error;
      Atomics.wait(atomicRenameWaitArray, 0, 0, 10 * 2 ** attempt);
    }
  }
}

function resolveRepoRoot() {
  return path.resolve(__dirname, '..');
}

function readOpenClawVersion(repoRoot) {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const version = pkg.openclaw?.version;
  if (typeof version !== 'string' || !version.trim()) {
    throw new Error('Missing openclaw.version in package.json');
  }
  return version.trim().replace(/^v?/, 'v');
}

function loadPatchModule(filePath) {
  const loaded = require(filePath);
  if (typeof loaded.applyPatch !== 'function') {
    throw new Error(`Patch module must export applyPatch(): ${filePath}`);
  }
  if (typeof loaded.verifyPatch !== 'function') {
    throw new Error(`Patch module must export verifyPatch(): ${filePath}`);
  }
  return loaded;
}

function loadPatchPhaseUtilities(patchDir) {
  const utilityPath = path.join(patchDir, '_patch-utils.js');
  if (!fs.existsSync(utilityPath)) return null;
  const utilities = require(utilityPath);
  if (
    typeof utilities.beginRuntimePatchPhase !== 'function' ||
    typeof utilities.endRuntimePatchPhase !== 'function'
  ) {
    return null;
  }
  return utilities;
}

function listRuntimePatchTargets(runtimeDir) {
  const files = [];
  const distDir = path.join(runtimeDir, 'dist');
  const pending = fs.existsSync(distDir) ? [distDir] : [];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && /\.[cm]?js$/.test(entry.name)) files.push(candidate);
    }
  }
  const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
  if (fs.existsSync(bundlePath)) files.push(bundlePath);
  return files.sort();
}

function snapshotRuntimePatchTargets(runtimeDir) {
  return new Map(
    listRuntimePatchTargets(runtimeDir).map(filePath => [filePath, fs.readFileSync(filePath)]),
  );
}

function restoreRuntimePatchTargets(runtimeDir, snapshot) {
  const originalPaths = new Set(snapshot.keys());
  for (const filePath of listRuntimePatchTargets(runtimeDir)) {
    if (!originalPaths.has(filePath)) fs.unlinkSync(filePath);
  }
  for (const [filePath, bytes] of snapshot) {
    const current = fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
    if (current?.equals(bytes)) continue;
    const temporaryPath = `${filePath}.justdo-rollback-${process.pid}`;
    fs.writeFileSync(temporaryPath, bytes);
    renameFileWithRetry(temporaryPath, filePath);
  }
}

function patchOpenClawRuntime(runtimeDir, options = {}) {
  const repoRoot = options.repoRoot || resolveRepoRoot();
  const version = (options.version || readOpenClawVersion(repoRoot)).replace(/^v?/, 'v');
  const patchDir = path.join(repoRoot, 'scripts', 'patches', version);
  const label = options.label || 'patch-openclaw-runtime';

  if (!fs.existsSync(runtimeDir)) {
    throw new Error(`Runtime not found: ${runtimeDir}`);
  }

  if (!fs.existsSync(patchDir)) {
    if (options.verbose) {
      console.log(`[${label}] No OpenClaw patches for ${version}.`);
    }
    return [];
  }

  // The install pass is the sole exception: it operates on the freshly
  // extracted, locked npm tarball before build-info and the bundle exist.
  // Every later/direct pass must prove it belongs to the current source,
  // patch set, build recipe, target and immutable runtime artifacts before a
  // patch is allowed to inspect or modify it.
  if (options.pristineInstallPass !== true) {
    try {
      buildOpenClawPatchManifest(runtimeDir, { repoRoot, version });
    } catch (error) {
      throw new Error(
        `Refusing to patch an unknown or stale OpenClaw runtime: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (options.freshBundlePass !== true) {
      try {
        verifyOpenClawPatchManifest(runtimeDir, { repoRoot, version });
      } catch (error) {
        throw new Error(
          `Refusing to patch an unproven OpenClaw bundle: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  const patchFiles = listPatchFiles(repoRoot, version);
  const snapshot = snapshotRuntimePatchTargets(runtimeDir);
  const patchPhaseUtilities = loadPatchPhaseUtilities(patchDir);
  patchPhaseUtilities?.beginRuntimePatchPhase(runtimeDir, snapshot);
  try {
    const results = [];
    const loadedPatches = [];
    for (const patchFile of patchFiles) {
      const patchModule = loadPatchModule(patchFile);
      const patchLabel = `${label}:${path.basename(patchFile, '.cjs')}`;
      const result = patchModule.applyPatch(runtimeDir, {
        ...options,
        label: patchLabel,
        version,
        repoRoot,
      });
      loadedPatches.push({ patchFile, patchLabel, patchModule });
      results.push({
        file: path.relative(repoRoot, patchFile),
        result,
      });
    }

    if (patchFiles.length === 0 && options.verbose) {
      console.log(`[${label}] Patch directory is empty for ${version}.`);
    }

    const gatewayBundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    if (patchFiles.length > 0 && fs.existsSync(gatewayBundlePath)) {
      for (const { patchLabel, patchModule } of loadedPatches) {
        patchModule.verifyPatch(runtimeDir, {
          ...options,
          label: patchLabel,
          version,
          repoRoot,
        });
      }

      if (options.writeManifest !== false) {
        const { manifestPath } = writeOpenClawPatchManifest(runtimeDir, { repoRoot, version });
        if (options.verbose) {
          console.log(`[${label}] Wrote patch manifest: ${path.relative(repoRoot, manifestPath)}`);
        }
      }
    }

    return results;
  } catch (error) {
    try {
      restoreRuntimePatchTargets(runtimeDir, snapshot);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'OpenClaw patching failed and the runtime rollback was incomplete',
      );
    }
    throw error;
  } finally {
    patchPhaseUtilities?.endRuntimePatchPhase(runtimeDir);
  }
}

function ensureOpenClawRuntimePatches(runtimeDir, options = {}) {
  const repoRoot = options.repoRoot || resolveRepoRoot();
  const version = (options.version || readOpenClawVersion(repoRoot)).replace(/^v?/, 'v');
  const label = options.label || 'patch-openclaw-runtime';

  try {
    const manifest = verifyOpenClawPatchManifest(runtimeDir, { repoRoot, version });
    if (options.verbose) {
      console.log(
        `[${label}] Patch manifest is current; skipped ${manifest.patches.length} patch(es).`,
      );
    }
    return { cached: true, manifest, results: [] };
  } catch (error) {
    if (options.verbose) {
      console.log(
        `[${label}] Patch manifest is stale or missing; running patches. ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const results = patchOpenClawRuntime(runtimeDir, {
    ...options,
    repoRoot,
    version,
  });
  const manifest = verifyOpenClawPatchManifest(runtimeDir, { repoRoot, version });
  return { cached: false, manifest, results };
}

if (require.main === module) {
  const repoRoot = resolveRepoRoot();
  const runtimeDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(repoRoot, 'vendor', 'openclaw-runtime', 'current');
  const version = process.argv[3] ? process.argv[3].trim() : undefined;

  try {
    patchOpenClawRuntime(runtimeDir, { repoRoot, version, verbose: true });
  } catch (error) {
    console.error(
      `[patch-openclaw-runtime] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

module.exports = { ensureOpenClawRuntimePatches, patchOpenClawRuntime };
