import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildSync } from 'esbuild';
import ts from 'typescript';
import { afterEach, expect, test } from 'vitest';

const { ensureOpenClawGatewayBundleLauncher } = require('./openclawGatewayBundleLauncher.cjs');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    for (const filename of ['gateway-bundle.mjs', 'gateway-launcher.cjs', 'windows-runtime-preload.cjs']) {
      const file = path.join(root, 'resources', filename);
      if (fs.existsSync(file) && fs.lstatSync(file).isFile()) fs.chmodSync(file, 0o666);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prepared-runtime 中文 空格-'));
  roots.push(root);
  const runtime = path.join(root, 'resources');
  fs.mkdirSync(path.join(runtime, 'dist', 'gateway'), { recursive: true });
  fs.writeFileSync(path.join(runtime, 'gateway-bundle.mjs'), 'export {};\n');
  fs.writeFileSync(path.join(runtime, 'dist', 'gateway', 'client.js'), 'exports.GatewayClient = class GatewayClient {};\n');
  ensureOpenClawGatewayBundleLauncher(runtime);
  // A damaged install must not recover by copying its legacy archive back.
  fs.mkdirSync(path.join(runtime, 'gateway.asar', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(runtime, 'gateway.asar', 'openclaw.mjs'), 'export {};\n');
  fs.writeFileSync(path.join(runtime, 'gateway.asar', 'dist', 'entry.js'), 'export {};\n');
  return { root, runtime };
}

function compileMinifiedManager(root: string) {
  const sourceFile = path.join(__dirname, 'openclawEngineManager.ts');
  const source = ts.createSourceFile(sourceFile, fs.readFileSync(sourceFile, 'utf8'), ts.ScriptTarget.Latest, true);
  const manager = source.statements.find(statement => ts.isClassDeclaration(statement) && statement.name?.text === 'OpenClawEngineManager') as ts.ClassDeclaration;
  const names = new Set(['ensureBareEntryFiles', 'resolveOpenClawGatewayEntry', 'ensureGatewayLauncherCjsForBundle', 'prepareRuntimeCleanup', 'resolveGatewayClientEntry', 'findGatewayClientEntryFromDistRoot']);
  const methods = manager.members.filter(member => ts.isMethodDeclaration(member) && names.has(member.name.getText(source)));
  expect(methods).toHaveLength(names.size);
  const output = path.join(root, 'minified-main.cjs');
  const generated = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { ensureOpenClawGatewayBundleLauncher, prepareWindowsRuntimeCleanup } from ${JSON.stringify(path.join(__dirname, 'openclawGatewayBundleLauncher.cjs'))};
    import { loadPreparedWindowsRuntimePreload, resolvePreparedWindowsGatewayLauncher } from ${JSON.stringify(path.join(__dirname, 'preparedGatewayRuntime.ts'))};
    const app = { isPackaged: process.env.RUNTIME_FIXTURE_PACKAGED !== 'false' };
    export class RuntimeHarness {
      ${methods.map(method => method.getText(source)).join('\n')}
      ensureControlUiFiles() { throw new Error('Unexpected installation rewrite fallback'); }
    }
  `;
  buildSync({ stdin: { contents: generated, loader: 'ts', resolveDir: __dirname }, outfile: output, bundle: true, minify: true, platform: 'node', format: 'cjs', target: 'node24' });
  return output;
}

function runFixture(root: string, runtime: string, compiled: string, mode: string) {
  const runner = path.join(root, 'runner.cjs');
  fs.writeFileSync(runner, `
    const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
    const runtime = ${JSON.stringify(runtime)};
    const writes = [];
    const contained = value => typeof value === 'string' && (path.resolve(value) === runtime || path.resolve(value).startsWith(runtime + path.sep));
    if (${JSON.stringify(mode)} !== 'dev') {
      for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'copyFileSync', 'renameSync', 'unlinkSync', 'rmSync', 'rmdirSync']) {
        const original = fs[name];
        fs[name] = function(...args) {
          if (args.some(contained)) {
            writes.push(name);
            const error = new Error('Read-only installation: ' + name); error.code = 'EACCES'; throw error;
          }
          return original.apply(this, args);
        };
      }
    }
    Object.defineProperty(process.versions, 'electron', { value: 'fixture' });
    const { RuntimeHarness } = require(${JSON.stringify(compiled)});
    const manager = new RuntimeHarness();
    const files = ['gateway-bundle.mjs', 'gateway-launcher.cjs', 'windows-runtime-preload.cjs'];
    const snapshot = () => files.map(name => { const file = path.join(runtime, name); return fs.existsSync(file) && fs.lstatSync(file).isFile() ? fs.readFileSync(file, 'utf8') : null; });
    const before = snapshot();
    if (${JSON.stringify(mode)} === 'ready') {
      const workerBefore = require('node:worker_threads').Worker;
      for (let attempt = 0; attempt < 2; attempt++) {
        manager.ensureBareEntryFiles(runtime);
        assert.equal(manager.resolveOpenClawGatewayEntry(runtime), path.join(runtime, 'gateway-launcher.cjs'));
        assert.equal(manager.prepareRuntimeCleanup(runtime), path.join(runtime, 'windows-runtime-preload.cjs'));
        assert.equal(manager.resolveGatewayClientEntry(runtime), path.join(runtime, 'dist', 'gateway', 'client.js'));
      }
      assert.equal(fs[Symbol.for('runtime.windowsRecursiveRemove')], true);
      assert.notEqual(require('node:worker_threads').Worker, workerBefore);
      assert.deepEqual(snapshot(), before);
      assert.deepEqual(writes, []);
    } else if (${JSON.stringify(mode)} === 'dev') {
      assert.equal(manager.resolveOpenClawGatewayEntry(runtime), path.join(runtime, 'gateway-launcher.cjs'));
      assert.equal(manager.prepareRuntimeCleanup(runtime), path.join(runtime, 'windows-runtime-preload.cjs'));
      assert.ok(fs.statSync(path.join(runtime, 'gateway-launcher.cjs')).size > 0);
      assert.ok(fs.statSync(path.join(runtime, 'windows-runtime-preload.cjs')).size > 0);
    } else {
      for (const resolve of [() => manager.ensureBareEntryFiles(runtime), () => manager.resolveOpenClawGatewayEntry(runtime)]) {
        assert.throws(resolve, /Packaged OpenClaw runtime (?:file is missing|requires a non-empty regular file):/);
      }
      if (${JSON.stringify(mode)}.startsWith('windows-runtime-preload.cjs:')) {
        assert.throws(() => manager.resolveGatewayClientEntry(runtime), /Packaged OpenClaw runtime (?:file is missing|requires a non-empty regular file):/);
      }
      assert.deepEqual(snapshot(), before);
      assert.deepEqual(writes, []);
    }
    process.stdout.write(JSON.stringify({ writes, preserved: snapshot().every((value, index) => value === before[index]) }));
  `);
  const result = spawnSync(process.execPath, [runner], { encoding: 'utf8', windowsHide: true, timeout: 10_000, env: { ...process.env, RUNTIME_FIXTURE_PACKAGED: mode === 'dev' ? 'false' : 'true' } });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim().split('\n').at(-1)!);
}

test.runIf(process.platform === 'win32')('minified Main reuses prepared launcher/preload bytes twice under a read-only installation', () => {
  const { root, runtime } = createFixture();
  const compiled = compileMinifiedManager(root);
  for (const name of ['gateway-bundle.mjs', 'gateway-launcher.cjs', 'windows-runtime-preload.cjs']) fs.chmodSync(path.join(runtime, name), 0o444);
  expect(runFixture(root, runtime, compiled, 'ready')).toEqual({ writes: [], preserved: true });
});

test.runIf(process.platform === 'win32').each(['gateway-bundle.mjs', 'gateway-launcher.cjs', 'windows-runtime-preload.cjs'])(
  'minified packaged Main rejects missing, empty or non-file %s without legacy writes', filename => {
    const { root, runtime } = createFixture();
    const compiled = compileMinifiedManager(root);
    const file = path.join(runtime, filename);
    fs.unlinkSync(file);
    runFixture(root, runtime, compiled, filename + ':missing');
    fs.writeFileSync(file, '');
    runFixture(root, runtime, compiled, filename + ':empty');
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    runFixture(root, runtime, compiled, filename + ':directory');
  },
);

test.runIf(process.platform === 'win32')('development Main can still generate missing launcher and preload files', () => {
  const { root, runtime } = createFixture();
  const compiled = compileMinifiedManager(root);
  fs.unlinkSync(path.join(runtime, 'gateway-launcher.cjs'));
  fs.unlinkSync(path.join(runtime, 'windows-runtime-preload.cjs'));
  runFixture(root, runtime, compiled, 'dev');
});
