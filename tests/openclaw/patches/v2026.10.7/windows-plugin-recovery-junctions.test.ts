import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { afterEach, expect, test, vi } from 'vitest';

const patch = require('../../../../scripts/patches/v2026.10.7/024-windows-plugin-recovery-junctions.cjs');
const { transformRecovery } = patch.__testing;
const native = fs.readFileSync(path.join(__dirname, 'plugin-recovery-source.fixture.js'), 'utf8');
const roots: string[] = [];
const makeRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-copy-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('recovery-copy-')) throw new Error('Unexpected fixture path');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.runIf(process.platform === 'win32')('keeps external junctions and native internal relocation', () => {
  const root = makeRoot(), boundary = path.join(root, 'source'), host = path.join(root, 'host'), destination = path.join(root, 'copy');
  fs.mkdirSync(path.join(boundary, 'lib'), { recursive: true });
  fs.mkdirSync(host);
  fs.writeFileSync(path.join(boundary, 'index.js'), 'captured entry');
  fs.symlinkSync(host, path.join(boundary, 'external'), 'junction');
  fs.symlinkSync(path.join(boundary, 'lib'), path.join(boundary, 'internal'), 'junction');
  const symlinkSync = vi.fn(fs.symlinkSync);
  const capture = vm.runInNewContext(`${transformRecovery(native)}; copyRecoverySource`, {
    fs: { ...fs, symlinkSync }, path, process,
    createPluginSourceCapture: () => ({ directory: destination, dispose() {} }),
    relativePluginPathInsideRootSync: (base: string, filename: string) => {
      const relative = path.relative(base, filename);
      return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? undefined : relative;
    },
    createPluginNativeReferenceValidator: () => () => {},
    createRecoverySourceResolver: () => () => {},
  });
  const result = capture({ rootDir: boundary, sourceRoot: boundary, capturedRoot: boundary, boundaryRoot: boundary,
    sources: new Map([[path.join(boundary, 'index.js'), path.join(boundary, 'index.js')]]) });
  expect(result.rootDir).toBe(destination);
  expect(fs.realpathSync(path.join(destination, 'external'))).toBe(fs.realpathSync(host));
  expect(fs.realpathSync(path.join(destination, 'internal'))).toBe(fs.realpathSync(path.join(destination, 'lib')));
  expect(symlinkSync.mock.calls.every(call => call[2] === 'junction')).toBe(true);
});

test('rejects changed native guards, historical contracts and partial wrappers', () => {
  const current = transformRecovery(native, 'source.mjs');
  expect(transformRecovery(current, 'source.mjs')).toBe(current);
  for (const broken of [native.replace('sourceIdentity: fact.capturedIdentity', 'sourceIdentity: "different"'),
    current.replaceAll('V2026_10_7', 'V2026_10_4'), current.replace('if (!accepted || process.platform', 'if (process.platform')]) {
    expect(() => transformRecovery(broken, 'source.mjs')).toThrow();
  }
});

test('validates the entire source/bundle set before writing and verifies the compiled form', () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, 'dist'));
  const files = [path.join(root, 'dist', 'plugin-generation-source-lookup-fixture.mjs'), path.join(root, 'gateway-bundle.mjs')];
  files.forEach((file, index) => fs.writeFileSync(file, index ? native : transformRecovery(native, file)));
  const before = files.map(file => fs.readFileSync(file, 'utf8'));
  expect(() => patch.applyPatch(root)).toThrow(/Mixed/);
  expect(files.map(file => fs.readFileSync(file, 'utf8'))).toEqual(before);
  files.forEach(file => fs.writeFileSync(file, native));
  expect(() => patch.verifyPatch(root)).toThrow();
  expect(patch.applyPatch(root)).toHaveLength(2);
  fs.writeFileSync(files[1], transformSync(fs.readFileSync(files[1], 'utf8'), { minifySyntax: true, legalComments: 'none' }).code);
  expect(patch.verifyPatch(root)).toEqual([]);
  expect(patch.applyPatch(root)).toEqual([]);
});
