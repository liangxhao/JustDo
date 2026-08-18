import { app } from 'electron';
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

import { coworkLog } from '../../cowork/coworkLogger';

let cachedElectronNodeRuntimePath: string | null = null;

const assertSafeShimPath = (value: string): string => {
  if (/\r|\n/.test(value)) throw new Error('Runtime shim paths cannot contain line breaks.');
  return value;
};

const quotePosixLiteral = (value: string): string => {
  return `'${assertSafeShimPath(value).replace(/'/g, `'"'"'`)}'`;
};

const quoteWindowsBatchArgument = (value: string): string => {
  return `"${assertSafeShimPath(value).replace(/%/g, '%%').replace(/"/g, '""')}"`;
};

export const buildWindowsChildProcessPreload = (): string =>
  [
    "'use strict';",
    "const childProcess = require('node:child_process');",
    "const { syncBuiltinESMExports } = require('node:module');",
    'const withWindowsHide = options => ({ ...(options || {}), windowsHide: true });',
    'const originalSpawn = childProcess.spawn;',
    'childProcess.spawn = function hiddenWindowsSpawn(command, args, options) {',
    '  return Array.isArray(args)',
    '    ? originalSpawn.call(this, command, args, withWindowsHide(options))',
    '    : originalSpawn.call(this, command, withWindowsHide(args));',
    '};',
    'const originalSpawnSync = childProcess.spawnSync;',
    'childProcess.spawnSync = function hiddenWindowsSpawnSync(command, args, options) {',
    '  return Array.isArray(args)',
    '    ? originalSpawnSync.call(this, command, args, withWindowsHide(options))',
    '    : originalSpawnSync.call(this, command, withWindowsHide(args));',
    '};',
    'const originalExec = childProcess.exec;',
    'childProcess.exec = function hiddenWindowsExec(command, options, callback) {',
    "  return typeof options === 'function'",
    '    ? originalExec.call(this, command, withWindowsHide(), options)',
    '    : originalExec.call(this, command, withWindowsHide(options), callback);',
    '};',
    'const originalExecSync = childProcess.execSync;',
    'childProcess.execSync = function hiddenWindowsExecSync(command, options) {',
    '  return originalExecSync.call(this, command, withWindowsHide(options));',
    '};',
    'const originalExecFile = childProcess.execFile;',
    'childProcess.execFile = function hiddenWindowsExecFile(file, args, options, callback) {',
    '  if (Array.isArray(args)) {',
    "    return typeof options === 'function'",
    '      ? originalExecFile.call(this, file, args, withWindowsHide(), options)',
    '      : originalExecFile.call(this, file, args, withWindowsHide(options), callback);',
    '  }',
    "  return typeof args === 'function'",
    '    ? originalExecFile.call(this, file, withWindowsHide(), args)',
    '    : originalExecFile.call(this, file, withWindowsHide(args), options);',
    '};',
    'const originalExecFileSync = childProcess.execFileSync;',
    'childProcess.execFileSync = function hiddenWindowsExecFileSync(file, args, options) {',
    '  return Array.isArray(args)',
    '    ? originalExecFileSync.call(this, file, args, withWindowsHide(options))',
    '    : originalExecFileSync.call(this, file, withWindowsHide(args));',
    '};',
    'const originalFork = childProcess.fork;',
    'childProcess.fork = function hiddenWindowsFork(modulePath, args, options) {',
    '  return Array.isArray(args)',
    '    ? originalFork.call(this, modulePath, args, withWindowsHide(options))',
    '    : originalFork.call(this, modulePath, withWindowsHide(args));',
    '};',
    '// Keep ESM named imports in sync with the patched CommonJS builtin exports.',
    'syncBuiltinESMExports();',
    '',
  ].join('\r\n');

export const appendNodeRequireOption = (nodeOptions: string | undefined, filePath: string): string => {
  const safePath = assertSafeShimPath(filePath).replace(/\\/g, '/').replace(/"/g, '\\"');
  const requireOption = `--require="${safePath}"`;
  if (nodeOptions?.includes(requireOption)) return nodeOptions;
  return [nodeOptions?.trim(), requireOption].filter(Boolean).join(' ');
};

export const buildElectronNodeShimScripts = (
  electronPath: string,
  npmBinDir?: string,
): {
  nodeSh: string;
  nodeCmd: string;
  packageSh: (command: 'npm' | 'npx') => string;
  packageCmd: (command: 'npm' | 'npx') => string;
} => {
  const quotedElectronSh = quotePosixLiteral(electronPath);
  const quotedElectronCmd = quoteWindowsBatchArgument(electronPath);
  const resolveCliPath = (command: 'npm' | 'npx'): string => {
    if (!npmBinDir) throw new Error('npm bin directory is required for package runner shims.');
    return join(npmBinDir, `${command}-cli.js`);
  };

  return {
    nodeSh: [
      '#!/usr/bin/env bash',
      `exec env ELECTRON_RUN_AS_NODE=1 ${quotedElectronSh} "$@"`,
      '',
    ].join('\n'),
    nodeCmd: ['@echo off', 'set ELECTRON_RUN_AS_NODE=1', `${quotedElectronCmd} %*`, ''].join(
      '\r\n',
    ),
    packageSh: command => [
      '#!/usr/bin/env bash',
      'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"',
      `exec "$SCRIPT_DIR/node" ${quotePosixLiteral(resolveCliPath(command))} "$@"`,
      '',
    ].join('\n'),
    packageCmd: command =>
      [
        '@echo off',
        `"%~dp0node.cmd" ${quoteWindowsBatchArgument(resolveCliPath(command))} %*`,
        '',
      ].join('\r\n'),
  };
};

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

export function resolvePackagedNpmBinDir(resourcesPath: string): string {
  // Keep the logical app.asar path so npm can resolve its hoisted dependencies
  // from app.asar. Electron transparently redirects npm's unpacked files.
  return join(resourcesPath, 'app.asar', 'node_modules', 'npm', 'bin');
}

export function ensureElectronNodeShim(electronPath: string, npmBinDir?: string): string | null {
  try {
    const shimDir = join(app.getPath('userData'), 'cowork', 'bin');
    mkdirSync(shimDir, { recursive: true });
    const shimScripts = buildElectronNodeShimScripts(electronPath, npmBinDir);

    const nodeSh = join(shimDir, 'node');
    writeFileSync(nodeSh, shimScripts.nodeSh, 'utf8');
    try {
      chmodSync(nodeSh, 0o755);
    } catch {
      // Some file systems do not support POSIX modes.
    }

    if (process.platform === 'win32') {
      const hideChildProcessPreload = join(shimDir, 'hide-child-process-windows.cjs');
      writeFileSync(hideChildProcessPreload, buildWindowsChildProcessPreload(), 'utf8');

      writeFileSync(
        join(shimDir, 'node.cmd'),
        shimScripts.nodeCmd,
        'utf8',
      );
    }

    if (npmBinDir && existsSync(npmBinDir)) {
      for (const command of ['npm', 'npx'] as const) {
        const cliPath = join(npmBinDir, `${command}-cli.js`);
        if (!existsSync(cliPath)) continue;

        const shellShim = join(shimDir, command);
        writeFileSync(shellShim, shimScripts.packageSh(command), 'utf8');
        try {
          chmodSync(shellShim, 0o755);
        } catch {
          // Some file systems do not support POSIX modes.
        }

        if (process.platform === 'win32') {
          writeFileSync(
            join(shimDir, `${command}.cmd`),
            shimScripts.packageCmd(command),
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
