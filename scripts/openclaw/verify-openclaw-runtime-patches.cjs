'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  runtimePatchDependencyArtifactPaths,
} = require('./openclaw-patch-dependencies.cjs');
const {
  verifyRuntimeCompanionFiles,
  verifyPublicCliRootFiles,
} = require('./openclaw-runtime-companions.cjs');

const PATCH_MANIFEST_FILENAME = 'runtime-patch-manifest.json';
const PATCH_MANIFEST_FORMAT_VERSION = 2;
const RUNTIME_DEPENDENCY_LOCK_FILENAME = 'npm-shrinkwrap.json';
const INITIAL_BUNDLE_PENDING_FILENAME = '.initial-bundle-pending';
const BUILD_RECIPE_FILES = [
  '.nvmrc',
  'package.json',
  'package-lock.json',
  'electron-builder.json',
  'electron-builder.config.cjs',
  'scripts/packaging/electron-builder-hooks.cjs',
  'scripts/packaging/prepare-windows-build.cjs',
  'scripts/packaging/electron-builder-product-metadata.cjs',
  'scripts/openclaw/install-openclaw-runtime.cjs',
  'scripts/openclaw/openclaw-facade-runtime-patch.cjs',
  'scripts/openclaw/openclaw-runtime-dev-lease.cjs',
  'scripts/openclaw/openclaw-runtime-freeze.cjs',
  'scripts/openclaw/openclaw-runtime-companions.cjs',
  'scripts/openclaw/openclaw-runtime-staging.cjs',
  'scripts/openclaw/patch-openclaw-runtime.cjs',
  'scripts/openclaw/openclaw-patch-dependencies.cjs',
  'scripts/openclaw/verify-openclaw-pristine-contracts.cjs',
  'scripts/openclaw/verify-openclaw-runtime-patches.cjs',
  'scripts/openclaw/sync-openclaw-runtime-current.cjs',
  'scripts/openclaw/bundle-openclaw-gateway.cjs',
  'scripts/openclaw/openclaw-shared-sdk-modules.cjs',
  'scripts/openclaw/native-support-contract.cjs',
  'scripts/openclaw/ensure-openclaw-plugins.cjs',
  'scripts/openclaw/patch-mxc-sandbox-plugin.cjs',
  'scripts/openclaw/sync-openclaw-runtime-resources.cjs',
  'plugins/extensions/acpx/package.json',
  'plugins/extensions/acpx/package-lock.json',
  'plugins/extensions/acpx/scripts/runtime-dependencies.cjs',
  'plugins/extensions/acpx/src/codex-auth-bridge.ts',
  'src/shared/providers/mediaGenerationModels.ts',
  'scripts/openclaw/precompile-openclaw-extensions.cjs',
  'scripts/openclaw/prune-openclaw-runtime.cjs',
  'scripts/openclaw/pack-openclaw-tar.cjs',
  'src/main/openclaw/runtime/openclawGatewayBundleLauncher.cjs',
  'src/main/openclaw/runtime/windowsRecursiveRemove.cjs',
  'src/main/openclaw/runtime/electronNodeRuntime.ts',
  'src/main/core/network/trustedCertificates.ts',
  'src/main/openclaw/runtime/mcpPackageRunner.ts',
  'src/main/openclaw/config/openclawConfigBuilders.ts',
  'src/main/openclaw/runtime/native-support/plugin-owned-execution.mjs',
  'src/main/openclaw/runtime/native-support/compaction-lifecycle.mjs',
  'src/main/openclaw/runtime/native-support/goal-continuation.mjs',
  'plugins/extensions/runtime-services/tool-call-recovery/policy.mjs',
  'plugins/extensions/runtime-services/tool-call-recovery/facts.mjs',
  'plugins/extensions/runtime-services/tool-call-recovery/loop.mjs',
  'src/shared/openclaw/cliRuntimeFiles.json',
  'src/shared/security/mxcNativeBinaries.json',
  'resources/openclaw-extension-prune.json',
  'plugins/skills/builtin-skills.json',
  'scripts/runtime/sync-bundled-skills.cjs',
  'plugins/extensions/drawio/scripts/prepare.cjs',
  'plugins/extensions/drawio/scripts/verify-packaged.cjs',
  'plugins/extensions/drawio/package.json',
  'plugins/extensions/drawio/openclaw.plugin.json',
  'plugins/extensions/drawio/index.ts',
  'plugins/extensions/drawio/upstream.json',
  'plugins/extensions/drawio/licenses/saxes-6.0.0.txt',
  'plugins/extensions/drawio/server.mjs',
  'plugins/extensions/drawio/app.ts',
  'plugins/extensions/drawio/app.css',
  'plugins/extensions/drawio/editor-bridge.js',
];

function normalizeOpenClawVersion(version) {
  if (typeof version !== 'string' || !version.trim()) {
    throw new Error('Missing OpenClaw version');
  }
  const normalized = version.trim().replace(/^v?/, 'v');
  if (!/^v\d{4}\.\d{1,2}\.\d{1,2}(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/.test(normalized)) {
    throw new Error(`Invalid OpenClaw version: ${version}`);
  }
  return normalized;
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

function listPatchInputFiles(repoRoot, version) {
  const normalizedVersion = normalizeOpenClawVersion(version);
  const patchDir = path.join(repoRoot, 'scripts', 'patches', normalizedVersion);
  if (!fs.existsSync(patchDir)) {
    return [];
  }

  return fs
    .readdirSync(patchDir, { withFileTypes: true })
    .filter(
      entry =>
        entry.isFile() &&
        (entry.name.endsWith('.cjs') ||
          entry.name.endsWith('.js') ||
          entry.name === 'source-lock.json'),
    )
    .map(entry => path.join(patchDir, entry.name))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function buildRuntimePatchDependencyArtifacts(runtimeRoot, version) {
  return runtimePatchDependencyArtifactPaths(runtimeRoot, version).map(filePath => ({
    path: path.relative(runtimeRoot, filePath).replace(/\\/g, '/'),
    size: fs.statSync(filePath).size,
    sha256: hashFile(filePath),
  }));
}

function readJsonFile(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(
      `${label} is missing or invalid: ${filePath}. ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

function verifyFrozenOpenClawRuntime(runtimeRoot, options = {}) {
  const buildInfoPath = path.join(runtimeRoot, 'runtime-build-info.json');
  const buildInfo = readJsonFile(buildInfoPath, 'OpenClaw runtime build info');
  const problems = [];
  const gatewayAsarPath = path.join(runtimeRoot, 'gateway.asar');
  const runtimePackagePath = path.join(runtimeRoot, 'package.json');
  const runtimePackageLockPath = path.join(runtimeRoot, RUNTIME_DEPENDENCY_LOCK_FILENAME);
  const requiredFiles = [gatewayAsarPath, runtimePackagePath, runtimePackageLockPath];
  const isSha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);

  try {
    normalizeOpenClawVersion(buildInfo.openclawVersion);
  } catch {
    problems.push('OpenClaw version is invalid');
  }
  if (
    options.expectedVersion &&
    buildInfo.openclawVersion !== normalizeOpenClawVersion(options.expectedVersion)
  ) {
    problems.push(
      `OpenClaw version is ${String(buildInfo.openclawVersion)}, expected ${normalizeOpenClawVersion(options.expectedVersion)}`,
    );
  }
  if (buildInfo.npmPackageVersion !== String(buildInfo.openclawVersion || '').replace(/^v/, '')) {
    problems.push('npm package version does not match the OpenClaw version');
  }
  if (!isCanonicalSha512Integrity(buildInfo.npmIntegrity)) {
    problems.push('npm package integrity is invalid');
  }
  for (const field of [
    'npmTarballSha256',
    'patchSetSha256',
    'buildRecipeSha256',
    'gatewayAsarSha256',
    'runtimePackageSha256',
    'runtimePackageLockSha256',
  ]) {
    if (!isSha256(buildInfo[field])) problems.push(`${field} is not a SHA-256 digest`);
  }
  if (options.expectedTarget && buildInfo.target !== options.expectedTarget) {
    problems.push(
      `runtime target is ${String(buildInfo.target)}, expected ${options.expectedTarget}`,
    );
  }
  if (buildInfo.installMethod !== 'npm-package') {
    problems.push(`install method is ${String(buildInfo.installMethod)}, expected npm-package`);
  }
  if (buildInfo.runtimePackageLockPath !== RUNTIME_DEPENDENCY_LOCK_FILENAME) {
    problems.push('runtime dependency lock path is invalid');
  }
  for (const filePath of requiredFiles) {
    if (!fs.existsSync(filePath))
      problems.push(`required artifact is missing: ${path.basename(filePath)}`);
  }
  if (problems.length === 0) {
    if (buildInfo.gatewayAsarSha256 !== hashFile(gatewayAsarPath)) {
      problems.push('gateway.asar does not match runtime-build-info.json');
    }
    if (buildInfo.runtimePackageSha256 !== hashFile(runtimePackagePath)) {
      problems.push('package.json does not match runtime-build-info.json');
    }
    if (buildInfo.runtimePackageLockSha256 !== hashFile(runtimePackageLockPath)) {
      problems.push(`${RUNTIME_DEPENDENCY_LOCK_FILENAME} does not match runtime-build-info.json`);
    }
  }

  let manifest;
  if (options.requireBundle) {
    const manifestPath = path.join(runtimeRoot, PATCH_MANIFEST_FILENAME);
    const bundlePath = path.join(runtimeRoot, 'gateway-bundle.mjs');
    manifest = readJsonFile(manifestPath, 'OpenClaw runtime patch manifest');
    if (!fs.existsSync(bundlePath)) {
      problems.push('gateway-bundle.mjs is missing');
    } else {
      const bundleStat = fs.statSync(bundlePath);
      try {
        verifyRuntimeCompanionFiles(runtimeRoot, fs.readFileSync(bundlePath, 'utf8'));
      } catch (error) {
        problems.push(error.message);
      }
      if (
        manifest.gatewayBundle?.path !== 'gateway-bundle.mjs' ||
        manifest.gatewayBundle?.size !== bundleStat.size ||
        manifest.gatewayBundle?.sha256 !== hashFile(bundlePath)
      ) {
        problems.push('gateway-bundle.mjs does not match the frozen patch manifest');
      }
    }
    if (manifest.formatVersion !== PATCH_MANIFEST_FORMAT_VERSION) {
      problems.push('patch manifest format is invalid');
    }
    if (manifest.openclawVersion !== buildInfo.openclawVersion) {
      problems.push('patch manifest OpenClaw version does not match runtime-build-info.json');
    }
    if (manifest.target !== buildInfo.target) {
      problems.push('patch manifest target does not match runtime-build-info.json');
    }
    const expectedSourcePackage = {
      npmVersion: buildInfo.npmPackageVersion,
      integrity: buildInfo.npmIntegrity,
      tarballSha256: buildInfo.npmTarballSha256,
    };
    if (JSON.stringify(manifest.sourcePackage) !== JSON.stringify(expectedSourcePackage)) {
      problems.push('patch manifest source package does not match runtime-build-info.json');
    }
    if (
      manifest.patchSetSha256 !== buildInfo.patchSetSha256 ||
      manifest.buildRecipeSha256 !== buildInfo.buildRecipeSha256
    ) {
      problems.push('patch manifest fingerprints do not match runtime-build-info.json');
    }
    const expectedSourceArtifacts = {
      gatewayAsarSha256: buildInfo.gatewayAsarSha256,
      runtimePackageSha256: buildInfo.runtimePackageSha256,
      runtimePackageLockPath: buildInfo.runtimePackageLockPath,
      runtimePackageLockSha256: buildInfo.runtimePackageLockSha256,
    };
    if (JSON.stringify(manifest.sourceArtifacts) !== JSON.stringify(expectedSourceArtifacts)) {
      problems.push('patch manifest source artifacts do not match runtime-build-info.json');
    }
    try {
      const dependencies = buildRuntimePatchDependencyArtifacts(
        runtimeRoot,
        buildInfo.openclawVersion,
      );
      if (JSON.stringify(manifest.patchDependencyArtifacts) !== JSON.stringify(dependencies)) {
        problems.push('runtime patch dependencies do not match the frozen patch manifest');
      }
    } catch (error) {
      problems.push(`runtime patch dependencies are invalid: ${error.message}`);
    }
    if (
      !Array.isArray(manifest.patches) ||
      manifest.patches.length === 0 ||
      manifest.patches.some(
        patch =>
          !patch ||
          typeof patch.file !== 'string' ||
          !patch.file.endsWith('.cjs') ||
          !isSha256(patch.sha256),
      )
    ) {
      problems.push('patch manifest has no completed patches');
    }
    if (
      !Array.isArray(manifest.patchSupportFiles) ||
      manifest.patchSupportFiles.some(
        support => !support || typeof support.file !== 'string' || !isSha256(support.sha256),
      )
    ) {
      problems.push('patch manifest support-file proof is invalid');
    }
  }

  if (problems.length > 0) {
    throw new Error(`Frozen OpenClaw runtime verification failed: ${problems.join('; ')}`);
  }
  return { buildInfo, manifest };
}

function isCanonicalSha512Integrity(value) {
  if (typeof value !== 'string' || !value.startsWith('sha512-')) return false;
  const encoded = value.slice('sha512-'.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
  const digest = Buffer.from(encoded, 'base64');
  return digest.length === 64 && digest.toString('base64') === encoded;
}

function hashFileSet(repoRoot, filePaths) {
  const hash = crypto.createHash('sha256');
  for (const filePath of filePaths) {
    const relativePath = path.relative(repoRoot, filePath).replace(/\\/g, '/');
    hash.update(relativePath);
    hash.update('\0');
    hash.update(fs.readFileSync(filePath));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function buildOpenClawPatchSetFingerprint(repoRoot, version) {
  const patchFiles = listPatchFiles(repoRoot, version);
  if (patchFiles.length === 0) {
    throw new Error(`No OpenClaw patches found for ${normalizeOpenClawVersion(version)}`);
  }
  return hashFileSet(repoRoot, listPatchInputFiles(repoRoot, version));
}

function listBuildRecipeFiles(repoRoot) {
  const replacementRoot = path.join(repoRoot, 'plugins/extensions', 'openai');
  const replacementFiles = fs.existsSync(replacementRoot)
    ? fs
        .readdirSync(replacementRoot, { recursive: true, withFileTypes: true })
        .filter(
          entry =>
            entry.isFile() &&
            !path
              .relative(replacementRoot, entry.parentPath)
              .split(path.sep)
              .includes('node_modules') &&
            !entry.name.includes('.test.') &&
            !entry.name.endsWith('.md'),
        )
        .map(entry => path.join(entry.parentPath, entry.name))
        .sort()
    : [];
  return [
    ...BUILD_RECIPE_FILES.map(relativePath => path.join(repoRoot, relativePath)),
    ...replacementFiles,
  ];
}

function buildOpenClawBuildRecipeFingerprint(repoRoot, version) {
  const recipeFiles = listBuildRecipeFiles(repoRoot);
  const missing = recipeFiles.filter(filePath => !fs.existsSync(filePath));
  if (missing.length > 0) {
    throw new Error(
      `OpenClaw build recipe is incomplete: ${missing
        .map(filePath => path.relative(repoRoot, filePath).replace(/\\/g, '/'))
        .join(', ')}`,
    );
  }
  return hashFileSet(repoRoot, [...recipeFiles, ...listPatchInputFiles(repoRoot, version)]);
}

function readOpenClawSourceLock(repoRoot, version) {
  const normalizedVersion = normalizeOpenClawVersion(version);
  const sourceLockPath = path.join(
    repoRoot,
    'scripts',
    'patches',
    normalizedVersion,
    'source-lock.json',
  );
  let sourceLock;
  try {
    sourceLock = JSON.parse(fs.readFileSync(sourceLockPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `OpenClaw npm source lock is missing or invalid: ${sourceLockPath}. ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  if (
    sourceLock?.name !== 'openclaw' ||
    sourceLock?.version !== normalizedVersion.slice(1) ||
    !isCanonicalSha512Integrity(sourceLock?.integrity) ||
    !/^[a-f0-9]{64}$/i.test(sourceLock?.tarballSha256 || '')
  ) {
    throw new Error(`OpenClaw npm source lock has an invalid schema: ${sourceLockPath}`);
  }
  return sourceLock;
}

function buildOpenClawPatchManifest(runtimeRoot, options = {}) {
  const repoRoot = options.repoRoot || path.resolve(__dirname, '../..');
  const version = normalizeOpenClawVersion(options.version || readOpenClawVersion(repoRoot));
  const gatewayBundlePath = path.join(runtimeRoot, 'gateway-bundle.mjs');
  const gatewayAsarPath = path.join(runtimeRoot, 'gateway.asar');
  const runtimePackagePath = path.join(runtimeRoot, 'package.json');
  const runtimePackageLockPath = path.join(runtimeRoot, RUNTIME_DEPENDENCY_LOCK_FILENAME);
  if (!fs.existsSync(gatewayBundlePath)) {
    throw new Error(`Gateway bundle not found: ${gatewayBundlePath}`);
  }
  const gatewayAsarExists = fs.existsSync(gatewayAsarPath);
  if (
    (!gatewayAsarExists && options.allowOmittedGatewayAsar !== true) ||
    !fs.existsSync(runtimePackagePath) ||
    !fs.existsSync(runtimePackageLockPath)
  ) {
    throw new Error(`OpenClaw runtime source artifacts are incomplete: ${runtimeRoot}`);
  }
  if (!gatewayAsarExists) verifyPublicCliRootFiles(runtimeRoot);

  const patchFiles = listPatchFiles(repoRoot, version);
  if (patchFiles.length === 0) {
    throw new Error(`No OpenClaw patches found for ${version}`);
  }

  const buildInfoPath = path.join(runtimeRoot, 'runtime-build-info.json');
  const buildInfo = fs.existsSync(buildInfoPath)
    ? JSON.parse(fs.readFileSync(buildInfoPath, 'utf8'))
    : null;
  const patchSetSha256 = buildOpenClawPatchSetFingerprint(repoRoot, version);
  const buildRecipeSha256 = buildOpenClawBuildRecipeFingerprint(repoRoot, version);
  const sourceLock = readOpenClawSourceLock(repoRoot, version);
  const expectedNpmVersion = version.slice(1);
  if (
    !buildInfo ||
    buildInfo.openclawVersion !== version ||
    buildInfo.installMethod !== 'npm-package' ||
    typeof buildInfo.target !== 'string' ||
    buildInfo.npmPackageVersion !== expectedNpmVersion ||
    buildInfo.npmPackageVersion !== sourceLock.version ||
    buildInfo.npmIntegrity !== sourceLock.integrity ||
    buildInfo.npmTarballSha256 !== sourceLock.tarballSha256 ||
    buildInfo.patchSetSha256 !== patchSetSha256 ||
    buildInfo.buildRecipeSha256 !== buildRecipeSha256 ||
    buildInfo.runtimePackageLockPath !== RUNTIME_DEPENDENCY_LOCK_FILENAME ||
    !/^[a-f0-9]{64}$/i.test(buildInfo.gatewayAsarSha256 || '') ||
    (gatewayAsarExists && buildInfo.gatewayAsarSha256 !== hashFile(gatewayAsarPath)) ||
    buildInfo.runtimePackageSha256 !== hashFile(runtimePackagePath) ||
    buildInfo.runtimePackageLockSha256 !== hashFile(runtimePackageLockPath)
  ) {
    throw new Error(
      'OpenClaw runtime source proof is missing, incomplete, or stale; rebuild from the target npm package.',
    );
  }

  return {
    formatVersion: PATCH_MANIFEST_FORMAT_VERSION,
    openclawVersion: version,
    target: buildInfo.target,
    sourcePackage: {
      npmVersion: buildInfo.npmPackageVersion,
      integrity: buildInfo.npmIntegrity,
      tarballSha256: buildInfo.npmTarballSha256,
    },
    patchSetSha256,
    buildRecipeSha256,
    gatewayBundle: {
      path: 'gateway-bundle.mjs',
      size: fs.statSync(gatewayBundlePath).size,
      sha256: hashFile(gatewayBundlePath),
    },
    sourceArtifacts: {
      gatewayAsarSha256: buildInfo.gatewayAsarSha256,
      runtimePackageSha256: buildInfo.runtimePackageSha256,
      runtimePackageLockPath: buildInfo.runtimePackageLockPath,
      runtimePackageLockSha256: buildInfo.runtimePackageLockSha256,
    },
    patchDependencyArtifacts: buildRuntimePatchDependencyArtifacts(runtimeRoot, version),
    patches: patchFiles.map(filePath => ({
      file: path.relative(repoRoot, filePath).replace(/\\/g, '/'),
      sha256: hashFile(filePath),
    })),
    patchSupportFiles: listPatchInputFiles(repoRoot, version)
      .filter(filePath => !filePath.endsWith('.cjs'))
      .map(filePath => ({
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
  const repoRoot = options.repoRoot || path.resolve(__dirname, '../..');
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

  const expected = buildOpenClawPatchManifest(runtimeRoot, {
    repoRoot,
    version,
    allowOmittedGatewayAsar: options.allowOmittedGatewayAsar,
  });
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
  if (actual.target !== expected.target) {
    problems.push(
      `runtime target is ${String(actual.target)}, expected ${String(expected.target)}`,
    );
  }
  if (options.expectedTarget && expected.target !== options.expectedTarget) {
    problems.push(
      `runtime target is ${String(expected.target)}, expected packaging target ${options.expectedTarget}`,
    );
  }
  if (JSON.stringify(actual.sourcePackage) !== JSON.stringify(expected.sourcePackage)) {
    problems.push('source npm package identity does not match runtime-build-info.json');
  }
  if (actual.patchSetSha256 !== expected.patchSetSha256) {
    problems.push('patch-set fingerprint does not match the current target-version patch files');
  }
  if (actual.buildRecipeSha256 !== expected.buildRecipeSha256) {
    problems.push('build-recipe fingerprint does not match the current runtime build scripts');
  }
  if (
    actual.gatewayBundle?.path !== expected.gatewayBundle.path ||
    actual.gatewayBundle?.size !== expected.gatewayBundle.size ||
    actual.gatewayBundle?.sha256 !== expected.gatewayBundle.sha256
  ) {
    problems.push('gateway-bundle.mjs does not match the bundle recorded after patching');
  }
  if (JSON.stringify(actual.sourceArtifacts) !== JSON.stringify(expected.sourceArtifacts)) {
    problems.push('runtime source artifacts do not match runtime-build-info.json');
  }
  if (
    JSON.stringify(actual.patchDependencyArtifacts) !== JSON.stringify(expected.patchDependencyArtifacts)
  ) {
    problems.push('runtime patch dependencies do not match the recorded dependency artifacts');
  }

  const actualPatches = Array.isArray(actual.patches) ? actual.patches : [];
  if (JSON.stringify(actualPatches) !== JSON.stringify(expected.patches)) {
    problems.push(
      'patch file list or checksums do not match the patches used to build the runtime',
    );
  }
  if (JSON.stringify(actual.patchSupportFiles) !== JSON.stringify(expected.patchSupportFiles)) {
    problems.push('patch helper or source-lock checksums do not match the audited patch set');
  }

  if (problems.length > 0) {
    throw new Error(
      `OpenClaw runtime patch verification failed for ${runtimeRoot}: ${problems.join('; ')}. ` +
        'Rebuild the OpenClaw runtime before packaging.',
    );
  }

  verifyRuntimeCompanionFiles(
    runtimeRoot,
    fs.readFileSync(path.join(runtimeRoot, 'gateway-bundle.mjs'), 'utf8'),
  );

  return expected;
}

function main() {
  const repoRoot = path.resolve(__dirname, '../..');
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
  INITIAL_BUNDLE_PENDING_FILENAME,
  PATCH_MANIFEST_FILENAME,
  buildOpenClawBuildRecipeFingerprint,
  buildOpenClawPatchManifest,
  buildOpenClawPatchSetFingerprint,
  hashFile,
  listPatchFiles,
  listBuildRecipeFiles,
  listPatchInputFiles,
  normalizeOpenClawVersion,
  readOpenClawSourceLock,
  verifyFrozenOpenClawRuntime,
  verifyOpenClawPatchManifest,
  writeOpenClawPatchManifest,
};
