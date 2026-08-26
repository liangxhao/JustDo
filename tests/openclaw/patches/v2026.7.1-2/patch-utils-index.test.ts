import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const patchUtils = require('../../../../scripts/patches/v2026.7.1-2/_patch-utils.js') as {
  beginRuntimePatchPhase: (runtimeDir: string, snapshot: Map<string, Buffer>) => void;
  endRuntimePatchPhase: (runtimeDir: string) => void;
  findFilesContaining: (runtimeDir: string, needles: string | string[]) => string[];
  runtimeJavaScriptFiles: (runtimeDir: string, options?: { includeBundle?: boolean }) => string[];
  stableFunctionSource: (value: (...args: unknown[]) => unknown) => string;
  writeIfChanged: (filePath: string, original: string, updated: string) => boolean;
};

const temporaryDirectories: string[] = [];

function createRuntimeFixture() {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-patch-index-'));
  temporaryDirectories.push(runtimeDir);
  const distDir = path.join(runtimeDir, 'dist');
  fs.mkdirSync(distDir);
  const sourcePath = path.join(distDir, 'source.js');
  const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
  fs.writeFileSync(sourcePath, 'const source = "disk";\n');
  fs.writeFileSync(bundlePath, 'const bundle = "disk";\n');
  return { runtimeDir, sourcePath, bundlePath };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    try {
      patchUtils.endRuntimePatchPhase(directory);
    } catch {
      // A mismatched-phase assertion deliberately leaves another fixture active.
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('OpenClaw patch phase index', () => {
  it('serializes function source with stable LF line endings', () => {
    const crlfFunction = eval('(function sample() {\r\n  return true;\r\n})') as () => boolean;

    expect(patchUtils.stableFunctionSource(crlfFunction)).toBe(
      'function sample() {\n  return true;\n}',
    );
  });

  it('reuses the transaction snapshot and tracks atomic patch writes', () => {
    const { runtimeDir, sourcePath, bundlePath } = createRuntimeFixture();
    const snapshot = new Map([
      [sourcePath, Buffer.from('const source = "snapshot";\n')],
      [bundlePath, Buffer.from('const bundle = "snapshot";\n')],
    ]);

    patchUtils.beginRuntimePatchPhase(runtimeDir, snapshot);

    expect(patchUtils.findFilesContaining(runtimeDir, 'snapshot')).toEqual([
      sourcePath,
      bundlePath,
    ]);
    expect(patchUtils.findFilesContaining(runtimeDir, 'disk')).toEqual([]);
    expect(patchUtils.writeIfChanged(sourcePath, 'snapshot', 'const source = "patched";\n')).toBe(
      true,
    );
    expect(patchUtils.findFilesContaining(runtimeDir, 'snapshot')).toEqual([bundlePath]);
    expect(patchUtils.findFilesContaining(runtimeDir, 'patched')).toEqual([sourcePath]);

    patchUtils.endRuntimePatchPhase(runtimeDir);
    expect(patchUtils.findFilesContaining(runtimeDir, 'disk')).toEqual([bundlePath]);
  });

  it('preserves includeBundle filtering without another directory walk', () => {
    const { runtimeDir, sourcePath, bundlePath } = createRuntimeFixture();
    const snapshot = new Map([
      [sourcePath, fs.readFileSync(sourcePath)],
      [bundlePath, fs.readFileSync(bundlePath)],
    ]);

    patchUtils.beginRuntimePatchPhase(runtimeDir, snapshot);

    expect(patchUtils.runtimeJavaScriptFiles(runtimeDir)).toEqual([sourcePath, bundlePath]);
    expect(patchUtils.runtimeJavaScriptFiles(runtimeDir, { includeBundle: false })).toEqual([
      sourcePath,
    ]);
  });

  it('rejects overlapping patch transactions', () => {
    const first = createRuntimeFixture();
    const second = createRuntimeFixture();

    patchUtils.beginRuntimePatchPhase(first.runtimeDir, new Map());

    expect(() => patchUtils.beginRuntimePatchPhase(second.runtimeDir, new Map())).toThrow(
      /already active/,
    );
    expect(() => patchUtils.endRuntimePatchPhase(second.runtimeDir)).toThrow(
      /Cannot end runtime patch phase/,
    );
    patchUtils.endRuntimePatchPhase(first.runtimeDir);
  });

  it('retries a transient Windows-style atomic rename failure', () => {
    const { sourcePath } = createRuntimeFixture();
    const originalRenameSync = fs.renameSync.bind(fs);
    let attempts = 0;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error('temporarily locked'), { code: 'EPERM' });
      }
      originalRenameSync(source, destination);
    });

    try {
      expect(
        patchUtils.writeIfChanged(
          sourcePath,
          'const source = "disk";\n',
          'const source = "renamed";\n',
        ),
      ).toBe(true);
      expect(fs.readFileSync(sourcePath, 'utf8')).toBe('const source = "renamed";\n');
      expect(attempts).toBe(2);
    } finally {
      renameSpy.mockRestore();
    }
  });
});
