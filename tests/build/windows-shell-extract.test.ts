import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const cache = process.env.ELECTRON_BUILDER_CACHE || path.join(process.env.LOCALAPPDATA || '', 'electron-builder/Cache');
const compiler = path.join(cache, 'nsis/nsis-3.0.4.1/makensis.exe');
const templates = path.join(path.dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis');
const { createWindowsInstallerScript } = require('../../scripts/packaging/windows-installer-script.cjs');
const extraction = createWindowsInstallerScript(templates).match(/!macro extractUsing7za FILE[^]*?!macroend/)?.[0];

function prepareFixture(root: string, corrupted = false, resourceLog = path.join(root, 'resource.log')) {
  expect(extraction).toBeTruthy();
  const sourceRoot = path.join(root, 'source');
  const archive = path.join(root, 'app.7z');
  const destination = path.join(root, '安装 %literal% & 感叹! 空格');
  const executable = path.join(root, 'extract.exe');
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(destination);
  writeFileSync(path.join(sourceRoot, 'app.txt'), 'new app');
  writeFileSync(path.join(sourceRoot, 'locked.txt'), 'new content');
  if (corrupted) {
    writeFileSync(archive, 'broken 7z data');
  } else {
    const compressed = spawnSync(require('7zip-bin').path7za, ['a', '-mx=0', archive, '.'], {
      cwd: sourceRoot,
      windowsHide: true,
      timeout: 10_000,
    });
    expect(compressed.status, compressed.stderr.toString()).toBe(0);
  }
  const script = [
    '!include "LogicLib.nsh"',
    'Unicode true',
    'RequestExecutionLevel user',
    'SilentInstall silent',
    `OutFile "${executable}"`,
    `InstallDir "${destination}"`,
    'Var JustDoInstallerSessionId',
    'Var JustDoResourceLogPath',
    '!macro JustDoLogInstallEvent TEXT',
    '  FileOpen $0 "$INSTDIR\\events.log" a',
    '  FileWrite $0 "${TEXT}$\\r$\\n"',
    '  FileClose $0',
    '!macroend',
    extraction,
    'Function .onInstSuccess',
    '  FileOpen $0 "$INSTDIR\\success.txt" w',
    '  FileWrite $0 "success"',
    '  FileClose $0',
    'FunctionEnd',
    'Section',
    '  SetOutPath $INSTDIR',
    '  StrCpy $JustDoInstallerSessionId "test-session"',
    `  StrCpy $JustDoResourceLogPath "${resourceLog}"`,
    `  File /oname=archive.7z "${archive}"`,
    '  !insertmacro extractUsing7za "$INSTDIR\\archive.7z"',
    'SectionEnd',
  ].join('\n');
  const scriptPath = path.join(root, 'extract.nsi');
  writeFileSync(scriptPath, script);
  const compiled = spawnSync(compiler, ['/WX', '/V2', '/INPUTCHARSET', 'UTF8', scriptPath], {
    windowsHide: true,
    timeout: 15_000,
    encoding: 'utf8',
  });
  expect(compiled.status, `${compiled.stdout}\n${compiled.stderr}`).toBe(0);
  return { destination, executable, resourceLog };
}

describe.runIf(process.platform === 'win32' && existsSync(compiler))('Windows application shell extraction', () => {
  it('extracts Chinese, spaces and shell-special paths and removes successful staging', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-shell-'));
    try {
      const fixture = prepareFixture(root);
      writeFileSync(fixture.resourceLog, 'previous log\n');
      const result = spawnSync(fixture.executable, [], { windowsHide: true, timeout: 15_000 });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(readFileSync(path.join(fixture.destination, 'app.txt'), 'utf8')).toBe('new app');
      expect(readFileSync(path.join(fixture.destination, 'locked.txt'), 'utf8')).toBe('new content');
      expect(existsSync(path.join(fixture.destination, 'success.txt'))).toBe(true);
      expect(existsSync(path.join(fixture.destination, 'archive.7z'))).toBe(false);
      expect(existsSync(path.join(fixture.destination, '.justdo-shell-test-session-7za.exe'))).toBe(false);
      expect(existsSync(path.join(fixture.destination, '.justdo-shell-test-session.log'))).toBe(false);
      const log = readFileSync(fixture.resourceLog, 'utf8');
      expect(log).toContain('previous log');
      expect(log).toContain('Everything is Ok');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a real locked output file as failure with full extraction diagnostics', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-shell-lock-'));
    try {
      const fixture = prepareFixture(root);
      const locked = path.join(fixture.destination, 'locked.txt');
      writeFileSync(locked, 'old content');
      const lockScript = path.join(root, 'hold-lock.ps1');
      writeFileSync(lockScript, `
$lock = [IO.File]::Open($env:JUSTDO_TEST_LOCK, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
try {
  $process = Start-Process -FilePath $env:JUSTDO_TEST_EXE -WindowStyle Hidden -PassThru
  if (-not $process.WaitForExit(15000)) { $process.Kill(); throw 'Extraction timed out' }
  Write-Output "exit=$($process.ExitCode)"
} finally { $lock.Dispose() }
`);
      const result = spawnSync(path.join(process.env.SystemRoot || '', 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', lockScript,
      ], {
        windowsHide: true,
        timeout: 20_000,
        encoding: 'utf8',
        env: { ...process.env, JUSTDO_TEST_LOCK: locked, JUSTDO_TEST_EXE: fixture.executable },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('exit=2');
      expect(readFileSync(locked, 'utf8')).toBe('old content');
      expect(existsSync(path.join(fixture.destination, 'success.txt'))).toBe(false);
      const log = readFileSync(path.join(fixture.destination, '.justdo-shell-test-session.log'), 'utf8');
      expect(log).toContain('ERROR');
      expect(log).toContain('locked.txt');
      expect(readFileSync(fixture.resourceLog, 'utf8')).toContain(log);
      expect(readFileSync(path.join(fixture.destination, 'events.log'), 'utf8')).toContain('reason=shell-extraction-failed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('reports corrupt archives before any successful completion', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-shell-corrupt-'));
    try {
      const fixture = prepareFixture(root, true);
      const result = spawnSync(fixture.executable, [], { windowsHide: true, timeout: 15_000 });
      expect(result.status).toBe(2);
      expect(existsSync(path.join(fixture.destination, 'success.txt'))).toBe(false);
      const log = readFileSync(path.join(fixture.destination, '.justdo-shell-test-session.log'), 'utf8');
      expect(log).toContain('ERROR');
      expect(log).toContain('Cannot open the file as [7z] archive');
      expect(readFileSync(fixture.resourceLog, 'utf8')).toContain(log);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['unavailable', 'unwritable'])('retains detailed logs without blocking extraction when Roaming logging is %s', state => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-shell-logging-'));
    try {
      const fixture = prepareFixture(root, false, state === 'unavailable' ? '' : path.join(root, 'source'));
      const result = spawnSync(fixture.executable, [], { windowsHide: true, timeout: 15_000 });
      expect(result.status).toBe(0);
      expect(existsSync(path.join(fixture.destination, 'success.txt'))).toBe(true);
      expect(readFileSync(path.join(fixture.destination, '.justdo-shell-test-session.log'), 'utf8')).toContain('Everything is Ok');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
