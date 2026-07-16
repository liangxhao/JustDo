import { app } from 'electron';
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

import { coworkLog } from '../../cowork/coworkLogger';

let cachedElectronNodeRuntimePath: string | null = null;

function resolveElectronNodeRuntimePath(): string {
  if (!app.isPackaged || process.platform !== 'darwin') {
    return process.execPath;
  }

  try {
    const appName = app.getName();
    const frameworksDir = join(process.resourcesPath, '..', 'Frameworks');
    if (!existsSync(frameworksDir)) return process.execPath;

    const helperApps = readdirSync(frameworksDir)
      .filter(entry => entry.startsWith(`${appName} Helper`) && entry.endsWith('.app'))
      .sort((a, b) => {
        const score = (name: string): number => {
          if (name === `${appName} Helper.app`) return 0;
          if (name === `${appName} Helper (Renderer).app`) return 1;
          if (name === `${appName} Helper (Plugin).app`) return 2;
          if (name === `${appName} Helper (GPU).app`) return 3;
          return 10;
        };
        return score(a) - score(b);
      });

    for (const helperApp of helperApps) {
      const helperExeName = helperApp.replace(/\.app$/, '');
      const helperExePath = join(frameworksDir, helperApp, 'Contents', 'MacOS', helperExeName);
      if (existsSync(helperExePath)) return helperExePath;
    }
  } catch (error) {
    coworkLog(
      'WARN',
      'resolveNodeShim',
      `Failed to resolve Electron helper runtime: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return process.execPath;
}

export function getElectronNodeRuntimePath(): string {
  cachedElectronNodeRuntimePath ??= resolveElectronNodeRuntimePath();
  return cachedElectronNodeRuntimePath;
}

export function ensureElectronNodeShim(electronPath: string, npmBinDir?: string): string | null {
  try {
    const shimDir = join(app.getPath('userData'), 'cowork', 'bin');
    mkdirSync(shimDir, { recursive: true });

    const nodeSh = join(shimDir, 'node');
    writeFileSync(
      nodeSh,
      [
        '#!/usr/bin/env bash',
        'if [ -z "${JUSTDO_ELECTRON_PATH:-}" ]; then',
        '  echo "JUSTDO_ELECTRON_PATH is not set" >&2',
        '  exit 127',
        'fi',
        'exec env ELECTRON_RUN_AS_NODE=1 "${JUSTDO_ELECTRON_PATH}" "$@"',
        '',
      ].join('\n'),
      'utf8',
    );
    try {
      chmodSync(nodeSh, 0o755);
    } catch {
      // Some file systems do not support POSIX modes.
    }

    if (process.platform === 'win32') {
      const hideChildProcessPreload = join(shimDir, 'hide-child-process-windows.cjs');
      writeFileSync(
        hideChildProcessPreload,
        [
          "'use strict';",
          "const childProcess = require('node:child_process');",
          'const originalSpawn = childProcess.spawn;',
          'childProcess.spawn = function hiddenWindowsSpawn(command, args, options) {',
          '  if (!Array.isArray(args)) { options = args; args = []; }',
          '  return originalSpawn.call(this, command, args, { ...(options || {}), windowsHide: true });',
          '};',
          '',
        ].join('\r\n'),
        'utf8',
      );

      writeFileSync(
        join(shimDir, 'node.cmd'),
        [
          '@echo off',
          'if "%JUSTDO_ELECTRON_PATH%"=="" (',
          '  echo JUSTDO_ELECTRON_PATH is not set 1>&2',
          '  exit /b 127',
          ')',
          'set ELECTRON_RUN_AS_NODE=1',
          '"%JUSTDO_ELECTRON_PATH%" %*',
          '',
        ].join('\r\n'),
        'utf8',
      );
    }

    if (npmBinDir && existsSync(npmBinDir)) {
      for (const command of ['npm', 'npx'] as const) {
        const cliPath = join(npmBinDir, `${command}-cli.js`);
        if (!existsSync(cliPath)) continue;

        const shellShim = join(shimDir, command);
        writeFileSync(
          shellShim,
          [
            '#!/usr/bin/env bash',
            'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"',
            `exec "$SCRIPT_DIR/node" "${cliPath.replace(/\\/g, '/')}" "$@"`,
            '',
          ].join('\n'),
          'utf8',
        );
        try {
          chmodSync(shellShim, 0o755);
        } catch {
          // Some file systems do not support POSIX modes.
        }

        if (process.platform === 'win32') {
          writeFileSync(
            join(shimDir, `${command}.cmd`),
            ['@echo off', `"%~dp0node.cmd" "%JUSTDO_NPM_BIN_DIR%\\${command}-cli.js" %*`, ''].join(
              '\r\n',
            ),
            'utf8',
          );
        }
      }
    }

    for (const name of ['node', 'npx', 'npm']) {
      const shimPath = join(shimDir, name);
      if (existsSync(shimPath)) {
        const stat = statSync(shimPath);
        coworkLog('INFO', 'resolveNodeShim', `Prepared ${name} shim (${stat.size} bytes)`);
      }
    }
    return shimDir;
  } catch (error) {
    coworkLog(
      'WARN',
      'resolveNodeShim',
      `Failed to prepare Electron Node shim: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}
