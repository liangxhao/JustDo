import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { prepareDevelopmentAppPlugins } from '../../scripts/plugins/prepare-development-app-plugins.mjs';

let root: string;
let runtime: string;
const id = 'fixture';
const hash = 'a'.repeat(64);
const native = 'export default {};\n';
const sha = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const put = (relative: string, bytes: unknown) => {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof bytes === 'string' ? bytes : JSON.stringify(bytes));
};
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-development-prepare-'));
  runtime = path.join(root, 'runtime');
  put(`plugins/extensions/${id}/package.json`, {
    justdo: { bundle: true },
    app: {},
    openclaw: { extensions: ['./index.ts'] },
  });
  put('build/app-plugins/catalog.json', [{ id, hash }]);
  const pkg = `build/app-plugins/packages/${id}/${hash}`;
  put(`${pkg}/package.json`, { type: 'module', openclaw: { extensions: ['./index.js'] } });
  put(`${pkg}/index.js`, native);
  put(`${pkg}/openclaw.plugin.json`, { id });
  put(`${pkg}/app/native.binding.json`, { entry: 'index.js', sha256: sha(native) });
  put(`${pkg}/app/app.artifact.json`, { hash });
  put(`${pkg}/app/browser.mjs`, 'export const register=()=>{};');
  put('runtime/dist/extensions/fixture/index.js', '// old native package');
});
afterEach(() => {
  expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
  expect(path.basename(root)).toMatch(/^app-development-prepare-/u);
  fs.rmSync(root, { recursive: true, force: true });
});

it('prepares the matching Native and UI package before Gateway startup', () => {
  const findRunningGateways = vi.fn(() => []);
  expect(
    prepareDevelopmentAppPlugins({ repoRoot: root, runtimeRoot: runtime, findRunningGateways }),
  ).toEqual({ prepared: [id] });
  expect(fs.readFileSync(path.join(runtime, 'dist/extensions/fixture/index.js'), 'utf8')).toBe(
    native,
  );
  expect(fs.existsSync(path.join(runtime, 'dist/extensions/fixture/app/browser.mjs'))).toBe(true);
  findRunningGateways.mockClear();
  expect(
    prepareDevelopmentAppPlugins({ repoRoot: root, runtimeRoot: runtime, findRunningGateways }),
  ).toEqual({ prepared: [] });
  expect(findRunningGateways).not.toHaveBeenCalled();
});

it.each(['running', 'unreadable'] as const)(
  'does not overwrite Native code when process ownership is %s',
  state => {
    const file = path.join(runtime, 'dist/extensions/fixture/index.js');
    const before = fs.readFileSync(file);
    const findRunningGateways = () => {
      if (state === 'unreadable') throw new Error('process inventory unavailable');
      return [12345];
    };
    expect(() =>
      prepareDevelopmentAppPlugins({ repoRoot: root, runtimeRoot: runtime, findRunningGateways }),
    ).toThrow();
    expect(fs.readFileSync(file)).toEqual(before);
  },
);

it('rejects a broken Native build before touching the runtime', () => {
  put(`build/app-plugins/packages/${id}/${hash}/index.js`, '// changed after binding');
  const findRunningGateways = vi.fn(() => []);
  expect(() =>
    prepareDevelopmentAppPlugins({ repoRoot: root, runtimeRoot: runtime, findRunningGateways }),
  ).toThrow('Invalid Native build');
  expect(findRunningGateways).not.toHaveBeenCalled();
  expect(fs.readFileSync(path.join(runtime, 'dist/extensions/fixture/index.js'), 'utf8')).toBe(
    '// old native package',
  );
});

it('supports a managed current runtime junction', () => {
  const alias = path.join(root, 'current');
  fs.symlinkSync(runtime, alias, process.platform === 'win32' ? 'junction' : 'dir');
  expect(
    prepareDevelopmentAppPlugins({
      repoRoot: root,
      runtimeRoot: alias,
      findRunningGateways: () => [],
    }),
  ).toEqual({ prepared: [id] });
  expect(fs.readFileSync(path.join(runtime, 'dist/extensions/fixture/index.js'), 'utf8')).toBe(
    native,
  );
});
