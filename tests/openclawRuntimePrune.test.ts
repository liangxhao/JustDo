import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

const { pruneRuntimeExtensions } = require('../scripts/prune-openclaw-runtime.cjs') as {
  pruneRuntimeExtensions: (
    runtimeRoot: string,
    stats: { extensionDirsRemoved: number; bytesFreed: number },
    options: { repoRoot: string; label: string },
  ) => { kept: string[]; protected: string[]; removed: string[] };
};

const temporaryRoots: string[] = [];

function createFixture(remove: string[]) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-runtime-prune-test-'));
  temporaryRoots.push(repoRoot);
  const runtimeRoot = path.join(repoRoot, 'runtime');
  const extensionsRoot = path.join(runtimeRoot, 'dist', 'extensions');
  fs.mkdirSync(path.join(repoRoot, 'resources'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'openclaw-extensions', 'custom'), { recursive: true });
  for (const extensionId of ['core', 'optional', 'custom']) {
    fs.mkdirSync(path.join(extensionsRoot, extensionId), { recursive: true });
  }
  fs.writeFileSync(
    path.join(repoRoot, 'resources', 'openclaw-extension-prune.json'),
    JSON.stringify({
      version: 1,
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
});
