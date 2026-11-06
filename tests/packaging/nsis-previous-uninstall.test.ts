import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const cache = process.env.ELECTRON_BUILDER_CACHE || path.join(process.env.LOCALAPPDATA || '', 'electron-builder/Cache');
const compiler = path.join(cache, 'nsis/nsis-3.0.4.1/makensis.exe');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const installer = readFileSync(path.join(repoRoot, 'scripts/packaging/nsis-installer.nsh'), 'utf8');
const upstream = readFileSync(path.join(repoRoot, 'node_modules/app-builder-lib/templates/nsis/include/installUtil.nsh'), 'utf8');
const sourceFunction = (source: string, name: string): string => {
  const result = source.match(new RegExp(`Function ${name}\\b[^]*?FunctionEnd`))?.[0];
  if (!result) throw new Error(`Installer function missing: ${name}`);
  return result;
};
const sourceMacro = (source: string, name: string): string => {
  const result = source.match(new RegExp(`!macro ${name}\\b[^]*?!macroend`))?.[0];
  if (!result) throw new Error(`Installer macro missing: ${name}`);
  return result;
};

describe('previous-version removal failure contract', () => {
  it('uses both supported result hooks and retains a failed worker instead of quitting or writing new files', () => {
    const check = sourceFunction(installer, 'InstallerCheckPreviousUninstall');
    expect(check.indexOf('IfErrors InstallerPreviousUninstallLaunchFailed')).toBeLessThan(check.indexOf('JustDoLogInstallEvent'));
    expect(check).toContain('reason=uninstaller-exit exit=$R0');
    expect(check).toContain('reason=uninstaller-launch');
    expect(check).toContain('SetErrorLevel 2');
    expect(check).toContain('Abort "$0"');
    expect(check).not.toMatch(/\bQuit\b/);
    for (const name of ['customUnInstallCheck', 'customUnInstallCheckCurrentUser']) {
      expect(sourceMacro(installer, name)).toContain('Call InstallerCheckPreviousUninstall');
    }
  });
});

describe.runIf(process.platform === 'win32' && existsSync(compiler)
  && process.env.INSTALLER_PRESENTATION_NATIVE_UI === '1')('native previous-version removal failure', () => {
  it('keeps the failure result visible for real child failures and launch errors, while a successful removal continues', () => {
    const buildRoot = path.join(repoRoot, 'build');
    mkdirSync(buildRoot, { recursive: true });
    const root = mkdtempSync(path.join(buildRoot, 'installer-previous-removal-test-'));
    const literal = (name: string): string => path.join(root, name).replaceAll('$', () => '$$');
    try {
      const child = [
        'Unicode true', 'RequestExecutionLevel user', 'SilentInstall silent',
        'Name "Previous removal child"', `OutFile "${literal('old-uninstaller.exe')}"`,
        '!include "FileFunc.nsh"', 'Section', '  ${GetParameters} $0',
        '  ${GetOptions} $0 "/code=" $1', '  SetErrorLevel $1', '  Quit', 'SectionEnd',
      ].join('\n');
      writeFileSync(path.join(root, 'child.nsi'), child);
      const compiledChild = spawnSync(compiler, ['/WX', '/V2', '/INPUTCHARSET', 'UTF8', path.join(root, 'child.nsi')], {
        encoding: 'utf8', windowsHide: true, timeout: 20_000,
      });
      expect(compiledChild.status, `${compiledChild.stdout}\n${compiledChild.stderr}`).toBe(0);
      const source = [
        'Unicode true', 'RequestExecutionLevel user', 'ShowInstDetails show',
        'Name "Previous removal fixture"', `OutFile "${literal('wizard.exe')}"`,
        '!include "MUI2.nsh"', '!include "LogicLib.nsh"', '!include "FileFunc.nsh"',
        '!define JUSTDO_LANG_SIMPCHINESE 2052', '!define JUSTDO_LANG_TRADCHINESE 1028',
        'Var FixtureCase', 'Var FixtureResult', 'Var InstallerPreviousUninstallRoot',
        '!macro JustDoLogInstallEvent TEXT', '  Push $0',
        `  FileOpen $0 "${literal('events.txt')}" a`, '  FileSeek $0 0 END',
        '  FileWrite $0 "${TEXT}$\\r$\\n"', '  FileClose $0', '  Pop $0', '  ClearErrors', '!macroend',
        sourceFunction(installer, 'InstallerCheckPreviousUninstall'),
        sourceMacro(installer, 'customUnInstallCheck'), sourceMacro(installer, 'customUnInstallCheckCurrentUser'),
        sourceFunction(upstream, 'handleUninstallResult'), sourceMacro(upstream, 'handleUninstallResult'),
        '!insertmacro MUI_PAGE_DIRECTORY',
        '!define MUI_PAGE_CUSTOMFUNCTION_LEAVE FixtureResultLeave', '!insertmacro MUI_PAGE_INSTFILES',
        '!insertmacro MUI_LANGUAGE "English"',
        'LangString uninstallFailed 1033 "Previous uninstall failed"',
        'Function .onInit', '  ${GetParameters} $0', '  ${GetOptions} $0 "/case=" $FixtureCase',
        `  StrCpy $INSTDIR "${literal('selected location')}"`, 'FunctionEnd',
        'Function FixtureResultLeave', '  StrCpy $FixtureResult "success"',
        '  IfAbort 0 +2', '    StrCpy $FixtureResult "failed"',
        `  FileOpen $0 "${literal('result.txt')}" w`,
        '  FileWrite $0 "$FixtureResult|$R0"', '  FileClose $0', 'FunctionEnd',
        'Function .onInstFailed', `  FileOpen $0 "${literal('terminal.txt')}" w`,
        '  FileWrite $0 "failed"', '  FileClose $0', 'FunctionEnd',
        'Function .onInstSuccess', `  FileOpen $0 "${literal('terminal.txt')}" w`,
        '  FileWrite $0 "success"', '  FileClose $0', 'FunctionEnd',
        'Section', '  StrCpy $R0 41', '  ClearErrors',
        '  ${If} $FixtureCase == "launch"',
        `    ExecWait '"${literal('missing-uninstaller.exe')}"' $R0`,
        '  ${ElseIf} $FixtureCase == "exit"',
        `    ExecWait '"${literal('old-uninstaller.exe')}" /code=17' $R0`,
        '  ${Else}', `    ExecWait '"${literal('old-uninstaller.exe')}" /code=0' $R0`, '  ${EndIf}',
        '  ${If} $FixtureCase == "launch"', '    !insertmacro handleUninstallResult HKEY_CURRENT_USER',
        '  ${Else}', '    !insertmacro handleUninstallResult SHELL_CONTEXT', '  ${EndIf}',
        `  FileOpen $0 "${literal('new-files-written.txt')}" w`,
        '  FileWrite $0 "continued"', '  FileClose $0', 'SectionEnd',
      ].join('\n');
      writeFileSync(path.join(root, 'fixture.nsi'), source);
      const compiled = spawnSync(compiler, ['/WX', '/V2', '/INPUTCHARSET', 'UTF8', path.join(root, 'fixture.nsi')], {
        encoding: 'utf8', windowsHide: true, timeout: 20_000,
      });
      expect(compiled.status, `${compiled.stdout}\n${compiled.stderr}`).toBe(0);
      for (const failure of ['exit', 'launch']) {
        rmSync(path.join(root, 'terminal.txt'), { force: true });
        const silent = spawnSync(path.join(root, 'wizard.exe'), ['/S', `/case=${failure}`], {
          encoding: 'utf8', windowsHide: true, timeout: 10_000,
        });
        expect(silent.status, `Silent previous-removal ${failure} failure must remain nonzero.`).toBe(2);
        expect(readFileSync(path.join(root, 'terminal.txt'), 'utf8')).toBe('failed');
        expect(existsSync(path.join(root, 'new-files-written.txt'))).toBe(false);
      }
      const checked = spawnSync(powershell, [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(repoRoot, 'scripts/fixtures/nsis-previous-uninstall-probe.ps1'),
        '-Executable', path.join(root, 'wizard.exe'), '-FixtureRoot', root,
      ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
      expect(checked.status, `${checked.stdout}\n${checked.stderr}`).toBe(0);
      expect(checked.stdout).toContain('previous removal failure checks passed');
    } finally {
      expect(path.dirname(path.resolve(root))).toBe(buildRoot);
      rmSync(root, { recursive: true, force: true });
    }
  }, 65_000);
});
