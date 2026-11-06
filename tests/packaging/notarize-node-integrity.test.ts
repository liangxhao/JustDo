import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { expect, test, vi } from 'vitest';

function hook(verify: () => void) {
  const notarize = vi.fn();
  const verifyPackagedNodeRuntime = vi.fn(verify);
  const exports: { default?: (context: unknown) => Promise<void> } = {};
  vm.runInNewContext(fs.readFileSync('scripts/packaging/notarize.js', 'utf8'), {
    exports,
    process: { env: {} },
    console: { warn: vi.fn(), log: vi.fn(), error: vi.fn() },
    require: (specifier: string) => {
      if (specifier === '@electron/notarize') return { notarize };
      if (specifier === 'path') return path;
      if (specifier === 'dotenv') return { config: vi.fn() };
      if (specifier === './electron-builder-hooks.cjs') return { verifyPackagedNodeRuntime };
      throw new Error(`Unexpected module: ${specifier}`);
    },
  });
  return { run: exports.default!, verifyPackagedNodeRuntime, notarize };
}

test('rejects Node bytes changed by macOS signing even without notarization credentials', async () => {
  const value = hook(() => { throw new Error('Node distribution changed'); });
  await expect(value.run({ electronPlatformName: 'darwin' })).rejects.toThrow('Node distribution changed');
  expect(value.verifyPackagedNodeRuntime).toHaveBeenCalledOnce();
  expect(value.notarize).not.toHaveBeenCalled();
});

test('checks intact macOS Node before skipping unavailable notarization', async () => {
  const value = hook(() => undefined);
  await value.run({ electronPlatformName: 'darwin' });
  expect(value.verifyPackagedNodeRuntime).toHaveBeenCalledOnce();
  expect(value.notarize).not.toHaveBeenCalled();
});

test('leaves Windows packaging on its existing archive admission path', async () => {
  const value = hook(() => { throw new Error('Unexpected macOS admission'); });
  await value.run({ electronPlatformName: 'win32' });
  expect(value.verifyPackagedNodeRuntime).not.toHaveBeenCalled();
});
