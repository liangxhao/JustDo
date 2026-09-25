import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

const cacheRoot =
  process.env.ELECTRON_BUILDER_CACHE ||
  path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache');
const compiler = [
  process.env.JUSTDO_TEST_MAKENSIS,
  path.join(cacheRoot, 'nsis', 'nsis-3.0.4.1', 'Bin', 'makensis.exe'),
  path.join(cacheRoot, 'nsis', 'nsis-3.0.4.1-nsis-3.0.4.1', 'Bin', 'makensis.exe'),
].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));

it.runIf(process.platform === 'win32' && Boolean(compiler))(
  'preserves every log record across overlapping NSIS handles and repeated installs',
  () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-nsis-append-'));
    try {
      const installerScript = readFileSync(
        path.resolve(__dirname, '../../scripts/packaging/nsis-installer.nsh'),
        'utf8',
      );
      const appendMacro = installerScript.match(/!macro JustDoOpenAppendLog[^]*?!macroend/);
      expect(appendMacro).not.toBeNull();
      const scriptPath = path.join(root, 'append.nsi');
      const executablePath = path.join(root, 'append.exe');
      const logPath = path.join(root, 'append.log');
      writeFileSync(logPath, 'previous-install\r\n');
      writeFileSync(
        scriptPath,
        [
          '!include "LogicLib.nsh"',
          'Unicode true',
          'RequestExecutionLevel user',
          'SilentInstall silent',
          'OutFile "append.exe"',
          appendMacro![0],
          'Section',
          '  !insertmacro JustDoOpenAppendLog $0 "$EXEDIR\\append.log"',
          '  !insertmacro JustDoOpenAppendLog $1 "$EXEDIR\\append.log"',
          '  FileWrite $0 "SESSION START$\\r$\\n"',
          '  FileWrite $1 "callback-event$\\r$\\n"',
          '  FileWrite $0 "persistent-handle-event$\\r$\\n"',
          '  FileClose $1',
          '  !insertmacro JustDoOpenAppendLog $1 "$EXEDIR\\append.log"',
          '  FileWrite $1 "reopened-event$\\r$\\n"',
          '  FileWrite $0 "SESSION END$\\r$\\n"',
          '  FileClose $0',
          '  FileClose $1',
          'SectionEnd',
        ].join('\n'),
      );
      const compile = spawnSync(compiler!, ['/WX', '/V2', '/INPUTCHARSET', 'UTF8', scriptPath], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const run = spawnSync(executablePath, [], { cwd: root, timeout: 30_000 });
        expect(run.error).toBeUndefined();
        expect(run.status).toBe(0);
      }
      const session =
        'SESSION START\r\ncallback-event\r\npersistent-handle-event\r\nreopened-event\r\nSESSION END\r\n';
      expect(readFileSync(logPath, 'utf8')).toBe(`previous-install\r\n${session}${session}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  90_000,
);

it.runIf(process.platform === 'win32' && Boolean(compiler))(
  'writes exactly one end boundary per silent install even when finalization repeats',
  () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-nsis-session-end-'));
    try {
      const installerScript = readFileSync(
        path.resolve(__dirname, '../../scripts/packaging/nsis-installer.nsh'),
        'utf8',
      );
      const appendMacro = installerScript.match(/!macro JustDoOpenAppendLog[^]*?!macroend/);
      const endFunction = installerScript.match(
        /Function JustDoWriteInstallSessionEnd[^]*?FunctionEnd/,
      );
      expect(appendMacro).not.toBeNull();
      expect(endFunction).not.toBeNull();
      const scriptPath = path.join(root, 'end.nsi');
      for (const name of ['timing.log', 'resource.log']) {
        writeFileSync(path.join(root, name), 'previous-install\r\n');
      }
      writeFileSync(
        scriptPath,
        [
          '!include "LogicLib.nsh"',
          '!include "FileFunc.nsh"',
          '!define VERSION "test-version"',
          'Unicode true',
          'RequestExecutionLevel user',
          'SilentInstall silent',
          'OutFile "end.exe"',
          'Var JustDoInstallLogPath',
          'Var JustDoResourceLogPath',
          'Var JustDoInstallerSessionId',
          'Var JustDoInstallerSessionEnded',
          'Var JustDoInstallerPid',
          'Var JustDoInstallTerminalState',
          appendMacro![0],
          endFunction![0],
          'Function .onInstSuccess',
          '  StrCpy $JustDoInstallTerminalState "success"',
          '  Call JustDoWriteInstallSessionEnd',
          '  Call JustDoWriteInstallSessionEnd',
          'FunctionEnd',
          'Section',
          '  StrCpy $JustDoInstallLogPath "$EXEDIR\\timing.log"',
          '  StrCpy $JustDoResourceLogPath "$EXEDIR\\resource.log"',
          '  StrCpy $JustDoInstallerSessionId "silent-test"',
          '  StrCpy $JustDoInstallerPid "test-pid"',
          'SectionEnd',
        ].join('\n'),
      );
      const compile = spawnSync(compiler!, ['/WX', '/V2', '/INPUTCHARSET', 'UTF8', scriptPath], {
        cwd: root,
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const run = spawnSync(path.join(root, 'end.exe'), [], { cwd: root, timeout: 30_000 });
        expect(run.error).toBeUndefined();
        expect(run.status).toBe(0);
      }
      for (const name of ['timing.log', 'resource.log']) {
        const log = readFileSync(path.join(root, name), 'utf8');
        expect(log.startsWith('previous-install\r\n')).toBe(true);
        expect(log.match(/INSTALL SESSION END/g)).toHaveLength(2);
        expect(log.match(/terminal-state=success/g)).toHaveLength(2);
        expect(log).toContain('session=silent-test');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  90_000,
);
