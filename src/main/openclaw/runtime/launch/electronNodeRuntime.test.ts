import { execFileSync } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

const bundledPaths = vi.hoisted(() => vi.fn(() => ({
  executable: '/verified-runtime/node',
  npmBin: '/verified-runtime/node_modules/npm/bin',
})));

vi.mock('./bundledNodeRuntime', () => ({ resolveBundledNodeRuntimePaths: bundledPaths }));

vi.mock('electron', () => ({
  app: {
    getName: () => 'JustDo',
    getPath: () => '',
    getAppPath: () => '/application',
    isPackaged: false,
  },
}));

import {
  appendNodeRequireOption,
  buildElectronNodeShimScripts,
  buildWindowsChildProcessPreload,
  getElectronNodeRuntimePath,
  resolveElectronNpmBinDir,
} from './electronNodeRuntime';

describe('Electron Node runtime', () => {
  it('keeps Node and npm on one admitted runtime for the Main process lifetime', () => {
    expect(getElectronNodeRuntimePath()).toBe('/verified-runtime/node');
    bundledPaths.mockReturnValue({ executable: '/replacement/node', npmBin: '/replacement/npm/bin' });

    expect(resolveElectronNpmBinDir()).toBe('/verified-runtime/node_modules/npm/bin');
    expect(getElectronNodeRuntimePath()).toBe('/verified-runtime/node');
    expect(bundledPaths).toHaveBeenCalledTimes(1);
  });

  it('builds self-contained Electron Node and package runner shims', () => {
    const scripts = buildElectronNodeShimScripts(
      'C:\\Program Files\\JustDo 100%\\JustDo.exe',
      'C:\\Users\\测试用户 100%\\cowork\\bin',
      'C:\\Program Files\\JustDo\\resources\\app.asar\\node_modules\\npm\\bin',
    );

    expect(scripts.nodeCmd).toContain(
      '"C:\\Program Files\\JustDo 100%%\\JustDo.exe" --require "C:\\Users\\测试用户 100%%\\cowork\\bin\\hide-child-process-windows.cjs" %*',
    );
    expect(scripts.packageCmd('npx')).toContain(
      '"C:\\Program Files\\JustDo\\resources\\app.asar\\node_modules\\npm\\bin\\npx-cli.js"',
    );
    expect(scripts.packageCmd('npx')).toContain(
      '"C:\\Users\\测试用户 100%%\\cowork\\bin\\node.cmd"',
    );
    expect(scripts.nodeCmd).not.toContain('%~dp0');
    expect(scripts.nodeSh).toContain("'C:\\Program Files\\JustDo 100%\\JustDo.exe'");
    expect(scripts.packageSh('npm')).toContain(
      "'C:\\Program Files\\JustDo\\resources\\app.asar\\node_modules\\npm\\bin\\npm-cli.js'",
    );
    for (const script of [
      scripts.nodeCmd,
      scripts.packageCmd('npm'),
      scripts.packageCmd('npx'),
      scripts.nodeSh,
      scripts.packageSh('npm'),
      scripts.packageSh('npx'),
    ]) {
      expect(script).not.toContain('JUSTDO_ELECTRON_PATH');
      expect(script).not.toContain('JUSTDO_NPM_BIN_DIR');
    }
  });

  it('rejects line breaks in generated shim paths', () => {
    expect(() => buildElectronNodeShimScripts('C:\\Electron.exe\r\nwhoami', 'C:\\bin')).toThrow(
      'cannot contain line breaks',
    );
  });

  it('hides windows for every child-process entry point used by the Gateway', () => {
    const preload = buildWindowsChildProcessPreload();

    for (const method of [
      'spawn',
      'spawnSync',
      'exec',
      'execSync',
      'execFile',
      'execFileSync',
      'fork',
    ]) {
      expect(preload).toContain(`childProcess.${method} = function hiddenWindows`);
    }
    expect(preload).toContain('windowsHide: true');
    expect(preload).toContain('syncBuiltinESMExports();');
  });

  it('adds the windows child-process preload to existing Node options once', () => {
    const preloadPath = 'C:\\Users\\Test User\\hide-child-process-windows.cjs';

    const first = appendNodeRequireOption('--use-system-ca', preloadPath);
    const second = appendNodeRequireOption(first, preloadPath);

    expect(first).toBe(
      '--use-system-ca --require="C:/Users/Test User/hide-child-process-windows.cjs"',
    );
    expect(second).toBe(first);
  });

  it('preserves promisified stdout, stderr, child handles and failure output', () => {
    const script = `
      ${buildWindowsChildProcessPreload()}
      const assert = require('node:assert/strict');
      (async () => {
        const run = promisify(childProcess.execFile);
        const pending = run(process.execPath, ['-e', 'process.stdout.write("out");process.stderr.write("err")']);
        assert.ok(pending.child.pid);
        assert.deepEqual(await pending, { stdout: 'out', stderr: 'err' });
        const buffers = await run(process.execPath, ['-e', 'process.stdout.write("out")'], {encoding: 'buffer'});
        assert.ok(Buffer.isBuffer(buffers.stdout));
        await assert.rejects(run(process.execPath, ['-e', 'process.stdout.write("out");process.stderr.write("err");process.exit(7)']),
          error => error.code === 7 && error.stdout === 'out' && error.stderr === 'err');
        const shell = promisify(childProcess.exec)('echo fixture');
        assert.ok(shell.child.pid);
        assert.equal((await shell).stdout.trim(), 'fixture');
        assert.equal((await promisify(childProcess.exec)('echo fixture', {encoding:'utf8'})).stderr, '');
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    execFileSync(process.execPath, ['-e', script], {
      windowsHide: true,
      timeout: 15_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
  });
});
