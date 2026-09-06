import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const {
  CONTRACT,
  patchFacadeRuntime,
  verifyFacadeRuntime,
} = require('../../../scripts/openclaw-facade-runtime-patch.cjs') as {
  CONTRACT: string;
  patchFacadeRuntime: (runtimeDir: string) => string[];
  verifyFacadeRuntime: (runtimeDir: string) => string;
};

const runtimeRoot = path.resolve('vendor/openclaw-runtime/current');
const liveRuntimeHasContract = (() => {
  try {
    const info = JSON.parse(
      fs.readFileSync(path.join(runtimeRoot, 'runtime-build-info.json'), 'utf8'),
    ) as { openclawVersion?: string };
    return (
      info.openclawVersion === 'v2026.9.2' &&
      fs
        .readdirSync(path.join(runtimeRoot, 'dist'))
        .some(
          name =>
            /^facade-runtime-.*\.js$/u.test(name) &&
            fs.readFileSync(path.join(runtimeRoot, 'dist', name), 'utf8').includes(CONTRACT),
        )
    );
  } catch {
    return false;
  }
})();

function pristineFacadeFixture(): string {
  return [
    'import { createRequire } from "node:module";',
    'import { a as getCachedPluginSourceModuleLoader } from "./plugin-module-loader-cache.js";',
    'import { b as getPluginCacheRoot, c as getPluginCacheSource } from "./plugin-cache.js";',
    'const nodeRequire = createRequire(import.meta.url);',
    'const FACADE_ACTIVATION_CHECK_RUNTIME_CANDIDATES = ["./facade-activation-check.runtime.js"];',
    'function getFacadeActivationCheckRuntimeModule() {',
    '  return getPluginCacheSource();',
    '}',
    'function setFacadeActivationCheckRuntimeModule(value) {',
    '  void value;',
    '}',
    'function getFacadeActivationCheckRuntimeSourceLoader() {',
    '  return getCachedPluginSourceModuleLoader();',
    '}',
    'function loadFacadeActivationCheckRuntimeFromCandidates() {',
    '  return nodeRequire(FACADE_ACTIVATION_CHECK_RUNTIME_CANDIDATES[0]);',
    '}',
    'function loadFacadeActivationCheckRuntime() {',
    '  return loadFacadeActivationCheckRuntimeFromCandidates();',
    '}',
    'async function loadFacadeActivationCheckRuntimeAsync() {',
    '  return loadFacadeActivationCheckRuntimeFromCandidates();',
    '}',
    'function setFacadeActivationCheckRuntimeForTest(module) {',
    '  setFacadeActivationCheckRuntimeModule(module);',
    '}',
    'function resetFacadeRuntimeStateForTest() {',
    '  setFacadeActivationCheckRuntimeModule(undefined);',
    '  resetFacadeLoaderStateForTest();',
    '}',
  ].join('\n');
}

describe('OpenClaw facade runtime packaging transform', () => {
  test('rewrites the v2026.9.2 loader shape, verifies it, and rejects historical markers', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-facade-runtime-'));
    const distRoot = path.join(fixtureRoot, 'dist');
    const facadePath = path.join(distRoot, 'facade-runtime-fixture.js');
    fs.mkdirSync(distRoot, { recursive: true });
    try {
      fs.writeFileSync(facadePath, pristineFacadeFixture());
      expect(patchFacadeRuntime(fixtureRoot)).toEqual([
        path.join('dist', 'facade-runtime-fixture.js'),
      ]);
      expect(() => verifyFacadeRuntime(fixtureRoot)).not.toThrow();
      expect(patchFacadeRuntime(fixtureRoot)).toEqual([]);

      fs.writeFileSync(
        facadePath,
        fs.readFileSync(facadePath, 'utf8').replace(CONTRACT, CONTRACT.replace('9_2', '8_2')),
      );
      expect(() => verifyFacadeRuntime(fixtureRoot)).toThrow('historical or partial');
      expect(() => patchFacadeRuntime(fixtureRoot)).toThrow('historical or partial');
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('verifies the current built runtime when the CI contract is required', () => {
    if (process.env.OPENCLAW_RUNTIME_CONTRACT_REQUIRED !== '1') return;
    expect(liveRuntimeHasContract).toBe(true);
    expect(() => verifyFacadeRuntime(runtimeRoot)).not.toThrow();
  });

  test.skipIf(!liveRuntimeHasContract)('matches the current built runtime shape', () => {
    expect(() => verifyFacadeRuntime(runtimeRoot)).not.toThrow();
  });
});
