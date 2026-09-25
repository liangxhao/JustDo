import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

const { pruneRuntimeExtensions, shouldPreserveExtensionLegalFiles } =
  require('../../../scripts/openclaw/prune-openclaw-runtime.cjs') as {
    pruneRuntimeExtensions: (
      runtimeRoot: string,
      stats: { extensionDirsRemoved: number; bytesFreed: number },
      options: { repoRoot: string; label: string },
    ) => { kept: string[]; protected: string[]; removed: string[] };
    shouldPreserveExtensionLegalFiles: (extensionId: string) => boolean;
  };

const temporaryRoots: string[] = [];

function createFixture(remove: string[]) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-runtime-prune-test-'));
  temporaryRoots.push(repoRoot);
  const runtimeRoot = path.join(repoRoot, 'runtime');
  const extensionsRoot = path.join(runtimeRoot, 'dist', 'extensions');
  fs.mkdirSync(path.join(repoRoot, 'resources'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'openclaw-extensions', 'custom'), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({ openclaw: { version: 'v2026.9.6' } }),
  );
  for (const extensionId of ['core', 'optional', 'custom']) {
    fs.mkdirSync(path.join(extensionsRoot, extensionId), { recursive: true });
  }
  fs.writeFileSync(
    path.join(repoRoot, 'resources', 'openclaw-extension-prune.json'),
    JSON.stringify({
      version: 1,
      openclawVersion: '2026.9.6',
      keep: ['core'],
      remove: [{ category: 'optional', reason: 'fixture', extensions: remove }],
    }),
  );
  return { extensionsRoot, repoRoot, runtimeRoot };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const temporaryRoot of temporaryRoots.splice(0)) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

describe('OpenClaw runtime extension pruning', () => {
  test('preserves Koffi runtime code and native binaries needed by Windows SQLite', () => {
    const { runtimeRoot } = createFixture([]);
    const loader = path.join(runtimeRoot, 'node_modules/koffi/index.js');
    const binary = path.join(
      runtimeRoot,
      'node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node',
    );
    fs.mkdirSync(path.dirname(loader), { recursive: true });
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(loader, 'module.exports = { load() {} };');
    fs.writeFileSync(binary, 'native fixture');
    execFileSync(process.execPath, [
      path.resolve('scripts/openclaw/prune-openclaw-runtime.cjs'),
      runtimeRoot,
    ]);
    expect(fs.readFileSync(loader, 'utf8')).toBe('module.exports = { load() {} };');
    expect(fs.readFileSync(binary, 'utf8')).toBe('native fixture');
  });

  test('preserves legal metadata for extensions redistributed with native executables', () => {
    expect(shouldPreserveExtensionLegalFiles('acpx')).toBe(true);
    expect(shouldPreserveExtensionLegalFiles('mxc')).toBe(true);
    expect(shouldPreserveExtensionLegalFiles('memory-core')).toBe(false);
  });

  test('keeps reviewed and local extensions while removing reviewed optional extensions', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { extensionsRoot, repoRoot, runtimeRoot } = createFixture(['optional']);
    const stats = { extensionDirsRemoved: 0, bytesFreed: 0 };

    const result = pruneRuntimeExtensions(runtimeRoot, stats, { repoRoot, label: 'test' });

    expect(result).toEqual({ kept: ['core'], protected: ['custom'], removed: ['optional'] });
    expect(fs.existsSync(path.join(extensionsRoot, 'core'))).toBe(true);
    expect(fs.existsSync(path.join(extensionsRoot, 'custom'))).toBe(true);
    expect(fs.existsSync(path.join(extensionsRoot, 'optional'))).toBe(false);
    expect(stats.extensionDirsRemoved).toBe(1);
  });

  test('fails before deleting anything when an upstream extension is unreviewed', () => {
    const { extensionsRoot, repoRoot, runtimeRoot } = createFixture([]);
    const stats = { extensionDirsRemoved: 0, bytesFreed: 0 };

    expect(() => pruneRuntimeExtensions(runtimeRoot, stats, { repoRoot, label: 'test' })).toThrow(
      'Unreviewed OpenClaw extension dirs found: optional',
    );

    expect(fs.existsSync(path.join(extensionsRoot, 'optional'))).toBe(true);
    expect(stats.extensionDirsRemoved).toBe(0);
  });

  test('rejects a prune allowlist audited for another OpenClaw version', () => {
    const { extensionsRoot, repoRoot, runtimeRoot } = createFixture(['optional']);
    const policyPath = path.join(repoRoot, 'resources', 'openclaw-extension-prune.json');
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as Record<string, unknown>;
    policy.openclawVersion = '2026.8.2';
    fs.writeFileSync(policyPath, JSON.stringify(policy));
    const stats = { extensionDirsRemoved: 0, bytesFreed: 0 };

    expect(() => pruneRuntimeExtensions(runtimeRoot, stats, { repoRoot, label: 'test' })).toThrow(
      'Extension prune policy targets OpenClaw 2026.8.2, expected 2026.9.6',
    );
    expect(fs.existsSync(path.join(extensionsRoot, 'optional'))).toBe(true);
    expect(stats.extensionDirsRemoved).toBe(0);
  });
});
