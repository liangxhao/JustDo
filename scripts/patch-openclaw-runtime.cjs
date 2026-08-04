'use strict';

const fs = require('fs');
const path = require('path');
const {
  listPatchFiles,
  verifyOpenClawPatchManifest,
  writeOpenClawPatchManifest,
} = require('./verify-openclaw-runtime-patches.cjs');

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

  const patchFiles = listPatchFiles(repoRoot, version);

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
