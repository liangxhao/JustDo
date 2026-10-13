import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { expect, test, vi } from 'vitest';

const { ensureOpenClawGatewayBundleLauncher } =
  require('../../../src/main/openclaw/runtime/openclawGatewayBundleLauncher.cjs');
const { installWindowsRecursiveRemove } =
  require('../../../src/main/openclaw/runtime/windowsRecursiveRemove.cjs');

test.each(['EBUSY', 'EPERM'])('preserves bounded file retries for %s', code => {
  const failure = Object.assign(new Error('temporarily locked'), { code });
  const original = vi.fn().mockImplementation(() => { throw failure; });
  const patchedFs = { ...fs, rmSync: original };
  const wait = vi.fn();
  vm.runInNewContext(`(${installWindowsRecursiveRemove.toString()})();`, {
    process: { platform: 'win32', versions: { electron: '42.7.0' } },
    URL,
    Buffer,
    Atomics: { wait },
    require: (name: string) => name === 'node:fs' ? patchedFs
      : name === 'node:module' ? { syncBuiltinESMExports: vi.fn() }
        : require(name),
  });
  expect(() => patchedFs.rmSync('locked-file', { recursive: true, maxRetries: 0 }))
    .toThrow(failure);
  expect(original).toHaveBeenCalledTimes(1);
  expect(wait).not.toHaveBeenCalled();

  original.mockClear();
  expect(() => patchedFs.rmSync('locked-file', { recursive: true, maxRetries: 2, retryDelay: 7 }))
    .toThrow(failure);
  expect(original).toHaveBeenCalledTimes(3);
  expect(wait.mock.calls.map(call => call[3])).toEqual([7, 14]);

  original.mockReset().mockImplementationOnce(() => { throw failure; }).mockReturnValue(undefined);
  expect(patchedFs.rmSync('locked-file', { recursive: true, maxRetries: 2 })).toBeUndefined();
  expect(original).toHaveBeenCalledTimes(2);
});

test.skipIf(process.platform !== 'win32')('Electron plugin capture cleanup preserves junction targets across repeated retirements', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-capture-removal-'));
  try {
    const host = path.join(root, 'host');
    fs.mkdirSync(host);
    fs.writeFileSync(path.join(host, 'index.js'), 'host entry');
    fs.writeFileSync(path.join(root, 'gateway-bundle.mjs'), [
      "import fs, { rmSync } from 'node:fs';",
      "import path from 'node:path';",
      "import assert from 'node:assert/strict';",
      `const root = ${JSON.stringify(root)};`,
      "const host = path.join(root, 'host');",
      'for (const invalid of [{ force: "yes" }, { force: null }, { maxRetries: -1 }, { retryDelay: -1 }]) {',
      '  for (const populated of [false, true]) {',
      "    const directory = path.join(root, 'invalid-options');",
      '    fs.mkdirSync(directory);',
      "    if (populated) fs.writeFileSync(path.join(directory, 'owned.js'), 'preserve');",
      '    assert.throws(() => rmSync(directory, { recursive: true, ...invalid }),',
      '      { code: "force" in invalid ? "ERR_INVALID_ARG_TYPE" : "ERR_OUT_OF_RANGE" });',
      '    assert.equal(fs.existsSync(directory), true);',
      "    if (populated) assert.equal(fs.readFileSync(path.join(directory, 'owned.js'), 'utf8'), 'preserve');",
      '    rmSync(directory, { recursive: true });',
      '  }',
      '}',
      'for (let round = 0; round < 3; round++) {',
      "  const capture = path.join(root, 'capture');",
      "  fs.mkdirSync(path.join(capture, 'node_modules'), { recursive: true });",
      "  fs.symlinkSync(host, path.join(capture, 'node_modules/openclaw'), 'junction');",
      "  fs.writeFileSync(path.join(capture, 'owned.js'), 'capture');",
      '  rmSync(capture, { recursive: true, force: true, maxRetries: 2 });',
      '  assert.equal(fs.existsSync(capture), false);',
      "  assert.equal(fs.readFileSync(path.join(host, 'index.js'), 'utf8'), 'host entry');",
      '}',
      "const link = path.join(root, 'root-link');",
      "fs.symlinkSync(host, link, 'junction');",
      'rmSync(link, { recursive: true });',
      'assert.equal(fs.existsSync(link), false);',
      "assert.equal(fs.readFileSync(path.join(host, 'index.js'), 'utf8'), 'host entry');",
      'rmSync(link, { recursive: true, force: true });',
      "assert.throws(() => rmSync(link, { recursive: true }), { code: 'ENOENT' });",
      "console.log('capture cleanup passed');",
    ].join('\n'));
    const { launcherPath } = ensureOpenClawGatewayBundleLauncher(root);
    const output = execFileSync(require('electron'), [launcherPath], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_DISABLE_COMPILE_CACHE: '1' },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    });
    expect(output).toContain('capture cleanup passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
