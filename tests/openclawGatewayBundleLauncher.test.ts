import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

const {
  buildOpenClawGatewayBundleLauncherSource,
  ensureOpenClawGatewayBundleLauncher,
} = require('../src/main/openclaw/runtime/openclawGatewayBundleLauncher.cjs') as {
  buildOpenClawGatewayBundleLauncherSource: () => string;
  ensureOpenClawGatewayBundleLauncher: (runtimeRoot: string) => {
    changed: boolean;
    launcherPath: string;
    replaced: boolean;
  };
};

const temporaryRoots: string[] = [];

function createRuntime() {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-launcher-test-'));
  temporaryRoots.push(runtimeRoot);
  fs.writeFileSync(path.join(runtimeRoot, 'gateway-bundle.mjs'), 'export {};\n');
  return runtimeRoot;
}

afterEach(() => {
  for (const temporaryRoot of temporaryRoots.splice(0)) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

describe('OpenClaw gateway bundle launcher', () => {
  test('creates a syntactically valid launcher beside the bundle', () => {
    const runtimeRoot = createRuntime();

    const result = ensureOpenClawGatewayBundleLauncher(runtimeRoot);

    expect(result.changed).toBe(true);
    expect(result.replaced).toBe(false);
    expect(fs.readFileSync(result.launcherPath, 'utf8')).toBe(
      buildOpenClawGatewayBundleLauncherSource(),
    );
    expect(() => execFileSync(process.execPath, ['--check', result.launcherPath])).not.toThrow();
  });

  test('is idempotent and replaces a stale launcher', () => {
    const runtimeRoot = createRuntime();
    const launcherPath = path.join(runtimeRoot, 'gateway-launcher.cjs');
    fs.writeFileSync(launcherPath, 'stale');

    const replaced = ensureOpenClawGatewayBundleLauncher(runtimeRoot);
    const unchanged = ensureOpenClawGatewayBundleLauncher(runtimeRoot);

    expect(replaced).toMatchObject({ changed: true, replaced: true });
    expect(unchanged).toMatchObject({ changed: false, replaced: false });
  });

  test('refuses to generate a launcher without a gateway bundle', () => {
    const runtimeRoot = createRuntime();
    fs.rmSync(path.join(runtimeRoot, 'gateway-bundle.mjs'));

    expect(() => ensureOpenClawGatewayBundleLauncher(runtimeRoot)).toThrow(
      /gateway bundle not found/,
    );
  });
});
