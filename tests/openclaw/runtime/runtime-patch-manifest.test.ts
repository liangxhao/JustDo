import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

const {
  PATCH_MANIFEST_FILENAME,
  buildOpenClawBuildRecipeFingerprint,
  buildOpenClawPatchSetFingerprint,
  normalizeOpenClawVersion,
  readOpenClawSourceLock,
  verifyFrozenOpenClawRuntime,
  verifyOpenClawPatchManifest,
  writeOpenClawPatchManifest,
} = require('../../../scripts/verify-openclaw-runtime-patches.cjs') as {
  PATCH_MANIFEST_FILENAME: string;
  buildOpenClawBuildRecipeFingerprint: (repoRoot: string, version: string) => string;
  buildOpenClawPatchSetFingerprint: (repoRoot: string, version: string) => string;
  normalizeOpenClawVersion: (version: string) => string;
  readOpenClawSourceLock: (
    repoRoot: string,
    version: string,
  ) => { version: string; integrity: string; tarballSha256: string };
  verifyFrozenOpenClawRuntime: (
    runtimeRoot: string,
    options?: { expectedTarget?: string; requireBundle?: boolean },
  ) => { buildInfo: Record<string, unknown> };
  verifyOpenClawPatchManifest: (
    runtimeRoot: string,
    options: {
      repoRoot: string;
      expectedTarget?: string;
      allowOmittedGatewayAsar?: boolean;
    },
  ) => { patches: Array<{ file: string; sha256: string }> };
  writeOpenClawPatchManifest: (
    runtimeRoot: string,
    options: { repoRoot: string },
  ) => { manifestPath: string };
};
const { verifyPackagedOpenClawRuntime } = require('../../../scripts/electron-builder-hooks.cjs') as {
  verifyPackagedOpenClawRuntime: (context: {
    appOutDir: string;
    electronPlatformName: string;
  }) => Promise<void>;
};
const { compressTarArchive } = require('../../../scripts/pack-openclaw-tar.cjs') as {
  compressTarArchive: (sourceTar: string, outputArchive: string) => Promise<void>;
};
const { ensureOpenClawRuntimePatches, patchOpenClawRuntime } =
  require('../../../scripts/patch-openclaw-runtime.cjs') as {
    ensureOpenClawRuntimePatches: (
      runtimeRoot: string,
      options: { repoRoot: string },
    ) => { cached: boolean };
    patchOpenClawRuntime: (
      runtimeRoot: string,
      options: { repoRoot: string; pristineInstallPass?: boolean; freshBundlePass?: boolean },
    ) => Array<{ file: string }>;
  };

const temporaryRoots: string[] = [];
const fixtureIntegrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;

function writeFixtureBuildInfo(
  repoRoot: string,
  runtimeRoot: string,
  overrides: Record<string, unknown> = {},
) {
  const version = 'v2026.6.11';
  fs.writeFileSync(
    path.join(runtimeRoot, 'runtime-build-info.json'),
    JSON.stringify({
      openclawVersion: version,
      installMethod: 'npm-package',
      target: 'win-x64',
      npmPackageVersion: version.slice(1),
      npmIntegrity: fixtureIntegrity,
      npmTarballSha256: 'a'.repeat(64),
      patchSetSha256: buildOpenClawPatchSetFingerprint(repoRoot, version),
      buildRecipeSha256: buildOpenClawBuildRecipeFingerprint(repoRoot, version),
      gatewayAsarSha256: crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(runtimeRoot, 'gateway.asar')))
        .digest('hex'),
      runtimePackageSha256: crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(runtimeRoot, 'package.json')))
        .digest('hex'),
      runtimePackageLockPath: 'npm-shrinkwrap.json',
      runtimePackageLockSha256: crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(runtimeRoot, 'npm-shrinkwrap.json')))
        .digest('hex'),
      ...overrides,
    }),
  );
}

function createFixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-patch-manifest-test-'));
  temporaryRoots.push(repoRoot);
  const runtimeRoot = path.join(repoRoot, 'runtime');
  const patchRoot = path.join(repoRoot, 'scripts', 'patches', 'v2026.6.11');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.mkdirSync(patchRoot, { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({ openclaw: { version: 'v2026.6.11' } }),
  );
  fs.writeFileSync(path.join(repoRoot, '.nvmrc'), '24.15.0\n');
  fs.writeFileSync(path.join(repoRoot, 'package-lock.json'), '{}\n');
  fs.writeFileSync(path.join(repoRoot, 'electron-builder.json'), '{}\n');
  fs.writeFileSync(path.join(repoRoot, 'electron-builder.config.cjs'), '// fixture\n');
  for (const scriptName of [
    'electron-builder-hooks.cjs',
    'install-openclaw-runtime.cjs',
    'openclaw-runtime-freeze.cjs',
    'openclaw-runtime-staging.cjs',
    'patch-openclaw-runtime.cjs',
    'verify-openclaw-pristine-contracts.cjs',
    'verify-openclaw-runtime-patches.cjs',
    'sync-openclaw-runtime-current.cjs',
    'bundle-openclaw-gateway.cjs',
    'ensure-openclaw-plugins.cjs',
    'sync-openclaw-runtime-resources.cjs',
    'precompile-openclaw-extensions.cjs',
    'prune-openclaw-runtime.cjs',
    'pack-openclaw-tar.cjs',
  ]) {
    fs.writeFileSync(path.join(repoRoot, 'scripts', scriptName), `// ${scriptName}\n`);
  }
  fs.mkdirSync(path.join(repoRoot, 'src', 'main', 'openclaw', 'runtime'), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, 'src', 'main', 'openclaw', 'runtime', 'openclawGatewayBundleLauncher.cjs'),
    '// fixture\n',
  );
  fs.mkdirSync(path.join(repoRoot, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'resources', 'openclaw-extension-prune.json'), '{}\n');
  fs.writeFileSync(path.join(repoRoot, 'resources', 'builtin-skills.json'), '{}\n');
  fs.writeFileSync(path.join(runtimeRoot, 'gateway-bundle.mjs'), 'const patched = true;\n');
  fs.writeFileSync(path.join(runtimeRoot, 'gateway.asar'), 'fixture asar\n');
  fs.writeFileSync(path.join(runtimeRoot, 'package.json'), '{}\n');
  fs.writeFileSync(path.join(runtimeRoot, 'npm-shrinkwrap.json'), '{}\n');
  const verifiedPatch = `
const fs = require('fs');
const path = require('path');
function applyPatch(runtimeRoot) {
  const bundlePath = path.join(runtimeRoot, 'gateway-bundle.mjs');
  const content = fs.readFileSync(bundlePath, 'utf8');
  if (!content.includes('const verified = true;')) {
    fs.appendFileSync(bundlePath, 'const verified = true;\\n');
  }
}
function verifyPatch(runtimeRoot) {
  const content = fs.readFileSync(path.join(runtimeRoot, 'gateway-bundle.mjs'), 'utf8');
  if (!content.includes('const verified = true;')) throw new Error('patch verification failed');
}
module.exports = { applyPatch, verifyPatch };
`;
  fs.writeFileSync(path.join(patchRoot, '001-example.cjs'), verifiedPatch);
  fs.writeFileSync(path.join(patchRoot, '002-example.cjs'), verifiedPatch);
  fs.writeFileSync(
    path.join(patchRoot, 'source-lock.json'),
    JSON.stringify({
      name: 'openclaw',
      version: '2026.6.11',
      integrity: fixtureIntegrity,
      tarballSha256: 'a'.repeat(64),
    }),
  );
  writeFixtureBuildInfo(repoRoot, runtimeRoot);
  return { patchRoot, repoRoot, runtimeRoot };
}

afterEach(() => {
  for (const temporaryRoot of temporaryRoots.splice(0)) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

describe('OpenClaw runtime patch manifest', () => {
  test('packaging relies on the target-version manifest instead of legacy patch strings', () => {
    const hookSource = fs.readFileSync(
      path.resolve(__dirname, '../../..', 'scripts', 'electron-builder-hooks.cjs'),
      'utf8',
    );

    expect(hookSource).toContain('verifyOpenClawPatchManifest(runtimeRoot');
    expect(hookSource).not.toContain('verifyOpenClawReasoningStreamPatches');
    expect(hookSource).not.toContain('strict streaming for content reasoning tags');
  });

  test('an mtime-fresh bundle is skipped only when its patch proof is current', () => {
    const bundleSource = fs.readFileSync(
      path.resolve(__dirname, '../../..', 'scripts', 'bundle-openclaw-gateway.cjs'),
      'utf8',
    );
    const freshnessCheck = bundleSource.indexOf('bundleStat.mtimeMs >');
    const proofCheck = bundleSource.indexOf(
      'const manifest = verifyOpenClawPatchManifest(runtimeDir',
      freshnessCheck,
    );
    const skipExit = bundleSource.indexOf('process.exit(0);', proofCheck);
    const staleRebuild = bundleSource.indexOf('Bundle proof is stale or missing', skipExit);
    const bundleStart = bundleSource.indexOf('Bundling:', staleRebuild);

    expect(freshnessCheck).toBeGreaterThan(-1);
    expect(proofCheck).toBeGreaterThan(freshnessCheck);
    expect(skipExit).toBeGreaterThan(proofCheck);
    expect(staleRebuild).toBeGreaterThan(skipExit);
    expect(bundleStart).toBeGreaterThan(staleRebuild);
    expect(bundleSource).not.toContain('ensureOpenClawRuntimePatches');
  });

  test('accepts dated npm revisions and rejects malformed OpenClaw versions', () => {
    expect(normalizeOpenClawVersion('2026.7.1-2')).toBe('v2026.7.1-2');
    expect(normalizeOpenClawVersion('v2026.7.1-2')).toBe('v2026.7.1-2');
    expect(() => normalizeOpenClawVersion('v2026.7')).toThrow('Invalid OpenClaw version');
    expect(() => normalizeOpenClawVersion('latest')).toThrow('Invalid OpenClaw version');
  });

  test('writes the proof only after the complete patch pass succeeds', () => {
    const { repoRoot, runtimeRoot } = createFixture();

    const results = patchOpenClawRuntime(runtimeRoot, { repoRoot, freshBundlePass: true });

    expect(results).toHaveLength(2);
    expect(fs.existsSync(path.join(runtimeRoot, PATCH_MANIFEST_FILENAME))).toBe(true);
    expect(() => verifyOpenClawPatchManifest(runtimeRoot, { repoRoot })).not.toThrow();
  });

  test('reuses a complete frozen runtime when only current build inputs changed', () => {
    const { repoRoot, runtimeRoot } = createFixture();
    patchOpenClawRuntime(runtimeRoot, { repoRoot, freshBundlePass: true });
    fs.appendFileSync(
      path.join(repoRoot, 'scripts', 'bundle-openclaw-gateway.cjs'),
      '// changed\n',
    );

    expect(() =>
      verifyFrozenOpenClawRuntime(runtimeRoot, {
        expectedTarget: 'win-x64',
        requireBundle: true,
      }),
    ).not.toThrow();
    expect(() => verifyOpenClawPatchManifest(runtimeRoot, { repoRoot })).toThrow(
      /source proof is missing, incomplete, or stale/,
    );
  });

  test('rejects a frozen runtime with a missing patch proof or tampered bundle', () => {
    const { repoRoot, runtimeRoot } = createFixture();

    expect(() => verifyFrozenOpenClawRuntime(runtimeRoot, { requireBundle: true })).toThrow(
      /patch manifest is missing or invalid/,
    );

    patchOpenClawRuntime(runtimeRoot, { repoRoot, freshBundlePass: true });
    fs.appendFileSync(path.join(runtimeRoot, 'gateway-bundle.mjs'), '// tampered\n');

    expect(() => verifyFrozenOpenClawRuntime(runtimeRoot, { requireBundle: true })).toThrow(
      /does not match the frozen patch manifest/,
    );
  });

  test('rejects damaged frozen source artifacts instead of silently rebuilding them', () => {
    const { runtimeRoot } = createFixture();
    fs.appendFileSync(path.join(runtimeRoot, 'gateway.asar'), 'tampered\n');

    expect(() => verifyFrozenOpenClawRuntime(runtimeRoot, { expectedTarget: 'win-x64' })).toThrow(
      /gateway\.asar does not match runtime-build-info\.json/,
    );
  });

  test('rejects incomplete frozen metadata and mismatched source identity', () => {
    const { repoRoot, runtimeRoot } = createFixture();
    patchOpenClawRuntime(runtimeRoot, { repoRoot, freshBundlePass: true });
    const buildInfoPath = path.join(runtimeRoot, 'runtime-build-info.json');
    const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8')) as Record<string, unknown>;
    delete buildInfo.patchSetSha256;
    fs.writeFileSync(buildInfoPath, JSON.stringify(buildInfo));

    expect(() => verifyFrozenOpenClawRuntime(runtimeRoot, { requireBundle: true })).toThrow(
      /patchSetSha256 is not a SHA-256 digest/,
    );

    writeFixtureBuildInfo(repoRoot, runtimeRoot);
    const manifestPath = path.join(runtimeRoot, PATCH_MANIFEST_FILENAME);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.sourcePackage = { npmVersion: 'invalid' };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    expect(() => verifyFrozenOpenClawRuntime(runtimeRoot, { requireBundle: true })).toThrow(
      /source package does not match runtime-build-info\.json/,
    );
  });

  test('shares the target-version snapshot index across apply and final verification', () => {
    const { patchRoot, repoRoot, runtimeRoot } = createFixture();
    const patchUtilsPath = path.resolve(
      __dirname,
      '../../..',
      'scripts',
      'patches',
      'v2026.7.1-2',
      '_patch-utils.js',
    );
    fs.writeFileSync(
      path.join(patchRoot, '_patch-utils.js'),
      `module.exports = require(${JSON.stringify(patchUtilsPath)});\n`,
    );
    fs.writeFileSync(
      path.join(patchRoot, '001-example.cjs'),
      `const path = require('path');
      const { findFilesContaining, writeIfChanged } = require('./_patch-utils.js');
      module.exports = {
        applyPatch(root) {
          const [file] = findFilesContaining(root, 'const patched = true;');
          const original = require('fs').readFileSync(file, 'utf8');
          writeIfChanged(file, original, original + 'const firstIndexed = true;\\n');
        },
        verifyPatch(root) {
          if (findFilesContaining(root, 'const firstIndexed = true;').length !== 1) {
            throw new Error('first indexed patch missing');
          }
        },
      };\n`,
    );
    fs.writeFileSync(
      path.join(patchRoot, '002-example.cjs'),
      `const { findFilesContaining } = require('./_patch-utils.js');
      module.exports = {
        applyPatch(root) {
          if (findFilesContaining(root, 'const firstIndexed = true;').length !== 1) {
            throw new Error('updated index was not visible');
          }
          return [];
        },
        verifyPatch(root) {
          if (findFilesContaining(root, 'const firstIndexed = true;').length !== 1) {
            throw new Error('updated index was not preserved');
          }
        },
      };\n`,
    );
    writeFixtureBuildInfo(repoRoot, runtimeRoot);

    expect(() =>
      patchOpenClawRuntime(runtimeRoot, { repoRoot, freshBundlePass: true }),
    ).not.toThrow();
    expect(fs.readFileSync(path.join(runtimeRoot, 'gateway-bundle.mjs'), 'utf8')).toContain(
      'const firstIndexed = true;',
    );
  });

  test('skips the patch pass when the recorded patch set and bundle are unchanged', () => {
    const { patchRoot, repoRoot, runtimeRoot } = createFixture();
    const counterPath = path.join(runtimeRoot, 'apply-count.txt').replace(/\\/g, '\\\\');
    const countingPatch = `
const fs = require('fs');
const path = require('path');
function applyPatch(runtimeRoot) {
  const counterPath = '${counterPath}';
  const count = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) : 0;
  fs.writeFileSync(counterPath, String(count + 1));
  const bundlePath = path.join(runtimeRoot, 'gateway-bundle.mjs');
  const content = fs.readFileSync(bundlePath, 'utf8');
  if (!content.includes('const verified = true;')) {
    fs.appendFileSync(bundlePath, 'const verified = true;\\n');
  }
}
function verifyPatch(runtimeRoot) {
  const content = fs.readFileSync(path.join(runtimeRoot, 'gateway-bundle.mjs'), 'utf8');
  if (!content.includes('const verified = true;')) throw new Error('patch verification failed');
}
module.exports = { applyPatch, verifyPatch };
`;
    fs.writeFileSync(path.join(patchRoot, '001-example.cjs'), countingPatch);
    fs.writeFileSync(path.join(patchRoot, '002-example.cjs'), countingPatch);
    writeFixtureBuildInfo(repoRoot, runtimeRoot);
    patchOpenClawRuntime(runtimeRoot, { repoRoot, freshBundlePass: true });

    const result = ensureOpenClawRuntimePatches(runtimeRoot, { repoRoot });

    expect(result.cached).toBe(true);
    expect(fs.readFileSync(path.join(runtimeRoot, 'apply-count.txt'), 'utf8')).toBe('2');
  });

  test('does not write proof when any patch fails', () => {
    const { patchRoot, repoRoot, runtimeRoot } = createFixture();
    const bundlePath = path.join(runtimeRoot, 'gateway-bundle.mjs');
    const originalBundle = fs.readFileSync(bundlePath);
    fs.writeFileSync(
      path.join(patchRoot, '002-example.cjs'),
      "module.exports = { applyPatch() { throw new Error('patch failed'); }, verifyPatch() {} };\n",
    );
    writeFixtureBuildInfo(repoRoot, runtimeRoot);

    expect(() => patchOpenClawRuntime(runtimeRoot, { repoRoot, freshBundlePass: true })).toThrow(
      'patch failed',
    );
    expect(fs.existsSync(path.join(runtimeRoot, PATCH_MANIFEST_FILENAME))).toBe(false);
    expect(fs.readFileSync(bundlePath)).toEqual(originalBundle);
  });

  test('rejects a silent no-op patch without applied-state evidence', () => {
    const { patchRoot, repoRoot, runtimeRoot } = createFixture();
    const bundlePath = path.join(runtimeRoot, 'gateway-bundle.mjs');
    const originalBundle = fs.readFileSync(bundlePath);
    fs.writeFileSync(
      path.join(patchRoot, '002-example.cjs'),
      `module.exports = {
        applyPatch() { return []; },
        verifyPatch() { throw new Error('patch was not applied'); },
      };\n`,
    );
    writeFixtureBuildInfo(repoRoot, runtimeRoot);

    expect(() => patchOpenClawRuntime(runtimeRoot, { repoRoot, freshBundlePass: true })).toThrow(
      'patch was not applied',
    );
    expect(fs.existsSync(path.join(runtimeRoot, PATCH_MANIFEST_FILENAME))).toBe(false);
    expect(fs.readFileSync(bundlePath)).toEqual(originalBundle);
  });

  test('defers verification until the gateway bundle has been generated', () => {
    const { patchRoot, repoRoot, runtimeRoot } = createFixture();
    fs.rmSync(path.join(runtimeRoot, 'gateway-bundle.mjs'));
    fs.writeFileSync(
      path.join(patchRoot, '001-example.cjs'),
      `module.exports = {
        applyPatch() { return []; },
        verifyPatch() { throw new Error('must be deferred'); },
      };\n`,
    );
    fs.writeFileSync(
      path.join(patchRoot, '002-example.cjs'),
      `module.exports = {
        applyPatch() { return []; },
        verifyPatch() { throw new Error('must be deferred'); },
      };\n`,
    );

    expect(() =>
      patchOpenClawRuntime(runtimeRoot, { repoRoot, pristineInstallPass: true }),
    ).not.toThrow();
    expect(fs.existsSync(path.join(runtimeRoot, PATCH_MANIFEST_FILENAME))).toBe(false);
  });

  test('verifies every patch against the final bundle after all patches run', () => {
    const { patchRoot, repoRoot, runtimeRoot } = createFixture();
    fs.writeFileSync(
      path.join(patchRoot, '001-example.cjs'),
      `const fs = require('fs'); const path = require('path');
      module.exports = {
        applyPatch(root) { fs.appendFileSync(path.join(root, 'gateway-bundle.mjs'), 'first-marker\\n'); },
        verifyPatch(root) {
          if (!fs.readFileSync(path.join(root, 'gateway-bundle.mjs'), 'utf8').includes('first-marker')) {
            throw new Error('first patch was overwritten');
          }
        },
      };\n`,
    );
    fs.writeFileSync(
      path.join(patchRoot, '002-example.cjs'),
      `const fs = require('fs'); const path = require('path');
      module.exports = {
        applyPatch(root) {
          const file = path.join(root, 'gateway-bundle.mjs');
          fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('first-marker', 'second-marker'));
        },
        verifyPatch(root) {
          if (!fs.readFileSync(path.join(root, 'gateway-bundle.mjs'), 'utf8').includes('second-marker')) {
            throw new Error('second patch missing');
          }
        },
      };\n`,
    );
    writeFixtureBuildInfo(repoRoot, runtimeRoot);

    expect(() => patchOpenClawRuntime(runtimeRoot, { repoRoot, freshBundlePass: true })).toThrow(
      'first patch was overwritten',
    );
    expect(fs.existsSync(path.join(runtimeRoot, PATCH_MANIFEST_FILENAME))).toBe(false);
  });

  test('verifies the exact patch set and packaged gateway bundle bytes', () => {
    const { repoRoot, runtimeRoot } = createFixture();

    const { manifestPath } = writeOpenClawPatchManifest(runtimeRoot, { repoRoot });
    const verified = verifyOpenClawPatchManifest(runtimeRoot, { repoRoot });

    expect(manifestPath).toBe(path.join(runtimeRoot, PATCH_MANIFEST_FILENAME));
    expect(verified.patches.map(patch => patch.file)).toEqual([
      'scripts/patches/v2026.6.11/001-example.cjs',
      'scripts/patches/v2026.6.11/002-example.cjs',
    ]);
  });

  test('rejects a gateway bundle changed after patches were applied', () => {
    const { repoRoot, runtimeRoot } = createFixture();
    writeOpenClawPatchManifest(runtimeRoot, { repoRoot });

    fs.appendFileSync(path.join(runtimeRoot, 'gateway-bundle.mjs'), 'const stale = true;\n');

    expect(() => verifyOpenClawPatchManifest(runtimeRoot, { repoRoot })).toThrow(
      /gateway-bundle\.mjs does not match/,
    );
  });

  test('rejects patch scripts changed after the runtime was built', () => {
    const { patchRoot, repoRoot, runtimeRoot } = createFixture();
    writeOpenClawPatchManifest(runtimeRoot, { repoRoot });

    fs.appendFileSync(path.join(patchRoot, '002-example.cjs'), '// changed\n');

    expect(() => verifyOpenClawPatchManifest(runtimeRoot, { repoRoot })).toThrow(
      /source proof is missing, incomplete, or stale/,
    );
  });

  test('rejects a build recipe changed after the runtime was built', () => {
    const { repoRoot, runtimeRoot } = createFixture();
    writeOpenClawPatchManifest(runtimeRoot, { repoRoot });

    fs.appendFileSync(
      path.join(repoRoot, 'scripts', 'bundle-openclaw-gateway.cjs'),
      '// changed\n',
    );

    expect(() => verifyOpenClawPatchManifest(runtimeRoot, { repoRoot })).toThrow(
      /source proof is missing, incomplete, or stale/,
    );
  });

  test('rejects a patch helper changed after the runtime was built', () => {
    const { patchRoot, repoRoot, runtimeRoot } = createFixture();
    const helperPath = path.join(patchRoot, '_patch-utils.js');
    fs.writeFileSync(helperPath, 'module.exports = {};\n');
    writeFixtureBuildInfo(repoRoot, runtimeRoot);
    writeOpenClawPatchManifest(runtimeRoot, { repoRoot });

    fs.appendFileSync(helperPath, '// changed\n');

    expect(() => verifyOpenClawPatchManifest(runtimeRoot, { repoRoot })).toThrow(
      /source proof is missing, incomplete, or stale/,
    );
  });

  test('refuses to relabel a stale runtime with the current patch set', () => {
    const { patchRoot, repoRoot, runtimeRoot } = createFixture();
    patchOpenClawRuntime(runtimeRoot, { repoRoot, freshBundlePass: true });
    fs.appendFileSync(path.join(patchRoot, '002-example.cjs'), '// changed\n');

    expect(() => patchOpenClawRuntime(runtimeRoot, { repoRoot })).toThrow(
      /Refusing to patch an unknown or stale OpenClaw runtime/,
    );
  });

  test('refuses to patch a bundle whose existing proof no longer matches its bytes', () => {
    const { repoRoot, runtimeRoot } = createFixture();
    patchOpenClawRuntime(runtimeRoot, { repoRoot, freshBundlePass: true });
    fs.appendFileSync(path.join(runtimeRoot, 'gateway-bundle.mjs'), 'tampered\n');

    expect(() => patchOpenClawRuntime(runtimeRoot, { repoRoot })).toThrow(
      /Refusing to patch an unproven OpenClaw bundle/,
    );
  });

  test('requires build-info source identity to match the audited source lock', () => {
    const { repoRoot, runtimeRoot } = createFixture();
    writeFixtureBuildInfo(repoRoot, runtimeRoot, {
      npmIntegrity: `sha512-${Buffer.alloc(64, 8).toString('base64')}`,
    });

    expect(() => writeOpenClawPatchManifest(runtimeRoot, { repoRoot })).toThrow(
      /source proof is missing, incomplete, or stale/,
    );
  });

  test('rejects the wrong packaging target even when the manifest is self-consistent', () => {
    const { repoRoot, runtimeRoot } = createFixture();
    writeOpenClawPatchManifest(runtimeRoot, { repoRoot });

    expect(() =>
      verifyOpenClawPatchManifest(runtimeRoot, { repoRoot, expectedTarget: 'linux-x64' }),
    ).toThrow(/expected packaging target linux-x64/);
  });

  test('rejects immutable runtime artifacts changed after installation', () => {
    const { repoRoot, runtimeRoot } = createFixture();
    writeOpenClawPatchManifest(runtimeRoot, { repoRoot });
    fs.appendFileSync(path.join(runtimeRoot, 'gateway.asar'), 'tampered\n');

    expect(() => verifyOpenClawPatchManifest(runtimeRoot, { repoRoot })).toThrow(
      /source proof is missing, incomplete, or stale/,
    );
  });

  test('rejects a production dependency lock changed after installation', () => {
    const { repoRoot, runtimeRoot } = createFixture();
    writeOpenClawPatchManifest(runtimeRoot, { repoRoot });
    fs.appendFileSync(path.join(runtimeRoot, 'npm-shrinkwrap.json'), 'tampered\n');

    expect(() => verifyOpenClawPatchManifest(runtimeRoot, { repoRoot })).toThrow(
      /source proof is missing, incomplete, or stale/,
    );
  });

  test('binds the manifest to npm source identity and target', () => {
    const { repoRoot, runtimeRoot } = createFixture();
    writeFixtureBuildInfo(repoRoot, runtimeRoot);
    writeOpenClawPatchManifest(runtimeRoot, { repoRoot });

    writeFixtureBuildInfo(repoRoot, runtimeRoot, { target: 'linux-x64' });

    expect(() => verifyOpenClawPatchManifest(runtimeRoot, { repoRoot })).toThrow(/runtime target/);
  });

  test('rejects a runtime without proof that all patches completed', () => {
    const { repoRoot, runtimeRoot } = createFixture();

    expect(() => verifyOpenClawPatchManifest(runtimeRoot, { repoRoot })).toThrow(
      /patch manifest is missing/,
    );
  });

  test('verifies the patch proof copied into the packaged Windows runtime archive', async () => {
    const repositoryRoot = path.resolve(__dirname, '../../..');
    const sourceLock = readOpenClawSourceLock(repositoryRoot, 'v2026.7.1-2');
    const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-packaged-patch-test-'));
    temporaryRoots.push(appOutDir);
    const archiveRoot = path.join(appOutDir, 'archive-source');
    const runtimeRoot = path.join(archiveRoot, 'cfmind');
    const resourcesRoot = path.join(appOutDir, 'resources');
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.mkdirSync(resourcesRoot, { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, 'gateway-bundle.mjs'), 'const packaged = true;\n');
    fs.writeFileSync(path.join(runtimeRoot, 'gateway.asar'), 'packaged asar\n');
    fs.writeFileSync(path.join(runtimeRoot, 'package.json'), '{}\n');
    fs.writeFileSync(path.join(runtimeRoot, 'npm-shrinkwrap.json'), '{}\n');
    fs.writeFileSync(
      path.join(runtimeRoot, 'runtime-build-info.json'),
      JSON.stringify({
        openclawVersion: 'v2026.7.1-2',
        installMethod: 'npm-package',
        target: 'win-x64',
        npmPackageVersion: sourceLock.version,
        npmIntegrity: sourceLock.integrity,
        npmTarballSha256: sourceLock.tarballSha256,
        patchSetSha256: buildOpenClawPatchSetFingerprint(repositoryRoot, 'v2026.7.1-2'),
        buildRecipeSha256: buildOpenClawBuildRecipeFingerprint(repositoryRoot, 'v2026.7.1-2'),
        gatewayAsarSha256: crypto
          .createHash('sha256')
          .update(fs.readFileSync(path.join(runtimeRoot, 'gateway.asar')))
          .digest('hex'),
        runtimePackageSha256: crypto
          .createHash('sha256')
          .update(fs.readFileSync(path.join(runtimeRoot, 'package.json')))
          .digest('hex'),
        runtimePackageLockPath: 'npm-shrinkwrap.json',
        runtimePackageLockSha256: crypto
          .createHash('sha256')
          .update(fs.readFileSync(path.join(runtimeRoot, 'npm-shrinkwrap.json')))
          .digest('hex'),
      }),
    );
    writeOpenClawPatchManifest(runtimeRoot, { repoRoot: repositoryRoot });
    fs.rmSync(path.join(runtimeRoot, 'gateway.asar'));

    const tar = require('tar') as {
      create: (
        options: { cwd: string; file: string; sync: boolean },
        paths: string[],
      ) => void;
    };
    const tarPath = path.join(resourcesRoot, 'win-resources.tar');
    const archivePath = path.join(resourcesRoot, 'win-resources.tar.zst');
    tar.create(
      {
        cwd: archiveRoot,
        file: tarPath,
        sync: true,
      },
      ['cfmind'],
    );
    await compressTarArchive(tarPath, archivePath);
    fs.rmSync(tarPath);
    fs.writeFileSync(
      path.join(resourcesRoot, 'win-resources-metadata.json'),
      '{"schemaVersion":1,"totalEntries":1}\n',
    );

    await expect(
      verifyPackagedOpenClawRuntime({
        appOutDir,
        electronPlatformName: 'win32',
      }),
    ).resolves.toBeUndefined();
  });
});
