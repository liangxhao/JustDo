import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import { afterEach, expect, test, vi } from 'vitest';

const helperFile = path.resolve('scripts/test/sqlite-test-module.cjs');
const realRequire = createRequire(helperFile);
const temporaryRoots: string[] = [];
const links: string[] = [];
type Prepared = { modulePath: string; dispose(): void };
type Api = { prepareSqliteTestModule(root: string, env?: NodeJS.ProcessEnv): Prepared };

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-module-test-')));
  temporaryRoots.push(root);
  const source = path.join(root, 'node_modules/better-sqlite3');
  const files = {
    'package.json': JSON.stringify({ name: 'better-sqlite3', version: '1.0.0', main: 'lib/index.js' }),
    'binding.gyp': '{}', 'lib/index.js': 'module.exports = class Database {};',
    'src/fixture.cpp': '// fixture', 'deps/fixture.c': '// fixture',
    'build/Release/better_sqlite3.node': 'application Electron binary fixture',
  };
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(source, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  return { root, source, applicationBinary: path.join(source, 'build/Release/better_sqlite3.node') };
}

function loadHelper(statuses: { prebuilt?: number; compiled?: number; verification?: number } = {}) {
  const spawnSync = vi.fn((_executable: string, args: string[], options: { cwd?: string }) => {
    if (args[0] === '-e') return { status: statuses.verification ?? 0, stderr: 'fixture verification error' };
    const status = args[0].includes('prebuild-install') ? statuses.prebuilt ?? 0 : statuses.compiled ?? 0;
    if (status === 0) {
      const file = path.join(options.cwd!, 'build/Release/better_sqlite3.node');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'private Node binary fixture');
    }
    return { status };
  });
  const require = Object.assign((id: string) => id === 'node:child_process' ? { spawnSync } : realRequire(id), {
    resolve: (id: string, options?: { paths: string[] }) => id === 'better-sqlite3/package.json'
      ? path.join(options!.paths[0], 'node_modules/better-sqlite3/package.json')
      : realRequire.resolve(id),
  });
  const module = { exports: {} as Api };
  runInNewContext(fs.readFileSync(helperFile, 'utf8'), { module, require, process, AggregateError });
  return { ...module.exports, spawnSync };
}

afterEach(() => {
  for (const link of links.splice(0)) if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
  for (const root of temporaryRoots.splice(0)) {
    if (path.dirname(root) !== fs.realpathSync(os.tmpdir()) || !path.basename(root).startsWith('sqlite-module-test-'))
      throw new Error('Test cleanup escaped its temporary directory.');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('prepares and cleans a private driver while leaving the application native binary unchanged', () => {
  const source = fixture();
  const api = loadHelper();
  const prepared = api.prepareSqliteTestModule(source.root, {});
  const privateRoot = path.dirname(path.dirname(prepared.modulePath));
  expect(fs.readFileSync(path.join(privateRoot, 'build/Release/better_sqlite3.node'), 'utf8')).toBe('private Node binary fixture');
  expect(api.spawnSync.mock.calls[0][2]).toMatchObject({ cwd: privateRoot, windowsHide: true });
  expect(api.spawnSync.mock.calls[0][1]).toContain('node');
  prepared.dispose();
  prepared.dispose();
  expect(fs.existsSync(privateRoot)).toBe(false);
  expect(fs.readFileSync(source.applicationBinary, 'utf8')).toBe('application Electron binary fixture');
});

test('compiles only in the private package if its prebuilt binary is unavailable', () => {
  const { root, source } = fixture();
  const api = loadHelper({ prebuilt: 1 });
  const prepared = api.prepareSqliteTestModule(root, {});
  const compile = api.spawnSync.mock.calls[1];
  expect(compile[1][0]).toContain('node-gyp');
  expect(compile[2].cwd).not.toBe(source);
  expect(compile[2].cwd).toBe(path.dirname(path.dirname(prepared.modulePath)));
  prepared.dispose();
});

test('rejects failed verification and releases its private files', () => {
  const { root, applicationBinary } = fixture();
  const api = loadHelper({ verification: 1 });
  expect(() => api.prepareSqliteTestModule(root, {})).toThrow('incompatible with Node.js');
  expect(fs.readdirSync(path.join(root, 'build/test-dependencies'))).toEqual([]);
  expect(fs.readFileSync(applicationBinary, 'utf8')).toContain('application Electron');
});

test('verifies an explicit module without preparing or deleting its external files', () => {
  const { root, source } = fixture();
  const api = loadHelper();
  const modulePath = path.join(source, 'lib/index.js');
  const prepared = api.prepareSqliteTestModule(root, { SQLITE_TEST_MODULE: modulePath });
  expect(api.spawnSync).toHaveBeenCalledOnce();
  expect(api.spawnSync.mock.calls[0][1][0]).toBe('-e');
  prepared.dispose();
  expect(fs.existsSync(modulePath)).toBe(true);
  expect(fs.existsSync(path.join(root, 'build'))).toBe(false);
});

test('refuses cleanup if its owned directory was replaced', () => {
  const { root } = fixture();
  const prepared = loadHelper().prepareSqliteTestModule(root, {});
  const privateRoot = path.dirname(path.dirname(prepared.modulePath));
  fs.renameSync(privateRoot, `${privateRoot}-retired`);
  fs.mkdirSync(privateRoot);
  fs.writeFileSync(path.join(privateRoot, 'borrowed.txt'), 'preserve');
  expect(() => prepared.dispose()).toThrow('lost its owned directory');
  expect(fs.readFileSync(path.join(privateRoot, 'borrowed.txt'), 'utf8')).toBe('preserve');
});

test('refuses cleanup through a replaced build ancestor even when the owned inode is unchanged', () => {
  const { root } = fixture();
  const prepared = loadHelper().prepareSqliteTestModule(root, {});
  const build = path.join(root, 'build');
  const retiredBuild = path.join(root, 'build-retired');
  fs.renameSync(build, retiredBuild);
  fs.symlinkSync(retiredBuild, build, 'junction');
  links.push(build);
  expect(() => prepared.dispose()).toThrow('ancestors changed or are linked');
  expect(fs.existsSync(path.join(retiredBuild, path.relative(build, prepared.modulePath)))).toBe(true);
});
