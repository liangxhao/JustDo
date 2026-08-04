'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PATCH_MANIFEST_FILENAME = 'runtime-patch-manifest.json';
const PATCH_MANIFEST_FORMAT_VERSION = 1;

function normalizeOpenClawVersion(version) {
  if (typeof version !== 'string' || !version.trim()) {
    throw new Error('Missing OpenClaw version');
  }
  return version.trim().replace(/^v?/, 'v');
}

function readOpenClawVersion(repoRoot) {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  return normalizeOpenClawVersion(pkg.openclaw?.version);
}

function listPatchFiles(repoRoot, version) {
  const normalizedVersion = normalizeOpenClawVersion(version);
  const patchDir = path.join(repoRoot, 'scripts', 'patches', normalizedVersion);
  if (!fs.existsSync(patchDir)) {
    return [];
  }

  return fs
    .readdirSync(patchDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.cjs'))
    .map(entry => path.join(patchDir, entry.name))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function buildOpenClawPatchManifest(runtimeRoot, options = {}) {
  const repoRoot = options.repoRoot || path.resolve(__dirname, '..');
  const version = normalizeOpenClawVersion(options.version || readOpenClawVersion(repoRoot));
  const gatewayBundlePath = path.join(runtimeRoot, 'gateway-bundle.mjs');
  if (!fs.existsSync(gatewayBundlePath)) {
    throw new Error(`Gateway bundle not found: ${gatewayBundlePath}`);
  }

  const patchFiles = listPatchFiles(repoRoot, version);
  if (patchFiles.length === 0) {
    throw new Error(`No OpenClaw patches found for ${version}`);
  }

  return {
    formatVersion: PATCH_MANIFEST_FORMAT_VERSION,
    openclawVersion: version,
    gatewayBundle: {
      path: 'gateway-bundle.mjs',
      size: fs.statSync(gatewayBundlePath).size,
      sha256: hashFile(gatewayBundlePath),
    },
    patches: patchFiles.map(filePath => ({
      file: path.relative(repoRoot, filePath).replace(/\\/g, '/'),
      sha256: hashFile(filePath),
    })),
  };
}

function writeOpenClawPatchManifest(runtimeRoot, options = {}) {
  const manifest = buildOpenClawPatchManifest(runtimeRoot, options);
  const manifestPath = path.join(runtimeRoot, PATCH_MANIFEST_FILENAME);
  const temporaryPath = `${manifestPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, manifestPath);
  return { manifest, manifestPath };
}

function verifyOpenClawPatchManifest(runtimeRoot, options = {}) {
  const repoRoot = options.repoRoot || path.resolve(__dirname, '..');
  const version = normalizeOpenClawVersion(options.version || readOpenClawVersion(repoRoot));
  const manifestPath = path.join(runtimeRoot, PATCH_MANIFEST_FILENAME);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `OpenClaw patch manifest is missing: ${manifestPath}. Rebuild the OpenClaw runtime.`,
    );
  }

  let actual;
  try {
    actual = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `OpenClaw patch manifest is invalid: ${manifestPath}. ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  const expected = buildOpenClawPatchManifest(runtimeRoot, { repoRoot, version });
  const problems = [];
  if (actual.formatVersion !== PATCH_MANIFEST_FORMAT_VERSION) {
    problems.push(
      `format version is ${String(actual.formatVersion)}, expected ${PATCH_MANIFEST_FORMAT_VERSION}`,
    );
  }
  if (actual.openclawVersion !== expected.openclawVersion) {
    problems.push(
      `OpenClaw version is ${String(actual.openclawVersion)}, expected ${expected.openclawVersion}`,
    );
  }
  if (
    actual.gatewayBundle?.path !== expected.gatewayBundle.path ||
    actual.gatewayBundle?.size !== expected.gatewayBundle.size ||
    actual.gatewayBundle?.sha256 !== expected.gatewayBundle.sha256
  ) {
    problems.push('gateway-bundle.mjs does not match the bundle recorded after patching');
  }

  const actualPatches = Array.isArray(actual.patches) ? actual.patches : [];
  if (JSON.stringify(actualPatches) !== JSON.stringify(expected.patches)) {
    problems.push(
      'patch file list or checksums do not match the patches used to build the runtime',
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `OpenClaw runtime patch verification failed for ${runtimeRoot}: ${problems.join('; ')}. ` +
        'Rebuild the OpenClaw runtime before packaging.',
    );
  }

  return expected;
}

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const runtimeRoot = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.join(repoRoot, 'vendor', 'openclaw-runtime', 'current');

  try {
    const manifest = verifyOpenClawPatchManifest(runtimeRoot, { repoRoot });
    console.log(
      `[verify-openclaw-runtime-patches] Verified ${manifest.patches.length} patch(es) ` +
        `for ${manifest.openclawVersion}.`,
    );
  } catch (error) {
    console.error(
      `[verify-openclaw-runtime-patches] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  PATCH_MANIFEST_FILENAME,
  buildOpenClawPatchManifest,
  hashFile,
  listPatchFiles,
  verifyOpenClawPatchManifest,
  writeOpenClawPatchManifest,
};
