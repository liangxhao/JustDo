import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { applyPatch } from '../../../../scripts/patches/v2026.6.11/007-allow-managed-pip-config-env.cjs';

const tempDirs: string[] = [];

function createRuntime(): string {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-openclaw-pip-config-'));
  tempDirs.push(runtimeDir);
  fs.mkdirSync(path.join(runtimeDir, 'dist'), { recursive: true });

  const fixture = [
    'const blockedEverywhereKeys = [',
    '  "NODE_OPTIONS",',
    '  "PIP_CONFIG_FILE",',
    '  "PYTHONPATH",',
    '];',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), fixture, 'utf8');
  fs.writeFileSync(path.join(runtimeDir, 'dist', 'host-env-security-test.js'), fixture, 'utf8');
  return runtimeDir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('managed pip config env patch', () => {
  it('removes PIP_CONFIG_FILE from OpenClaw host env block lists', () => {
    const runtimeDir = createRuntime();

    expect(applyPatch(runtimeDir)).toEqual([
      'gateway-bundle.mjs',
      path.join('dist', 'host-env-security-test.js'),
    ]);

    for (const relPath of ['gateway-bundle.mjs', path.join('dist', 'host-env-security-test.js')]) {
      const content = fs.readFileSync(path.join(runtimeDir, relPath), 'utf8');
      expect(content).not.toContain('"PIP_CONFIG_FILE"');
      expect(content).toContain('JUSTDO_ALLOW_MANAGED_PIP_CONFIG_ENV');
    }
  });

  it('is idempotent', () => {
    const runtimeDir = createRuntime();

    expect(applyPatch(runtimeDir)).toHaveLength(2);
    expect(applyPatch(runtimeDir)).toEqual([]);
  });
});
