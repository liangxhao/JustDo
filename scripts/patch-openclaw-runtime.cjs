'use strict';

const fs = require('fs');
const path = require('path');

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
  if (typeof loaded === 'function') return loaded;
  if (typeof loaded.applyPatch === 'function') return loaded.applyPatch;
  throw new Error(`Patch module must export a function or applyPatch(): ${filePath}`);
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

  const patchFiles = fs
    .readdirSync(patchDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.cjs'))
    .map(entry => path.join(patchDir, entry.name))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

  const results = [];
  for (const patchFile of patchFiles) {
    const patch = loadPatchModule(patchFile);
    const patchLabel = `${label}:${path.basename(patchFile, '.cjs')}`;
    const result = patch(runtimeDir, {
      ...options,
      label: patchLabel,
      version,
      repoRoot,
    });
    results.push({
      file: path.relative(repoRoot, patchFile),
      result,
    });
  }

  if (patchFiles.length === 0 && options.verbose) {
    console.log(`[${label}] Patch directory is empty for ${version}.`);
  }

  return results;
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

module.exports = { patchOpenClawRuntime };
