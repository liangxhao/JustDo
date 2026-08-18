import path from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getName: () => 'JustDo',
    getPath: () => '',
    isPackaged: false,
  },
}));

import {
  appendNodeRequireOption,
  buildElectronNodeShimScripts,
  buildWindowsChildProcessPreload,
  resolvePackagedNpmBinDir,
} from './electronNodeRuntime';

describe('Electron Node runtime', () => {
  it('keeps packaged npm on its logical asar path for dependency resolution', () => {
    const resourcesPath = path.join('application', 'resources');

    const npmBinDir = resolvePackagedNpmBinDir(resourcesPath);

    expect(npmBinDir).toBe(
      path.join(resourcesPath, 'app.asar', 'node_modules', 'npm', 'bin'),
    );
    expect(npmBinDir).not.toContain('app.asar.unpacked');
  });

  it('builds self-contained Electron Node and package runner shims', () => {
    const scripts = buildElectronNodeShimScripts(
      'C:\\Program Files\\JustDo 100%\\JustDo.exe',
      'C:\\Program Files\\JustDo\\resources\\app.asar\\node_modules\\npm\\bin',
    );

    expect(scripts.nodeCmd).toContain('"C:\\Program Files\\JustDo 100%%\\JustDo.exe" %*');
    expect(scripts.packageCmd('npx')).toContain(
      '"C:\\Program Files\\JustDo\\resources\\app.asar\\node_modules\\npm\\bin\\npx-cli.js"',
    );
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
    expect(() => buildElectronNodeShimScripts('C:\\Electron.exe\r\nwhoami')).toThrow(
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
});
