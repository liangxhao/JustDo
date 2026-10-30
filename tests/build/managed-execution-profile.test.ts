import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

const { emitManagedExecutionProfile } = createRequire(import.meta.url)('../../scripts/openclaw/managed-execution-profile.cjs');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('writes the verified target bundle profile and refuses failed verification', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'runtime-profile-'));
  roots.push(root);
  writeFileSync(path.join(root, 'runtime-patch-manifest.json'), '{}');
  const manifest = { openclawVersion: 'fixture',
    gatewayBundle: { path: 'gateway-bundle.mjs', size: 42, sha256: 'a'.repeat(64) },
    patches: [{ file: 'scripts/patches/fixture/019-plugin-owned-execution.cjs', sha256: 'b'.repeat(64) }] };
  const verify = vi.fn(() => ({ manifest }));
  const output = path.join(root, 'extension');
  expect(emitManagedExecutionProfile(root, output, verify)).toBe(true);
  expect(verify).toHaveBeenCalledWith(root, { requireBundle: true });
  expect(JSON.parse(readFileSync(path.join(output, 'execution/runtime-profile.json'), 'utf8')))
    .toMatchObject({ formatVersion: 1, gatewayBundle: manifest.gatewayBundle, executionPatch: manifest.patches[0] });
  expect(() => emitManagedExecutionProfile(root, output, () => { throw new Error('bundle mismatch'); }))
    .toThrow('bundle mismatch');
});
