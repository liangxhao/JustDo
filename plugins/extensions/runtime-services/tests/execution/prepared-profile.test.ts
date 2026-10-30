import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { readPreparedManagedExecutionDescriptor } from '../../execution/prepared-profile';
import { MANAGED_EXECUTION_DESCRIPTOR } from '../../sdk/execution';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    expect(path.dirname(root)).toBe(path.resolve(tmpdir()));
    expect(path.basename(root)).toMatch(/^prepared-execution-/u);
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'prepared-execution-'));
  roots.push(root);
  const sdkCore = path.join(root, 'dist', 'plugin-sdk', 'core.js');
  const pluginRoot = path.join(root, 'dist', 'extensions', 'runtime-services');
  const bundleFile = path.join(root, 'gateway-bundle.mjs');
  const manifestFile = path.join(root, 'runtime-patch-manifest.json');
  const profileFile = path.join(pluginRoot, 'execution', 'runtime-profile.json');
  mkdirSync(path.dirname(sdkCore), { recursive: true });
  mkdirSync(path.dirname(profileFile), { recursive: true });
  writeFileSync(sdkCore, 'export {};');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'openclaw', version: '2026.10.7' }));
  const bundle = 'export const fixture = "prepared execution baseline";';
  writeFileSync(bundleFile, bundle);
  const gatewayBundle = { path: 'gateway-bundle.mjs', size: Buffer.byteLength(bundle),
    sha256: createHash('sha256').update(bundle).digest('hex') };
  const executionPatch = { file: 'scripts/patches/v2026.10.7/019-plugin-owned-execution.cjs',
    sha256: 'd438a372dbff9838dd75e840f0ea3a648cccabec6042d1bc29bfec7cec70aad1' };
  const profile = { formatVersion: 1, capability: 'managed-execution-v1', openclawVersion: 'v2026.10.7',
    gatewayBundle, executionPatch };
  const manifest = { formatVersion: 2, openclawVersion: 'v2026.10.7', gatewayBundle,
    patches: [executionPatch] };
  writeFileSync(manifestFile, JSON.stringify(manifest));
  writeFileSync(profileFile, JSON.stringify(profile));
  const api = { rootDir: pluginRoot, runtime: { version: '2026.10.7',
    subagent: { run() {}, describeRun() {}, cancelRun() {} } } };
  const environment = { resolveSdkCore: () => sdkCore, argvEntry: bundleFile };
  return { root, api, environment, bundleFile, manifestFile, profileFile, profile, manifest,
    inspect: () => readPreparedManagedExecutionDescriptor(api, environment) };
}

test('accepts only the executing prepared bundle and the privately delivered matching profile', () => {
  const f = fixture();
  expect(f.inspect()).toEqual(MANAGED_EXECUTION_DESCRIPTOR);
  expect(f.inspect()).toEqual(MANAGED_EXECUTION_DESCRIPTOR);
});

test.each(['missing-profile', 'wrong-patch', 'wrong-version', 'wrong-entry', 'different-bytes', 'different-manifest'])(
  'does not advertise a plausible but unproven baseline: %s', reason => {
    const f = fixture();
    if (reason === 'missing-profile') rmSync(f.profileFile);
    if (reason === 'wrong-patch') {
      f.profile.executionPatch.sha256 = 'b'.repeat(64);
      writeFileSync(f.profileFile, JSON.stringify(f.profile));
      writeFileSync(f.manifestFile, JSON.stringify(f.manifest));
    }
    if (reason === 'wrong-version') {
      f.api.runtime.version = '2026.10.8';
    }
    if (reason === 'wrong-entry') f.environment.argvEntry = f.environment.resolveSdkCore();
    if (reason === 'different-bytes') {
      const original = readFileSync(f.bundleFile, 'utf8');
      writeFileSync(f.bundleFile, original.replace('baseline', 'tampered'));
    }
    if (reason === 'different-manifest') {
      writeFileSync(f.manifestFile, JSON.stringify({ ...f.manifest,
        gatewayBundle: { ...f.manifest.gatewayBundle, sha256: 'c'.repeat(64) } }));
    }
    expect(f.inspect()).toBeUndefined();
  },
);

test('a forged manifest cannot authorize another bundle after a successful inspection', () => {
  const f = fixture();
  expect(f.inspect()).toEqual(MANAGED_EXECUTION_DESCRIPTOR);
  const changed = 'export const fixture = "other code";';
  writeFileSync(f.bundleFile, changed);
  writeFileSync(f.manifestFile, JSON.stringify({ ...f.manifest, gatewayBundle: {
    path: 'gateway-bundle.mjs', size: Buffer.byteLength(changed),
    sha256: createHash('sha256').update(changed).digest('hex'),
  } }));
  expect(f.inspect()).toBeUndefined();
});
