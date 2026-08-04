import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

const { PATCH_MANIFEST_FILENAME, verifyOpenClawPatchManifest, writeOpenClawPatchManifest } =
  require('../scripts/verify-openclaw-runtime-patches.cjs') as {
    PATCH_MANIFEST_FILENAME: string;
    verifyOpenClawPatchManifest: (
      runtimeRoot: string,
      options: { repoRoot: string },
    ) => { patches: Array<{ file: string; sha256: string }> };
    writeOpenClawPatchManifest: (
      runtimeRoot: string,
      options: { repoRoot: string },
    ) => { manifestPath: string };
  };
const { verifyPackagedOpenClawRuntime } = require('../scripts/electron-builder-hooks.cjs') as {
  verifyPackagedOpenClawRuntime: (context: {
    appOutDir: string;
    electronPlatformName: string;
  }) => void;
};
const {
  ensureOpenClawRuntimePatches,
  patchOpenClawRuntime,
} = require('../scripts/patch-openclaw-runtime.cjs') as {
  ensureOpenClawRuntimePatches: (
    runtimeRoot: string,
    options: { repoRoot: string },
  ) => { cached: boolean };
  patchOpenClawRuntime: (
    runtimeRoot: string,
    options: { repoRoot: string },
  ) => Array<{ file: string }>;
};

const temporaryRoots: string[] = [];

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
  fs.writeFileSync(path.join(runtimeRoot, 'gateway-bundle.mjs'), 'const patched = true;\n');
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
  return { patchRoot, repoRoot, runtimeRoot };
}

afterEach(() => {
  for (const temporaryRoot of temporaryRoots.splice(0)) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

describe('OpenClaw runtime patch manifest', () => {
  test('writes the proof only after the complete patch pass succeeds', () => {
    const { repoRoot, runtimeRoot } = createFixture();

    const results = patchOpenClawRuntime(runtimeRoot, { repoRoot });

    expect(results).toHaveLength(2);
    expect(fs.existsSync(path.join(runtimeRoot, PATCH_MANIFEST_FILENAME))).toBe(true);
    expect(() => verifyOpenClawPatchManifest(runtimeRoot, { repoRoot })).not.toThrow();
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
    patchOpenClawRuntime(runtimeRoot, { repoRoot });

    const result = ensureOpenClawRuntimePatches(runtimeRoot, { repoRoot });

    expect(result.cached).toBe(true);
    expect(fs.readFileSync(path.join(runtimeRoot, 'apply-count.txt'), 'utf8')).toBe('2');
  });

  test('does not write proof when any patch fails', () => {
    const { patchRoot, repoRoot, runtimeRoot } = createFixture();
    fs.writeFileSync(
      path.join(patchRoot, '002-example.cjs'),
      "module.exports = { applyPatch() { throw new Error('patch failed'); }, verifyPatch() {} };\n",
    );

    expect(() => patchOpenClawRuntime(runtimeRoot, { repoRoot })).toThrow('patch failed');
    expect(fs.existsSync(path.join(runtimeRoot, PATCH_MANIFEST_FILENAME))).toBe(false);
  });

  test('rejects a silent no-op patch without applied-state evidence', () => {
    const { patchRoot, repoRoot, runtimeRoot } = createFixture();
    fs.writeFileSync(
      path.join(patchRoot, '002-example.cjs'),
      `module.exports = {
        applyPatch() { return []; },
        verifyPatch() { throw new Error('patch was not applied'); },
      };\n`,
    );

    expect(() => patchOpenClawRuntime(runtimeRoot, { repoRoot })).toThrow(
      'patch was not applied',
    );
    expect(fs.existsSync(path.join(runtimeRoot, PATCH_MANIFEST_FILENAME))).toBe(false);
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

    expect(() => patchOpenClawRuntime(runtimeRoot, { repoRoot })).not.toThrow();
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

    expect(() => patchOpenClawRuntime(runtimeRoot, { repoRoot })).toThrow(
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
      /patch file list or checksums do not match/,
    );
  });

  test('rejects a runtime without proof that all patches completed', () => {
    const { repoRoot, runtimeRoot } = createFixture();

    expect(() => verifyOpenClawPatchManifest(runtimeRoot, { repoRoot })).toThrow(
      /patch manifest is missing/,
    );
  });

  test('verifies the patch proof copied into the packaged Windows runtime archive', () => {
    const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-packaged-patch-test-'));
    temporaryRoots.push(appOutDir);
    const archiveRoot = path.join(appOutDir, 'archive-source');
    const runtimeRoot = path.join(archiveRoot, 'cfmind');
    const resourcesRoot = path.join(appOutDir, 'resources');
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.mkdirSync(resourcesRoot, { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, 'gateway-bundle.mjs'), 'const packaged = true;\n');
    writeOpenClawPatchManifest(runtimeRoot, { repoRoot: path.resolve(__dirname, '..') });

    const tar = require('tar') as {
      create: (options: { cwd: string; file: string; sync: boolean }, paths: string[]) => void;
    };
    tar.create(
      {
        cwd: archiveRoot,
        file: path.join(resourcesRoot, 'win-resources.tar'),
        sync: true,
      },
      ['cfmind'],
    );

    expect(() =>
      verifyPackagedOpenClawRuntime({
        appOutDir,
        electronPlatformName: 'win32',
      }),
    ).not.toThrow();
  });
});
