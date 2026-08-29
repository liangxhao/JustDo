import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const patch =
  require('../../../../scripts/patches/v2026.7.1-2/048-memory-force-reembed-opt-in.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
    verifyPatch: (runtimeDir: string) => void;
    __testing: {
      CACHE_SEED: string;
      FUNCTION_SIGNATURE: string;
      MARKER: string;
      OPT_IN_ENV: string;
      PATCHED_CACHE_SEED: string;
      transformMemoryManager: (content: string, filePath: string) => string;
    };
  };

const runtimeRoot = path.resolve('vendor/openclaw-runtime/current');
const runtimeDist = path.join(runtimeRoot, 'dist');

function findMemoryManagerSource(): string {
  const candidate = fs.readdirSync(runtimeDist).find(fileName => {
    if (!fileName.endsWith('.js')) return false;
    const content = fs.readFileSync(path.join(runtimeDist, fileName), 'utf8');
    return (
      content.includes(patch.__testing.FUNCTION_SIGNATURE) &&
      (content.includes(patch.__testing.CACHE_SEED) || content.includes(patch.__testing.MARKER))
    );
  });
  if (!candidate) throw new Error('Memory manager source was not found');
  return path.join(runtimeDist, candidate);
}

const sourcePath = findMemoryManagerSource();

describe('memory force-reembed opt-in patch', () => {
  test('skips the copied embedding cache only for the exact host opt-in', async () => {
    const pristineMethod = `
async runInPlaceReindex(params) {
  const originalDb = {};
  await this.seedEmbeddingCache(originalDb);
}`;
    const transformed = patch.__testing.transformMemoryManager(pristineMethod, 'manager.js');
    const Manager = new Function(
      'process',
      `return class MemoryManager {
        constructor() { this.seedCount = 0; }
        async seedEmbeddingCache() { this.seedCount += 1; }
        ${transformed}
      };`,
    );

    const regularManager = new (Manager({ env: {} }))();
    await regularManager.runInPlaceReindex({ force: true });
    expect(regularManager.seedCount).toBe(1);

    const optedInManager = new (Manager({
      env: { [patch.__testing.OPT_IN_ENV]: '1' },
    }))();
    await optedInManager.runInPlaceReindex({ force: true });
    expect(optedInManager.seedCount).toBe(0);

    const nonExactManager = new (Manager({
      env: { [patch.__testing.OPT_IN_ENV]: 'true' },
    }))();
    await nonExactManager.runInPlaceReindex({ force: true });
    expect(nonExactManager.seedCount).toBe(1);
  });

  test('transforms the locked source idempotently and rejects partial state', () => {
    const original = fs.readFileSync(sourcePath, 'utf8');
    const transformed = patch.__testing.transformMemoryManager(original, sourcePath);

    expect(transformed).toContain(patch.__testing.PATCHED_CACHE_SEED);
    expect(patch.__testing.transformMemoryManager(transformed, sourcePath)).toBe(transformed);
    expect(() =>
      patch.__testing.transformMemoryManager(
        transformed.replace(patch.__testing.OPT_IN_ENV, 'PARTIAL_ENV'),
        sourcePath,
      ),
    ).toThrow('partial memory force-reembed opt-in patch');
    expect(() =>
      patch.__testing.transformMemoryManager(
        transformed.replace(
          patch.__testing.PATCHED_CACHE_SEED,
          `${patch.__testing.PATCHED_CACHE_SEED}\n  ${patch.__testing.CACHE_SEED}`,
        ),
        sourcePath,
      ),
    ).toThrow('partial memory force-reembed opt-in patch');
  });

  test('applies and verifies the real memory manager target', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-memory-reembed-patch-'));
    const fixtureDist = path.join(fixtureRoot, 'dist');
    fs.mkdirSync(fixtureDist, { recursive: true });
    fs.copyFileSync(sourcePath, path.join(fixtureDist, path.basename(sourcePath)));

    try {
      expect(patch.applyPatch(fixtureRoot)).toHaveLength(1);
      expect(() => patch.verifyPatch(fixtureRoot)).not.toThrow();
      expect(patch.applyPatch(fixtureRoot)).toEqual([]);

      const fixturePath = path.join(fixtureDist, path.basename(sourcePath));
      const patched = fs.readFileSync(fixturePath, 'utf8');
      fs.writeFileSync(
        fixturePath,
        patched.replace(
          patch.__testing.PATCHED_CACHE_SEED,
          `${patch.__testing.PATCHED_CACHE_SEED}\n\t\t\t${patch.__testing.CACHE_SEED}`,
        ),
      );
      expect(() => patch.verifyPatch(fixtureRoot)).toThrow(
        'memory force-reembed opt-in contract is incomplete',
      );
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('rejects ambiguous cache-seed targets before writing', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-memory-reembed-atomic-'));
    const fixtureDist = path.join(fixtureRoot, 'dist');
    const firstPath = path.join(fixtureDist, 'manager-a.js');
    const secondPath = path.join(fixtureDist, 'manager-b.js');
    const pristine = `${patch.__testing.FUNCTION_SIGNATURE}\n  ${patch.__testing.CACHE_SEED}\n}`;
    fs.mkdirSync(fixtureDist, { recursive: true });
    fs.writeFileSync(firstPath, pristine);
    fs.writeFileSync(secondPath, pristine);

    try {
      expect(() => patch.applyPatch(fixtureRoot)).toThrow('target count is 2, expected 1');
      expect(fs.readFileSync(firstPath, 'utf8')).toBe(pristine);
      expect(fs.readFileSync(secondPath, 'utf8')).toBe(pristine);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
