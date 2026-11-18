import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const { createWindowsInstallerScript } = require('../../scripts/packaging/windows-installer-script.cjs');
const repositoryRoot = path.resolve(__dirname, '../..');
const templates = path.join(path.dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis');
const cacheRoot = process.env.ELECTRON_BUILDER_CACHE ||
  path.join(process.env.LOCALAPPDATA || '', 'electron-builder/Cache');
const compiler = [
  path.join(cacheRoot, 'nsis/nsis-3.0.4.1/makensis.exe'),
  path.join(cacheRoot, 'nsis/nsis-3.0.4.1/Bin/makensis.exe'),
].find(candidate => existsSync(candidate));
const plugins = [
  path.join(cacheRoot, 'nsis/nsis-resources-3.4.1/plugins/x86-unicode'),
  path.join(cacheRoot, 'nsis-resources-3.4.1/plugins/x86-unicode'),
].find(candidate => existsSync(path.join(candidate, 'StdUtils.dll')));
const nsisLiteral = (value: string): string => value.replaceAll('$', () => '$$');
const sourceFunction = (source: string, name: string): string => {
  const result = source.match(new RegExp(`Function ${name}\\b[^]*?FunctionEnd`));
  if (!result) throw new Error(`Installer function missing: ${name}`);
  return result[0];
};
const sourceMacro = (source: string, name: string): string => {
  const result = source.match(new RegExp(`!macro ${name}\\b[^]*?!macroend`));
  if (!result) throw new Error(`Installer macro missing: ${name}`);
  return result[0];
};

const scenarios = [
  { id: 'stale-custom-live-arp', mode: 'all', rootKey: 'HKEY_LOCAL_MACHINE',
    customLive: false, arpLive: true, arp: 'actual', state: 'confirmed', error: false, executes: true, corrections: 1 },
  { id: 'conflicting-live-targets', mode: 'CurrentUser', rootKey: 'SHELL_CONTEXT',
    customLive: true, arpLive: true, arp: 'actual', state: 'conflict', error: true, executes: false, corrections: 0 },
  { id: 'missing-extra-registration', mode: 'all', rootKey: 'SHELL_CONTEXT',
    customLive: false, arpLive: false, arp: 'missing', state: 'missing', error: false, executes: false, corrections: 0 },
  { id: 'repair-without-product-executable', mode: 'all', rootKey: 'HKEY_CURRENT_USER',
    customLive: false, arpLive: false, arp: 'actual', state: 'missing', error: false, executes: true, corrections: 1 },
  { id: 'confirmed-product-without-paired-uninstaller', mode: 'CurrentUser', rootKey: 'SHELL_CONTEXT',
    customLive: true, arpLive: false, arp: 'missing', state: 'confirmed', error: true, executes: false, corrections: 0 },
  { id: 'live-product-without-arp-command-skips', mode: 'CurrentUser', rootKey: 'SHELL_CONTEXT',
    customLive: true, arpLive: false, arp: 'absent', state: '', error: false, executes: false, corrections: 0 },
  { id: 'registration-write-denied', mode: 'all', rootKey: 'HKEY_LOCAL_MACHINE',
    customLive: false, arpLive: true, arp: 'actual', state: 'confirmed', error: true, executes: false, corrections: 1 },
  { id: 'already-paired-does-not-write', mode: 'CurrentUser', rootKey: 'SHELL_CONTEXT',
    customLive: false, arpLive: true, arp: 'actual', state: 'confirmed', error: false, executes: true, corrections: 0 },
  { id: 'uninstaller-nonzero', mode: 'CurrentUser', rootKey: 'SHELL_CONTEXT',
    customLive: false, arpLive: true, arp: 'actual', state: 'confirmed', error: false, executes: true, corrections: 1 },
  { id: 'copied-uninstaller-cannot-start', mode: 'CurrentUser', rootKey: 'SHELL_CONTEXT',
    customLive: false, arpLive: true, arp: 'actual', state: 'confirmed', error: false, executes: true, corrections: 1 },
  { id: 'copy-failure-with-existing-file', mode: 'CurrentUser', rootKey: 'SHELL_CONTEXT',
    customLive: false, arpLive: true, arp: 'actual', state: 'confirmed', error: false, executes: true, corrections: 1 },
  { id: 'retry-failed-current-user-scope', mode: 'CurrentUser', rootKey: 'SHELL_CONTEXT',
    customLive: false, arpLive: true, arp: 'actual', state: 'confirmed', error: false, executes: true, corrections: 1 },
  { id: 'no-embedded-retry-for-secondary-scope', mode: 'all', rootKey: 'HKEY_CURRENT_USER',
    customLive: false, arpLive: true, arp: 'actual', state: 'confirmed', error: false, executes: true, corrections: 1 },
  { id: 'retry-target-replaced', mode: 'CurrentUser', rootKey: 'SHELL_CONTEXT',
    customLive: false, arpLive: true, arp: 'actual', state: 'confirmed', error: true, executes: true, corrections: 1 },
  { id: 'retry-registration-removed', mode: 'CurrentUser', rootKey: 'SHELL_CONTEXT',
    customLive: false, arpLive: true, arp: 'actual', state: 'confirmed', error: true, executes: true, corrections: 1 },
  { id: 'slow-uninstaller', mode: 'CurrentUser', rootKey: 'SHELL_CONTEXT',
    customLive: false, arpLive: true, arp: 'actual', state: 'confirmed', error: false, executes: true, corrections: 1 },
] as const;

describe.runIf(process.platform === 'win32' && Boolean(compiler) && Boolean(plugins))(
  'native verified previous-uninstaller target', () => {
    it('passes the paired parent as _?= and never executes missing or conflicting targets', () => {
      const buildRoot = path.join(repositoryRoot, 'build');
      mkdirSync(buildRoot, { recursive: true });
      const fixture = mkdtempSync(path.join(buildRoot, 'installer-uninstall-target-'));
      const registryKey = `Software\\InstallerUninstallFixture-${randomUUID()}`;
      const customDirectory = path.join(fixture, 'stale-C');
      const actualDirectory = path.join(fixture, 'actual-D 安装 & %value% $literal');
      const missingDirectory = path.join(fixture, 'missing-extra-entry');
      const observedFile = path.join(fixture, 'child-observed.txt');
      const resultFile = path.join(fixture, 'result.txt');
      const exitNonzero = path.join(fixture, 'return-nonzero');
      const slowChild = path.join(fixture, 'slow-child');
      for (const directory of [customDirectory, actualDirectory]) mkdirSync(directory);
      const compile = (name: string, source: string): string => {
        const script = path.join(fixture, `${name}.nsi`);
        writeFileSync(script, source);
        const result = spawnSync(compiler!, ['/WX', '/V2', '/INPUTCHARSET', 'UTF8', script], {
          windowsHide: true, encoding: 'utf8', timeout: 15_000,
        });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        return path.join(fixture, `${name}.exe`);
      };
      try {
        const isolateRegistry = (source: string): string => source
          .replaceAll('HKLM "${INSTALL_REGISTRY_KEY}"', 'HKCU "${INSTALL_REGISTRY_KEY}\\machine"')
          .replaceAll('HKCU "${INSTALL_REGISTRY_KEY}"', 'HKCU "${INSTALL_REGISTRY_KEY}\\user"')
          .replaceAll('HKLM "${UNINSTALL_REGISTRY_KEY}"', 'HKCU "${UNINSTALL_REGISTRY_KEY}\\machine"')
          .replaceAll('HKCU "${UNINSTALL_REGISTRY_KEY}"', 'HKCU "${UNINSTALL_REGISTRY_KEY}\\user"');
        const upstreamAssisted = readFileSync(path.join(templates, 'assistedInstaller.nsh'), 'utf8');
        const safeUacPorts = (source: string): string => source
          .replaceAll('${UAC_IsAdmin}', '$FixtureAdmin == "1"')
          .replaceAll('${UAC_IsInnerInstance}', '$FixtureInner == "1"')
          .replaceAll('!insertmacro UAC_RunElevated', 'SetErrorLevel 91\nQuit');
        const multiUser = safeUacPorts(isolateRegistry(readFileSync(path.join(templates, 'multiUser.nsh'), 'utf8')));
        // Released uninstallers run initMultiUser and read InstallLocation again
        // after receiving _?=. Keep those real macros and registry reads; only
        // redirect their hives and forbid an unexpected elevation request.
        const creator = compile('create-harmless-uninstaller', [
          'Unicode true', 'SilentInstall silent', 'SilentUnInstall silent', 'RequestExecutionLevel user',
          `OutFile "${nsisLiteral(path.join(fixture, 'create-harmless-uninstaller.exe'))}"`,
          'Name "Harmless uninstaller target fixture"',
          `!addincludedir "${nsisLiteral(path.join(templates, 'include'))}"`,
          `!addplugindir "${nsisLiteral(plugins!)}"`,
          '!include "LogicLib.nsh"', '!include "StdUtils.nsh"', '!include "x64.nsh"', '!include "WinMessages.nsh"',
          '!define BUILD_UNINSTALLER', '!define INSTALL_MODE_PER_ALL_USERS_REQUIRED',
          '!define APP_FILENAME "Wedax"',
          `!define INSTALL_REGISTRY_KEY "${registryKey}\\product"`,
          `!define UNINSTALL_REGISTRY_KEY "${registryKey}\\arp"`,
          'Var FixtureAdmin', 'Var FixtureInner', multiUser,
          safeUacPorts(sourceMacro(upstreamAssisted, 'initMultiUser')),
          'Function un.onInit', '  SetRegView 64', '  StrCpy $FixtureAdmin "1"',
          '  StrCpy $FixtureInner "0"', '  !insertmacro initMultiUser', 'FunctionEnd',
          'Section',
          `  WriteUninstaller "${nsisLiteral(path.join(actualDirectory, 'Uninstall Wedax.exe'))}"`,
          'SectionEnd', 'Section "Uninstall"',
          // NSIS consumes _?= before exposing $CMDLINE; record the Win32 command
          // line as well as the resulting $INSTDIR to exercise the real handoff.
          "  System::Call 'kernel32::GetCommandLineW()w.r1'",
          `  FileOpen $0 "${nsisLiteral(observedFile)}" a`,
          '  FileSeek $0 0 END',
          String.raw`  FileWriteUTF16LE $0 "$INSTDIR$\r$\n$1$\r$\n"`,
          '  FileClose $0',
          '  IfFileExists "@SLOW@" 0 +2', '    Sleep 1700',
          `  \${If} \${FileExists} "${nsisLiteral(exitNonzero)}"`,
          '    SetErrorLevel 17', '  ${Else}', '    SetErrorLevel 0', '  ${EndIf}', 'SectionEnd',
        ].join('\n').replace('@SLOW@', nsisLiteral(slowChild)));
        const created = spawnSync(creator, [], { windowsHide: true, encoding: 'utf8', timeout: 10_000 });
        expect(created.status, `${created.stdout}\n${created.stderr}`).toBe(0);
        expect(existsSync(path.join(actualDirectory, 'Uninstall Wedax.exe'))).toBe(true);

        const composed = createWindowsInstallerScript(templates);
        const lookup = isolateRegistry(readFileSync(path.join(repositoryRoot, 'scripts/packaging/nsis-existing-installation.nsh'), 'utf8'));
        const previousUninstaller = readFileSync(path.join(repositoryRoot, 'scripts/packaging/nsis-previous-uninstaller.nsh'), 'utf8')
          .replace('${IfNot} ${Silent}', '${If} $ProbeCase != "uninstaller-nonzero"')
          .replace('${If} ${Silent}\n    System::Call', '${If} $ProbeCase != "slow-uninstaller"\n    System::Call')
          .replace(/^[ \t]*MessageBox MB_RETRYCANCEL[^\r\n]*/m, [
            '    ${If} $ProbeCase == "retry-failed-current-user-scope"',
            '    ${OrIf} $ProbeCase == "retry-target-replaced"',
            '    ${OrIf} $ProbeCase == "retry-registration-removed"',
            '      ${If} $ProbeCase == "retry-target-replaced"',
            '        Rename "$InstallerOldIdentityPath" "$InstallerOldIdentityPath.original"',
            '        CopyFiles /SILENT "$InstallerOldIdentityPath.original" "$InstallerOldIdentityPath"',
            '      ${ElseIf} $ProbeCase == "retry-registration-removed"',
            '        DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY}\\user" UninstallString',
            '      ${EndIf}',
            '      Delete "@EXIT_SENTINEL@"',
            '      Goto InstallerOldRetryAccepted',
            '    ${Else}',
            '      Goto InstallerOldRetryDone',
            '    ${EndIf}',
          ].join('\n').replace('@EXIT_SENTINEL@', nsisLiteral(exitNonzero)));
        // Redirect only registry IO to the random fixture HKCU key; retain the
        // production root-selection branches and actual uninstaller execution.
        const readReg = sourceMacro(composed, 'readReg')
          .replace('ReadRegStr "${VAR}" SHELL_CONTEXT "${SUB_KEY}"', 'ReadRegStr "${VAR}" HKCU "${SUB_KEY}\\$ProbeShellScope"')
          .replace('ReadRegStr "${VAR}" HKEY_CURRENT_USER "${SUB_KEY}"', 'ReadRegStr "${VAR}" HKCU "${SUB_KEY}\\user"')
          .replace('ReadRegStr "${VAR}" HKEY_LOCAL_MACHINE "${SUB_KEY}"', 'ReadRegStr "${VAR}" HKCU "${SUB_KEY}\\machine"');
        const uninstall = isolateRegistry(sourceFunction(composed, 'uninstallOldVersion'))
          .replace(/^(\s*)WriteRegStr HKCU "\$\{INSTALL_REGISTRY_KEY\}\\(?:machine|user)" InstallLocation "\$installationDir"$/gm,
            line => ['  IntOp $ProbeCorrections $ProbeCorrections + 1',
              '  ${If} $ProbeCase == "registration-write-denied"', '    SetErrors',
              '  ${Else}', line, '  ${EndIf}'].join('\n'))
          .replace('StrCpy $uninstallerFileNameTemp "$PLUGINSDIR\\old-$InstallerLookupMode-$InstallerOldAttempt.exe"', [
            'StrCpy $uninstallerFileNameTemp "$PLUGINSDIR\\old-$InstallerLookupMode-$InstallerOldAttempt.exe"',
            '  IntOp $ProbeCopies $ProbeCopies + 1',
            '  ${If} $ProbeCase == "copy-failure-with-existing-file"',
            '    CopyFiles /SILENT "$uninstallerFileName" "$uninstallerFileNameTemp"',
            '  ${EndIf}',
          ].join('\n'))
          .replace('StrCmp $1 0 InstallerPreviousUninstallCopyFailed', [
            'StrCmp $1 0 InstallerPreviousUninstallCopyFailed',
            '  ${If} $ProbeCase == "copied-uninstaller-cannot-start"',
            '    Delete "$uninstallerFileNameTemp"',
            '  ${EndIf}',
          ].join('\n'));
        const initializers = scenarios.flatMap(scenario => [
          `  \${If} $ProbeCase == "${scenario.id}"`,
          `    StrCpy $installMode "${scenario.mode}"`, `    StrCpy $ProbeRootKey "${scenario.rootKey}"`,
          `    StrCpy $ProbeShellScope "${scenario.mode === 'all' ? 'machine' : 'user'}"`,
          `    StrCpy $ProbeLookupScope "${scenario.rootKey === 'HKEY_CURRENT_USER' ? 'user' : scenario.mode === 'all' ? 'machine' : 'user'}"`,
          `    WriteRegStr HKCU "\${INSTALL_REGISTRY_KEY}\\$ProbeLookupScope" InstallLocation "${nsisLiteral(scenario.id === 'already-paired-does-not-write' ? actualDirectory : customDirectory)}"`,
          ...(scenario.arp !== 'absent' ? [
            `    WriteRegStr HKCU "\${UNINSTALL_REGISTRY_KEY}\\$ProbeLookupScope" UninstallString '$\\"${nsisLiteral(path.join(scenario.arp === 'actual' ? actualDirectory : missingDirectory, 'Uninstall Wedax.exe'))}$\\" /existing-arp-option'`,
          ] : []),
          '  ${EndIf}',
        ]);
        const probe = compile('probe', [
          'Unicode true', 'SilentInstall silent', 'RequestExecutionLevel user',
          `OutFile "${nsisLiteral(path.join(fixture, 'probe.exe'))}"`, 'Name "Verified uninstall target fixture"',
          `!addincludedir "${nsisLiteral(path.join(templates, 'include'))}"`,
          `!addplugindir "${nsisLiteral(plugins!)}"`,
          '!include "LogicLib.nsh"', '!include "FileFunc.nsh"', '!include "StdUtils.nsh"',
          '!define APP_EXECUTABLE_FILENAME "Wedax.exe"', '!define UNINSTALL_FILENAME "Uninstall Wedax.exe"',
          `!define INSTALL_REGISTRY_KEY "${registryKey}\\product"`,
          `!define UNINSTALL_REGISTRY_KEY "${registryKey}\\arp"`,
          '!define isDeleteAppData \'$ProbeDeleteAppData == "1"\'',
          ...['installMode', 'appExe', 'ProbeCase', 'ProbeRootKey', 'ProbeErrors', 'ProbeDeleteAppData',
            'ProbeShellScope', 'ProbeLookupScope', 'ProbeCorrections', 'ProbeCopies', 'ProbeWaitSeconds']
            .map(name => `Var ${name}`),
          '!macro JustDoLogInstallEvent TEXT', '  DetailPrint "${TEXT}"', '  ClearErrors', '!macroend',
          '!macro InstallerShowPreviousWait SECONDS', '  StrCpy $ProbeWaitSeconds "${SECONDS}"', '!macroend',
          '!macro InstallerShowCorePhase ZH EN', '!macroend',
          '!macro InstallerPreviousRetryText TARGET ZH EN', '  StrCpy ${TARGET} "${EN}"', '!macroend',
          '!macro InstallerShowPreviousFailure', '!macroend',
          'Var InstallerOldChildActive',
          previousUninstaller, lookup, sourceFunction(composed, 'GetInQuotes'), sourceMacro(composed, 'GetInQuotes'),
          readReg, 'Var isTryToKeepShortcuts',
          sourceMacro(composed, 'setIsTryToKeepShortcuts'), uninstall,
          'Function .onInit', '  InitPluginsDir', '  SetRegView 64', '  SetShellVarContext current',
          `  DeleteRegKey HKCU "${registryKey}"`,
          '  ${GetParameters} $0', '  ${GetOptions} $0 "/case=" $ProbeCase',
          '  StrCpy $ProbeDeleteAppData "0"', '  StrCpy $ProbeCorrections "0"', '  StrCpy $ProbeCopies "0"',
          ...initializers, 'FunctionEnd',
          'Section', `  StrCpy $appExe "${nsisLiteral(path.join(actualDirectory, 'Wedax.exe'))}"`,
          '  Push "$ProbeRootKey"', '  Call uninstallOldVersion',
          '  StrCpy $ProbeErrors "0"', '  IfErrors 0 +2', '    StrCpy $ProbeErrors "1"',
          `  FileOpen $3 "${nsisLiteral(resultFile)}" w`,
          String.raw`  FileWriteUTF16LE $3 "$ProbeErrors$\t$R0$\t$InstallerLookupMode$\t$InstallerLookupState$\r$\n"`,
          String.raw`  FileWriteUTF16LE $3 "$InstallerLookupDirectory$\r$\n$InstallerLookupUninstallDirectory$\r$\n"`,
          '  ReadRegStr $4 HKCU "${INSTALL_REGISTRY_KEY}\\$ProbeLookupScope" InstallLocation',
          String.raw`  FileWriteUTF16LE $3 "$4$\r$\n$ProbeCorrections$\r$\n$ProbeCopies$\r$\n"`,
          String.raw`  FileWriteUTF16LE $3 "$ProbeWaitSeconds$\r$\n"`,
          '  FileClose $3', `  DeleteRegKey HKCU "${registryKey}"`, '  SetErrorLevel 0', 'SectionEnd',
        ].join('\n'));

        for (const scenario of scenarios) {
          rmSync(observedFile, { force: true });
          if (scenario.id === 'slow-uninstaller') writeFileSync(slowChild, '');
          else rmSync(slowChild, { force: true });
          const childExit = ['uninstaller-nonzero', 'copied-uninstaller-cannot-start', 'no-embedded-retry-for-secondary-scope']
            .includes(scenario.id) ? 17 : 0;
          if (childExit !== 0 || scenario.id.startsWith('retry-')) writeFileSync(exitNonzero, '');
          else rmSync(exitNonzero, { force: true });
          for (const [directory, live] of [[customDirectory, scenario.customLive], [actualDirectory, scenario.arpLive]] as const) {
            const executable = path.join(directory, 'Wedax.exe');
            if (live) writeFileSync(executable, 'fixture executable');
            else rmSync(executable, { force: true });
          }
          const result = spawnSync(probe, [`/case=${scenario.id}`], {
            windowsHide: true, encoding: 'utf8', timeout: 15_000,
          });
          expect(result.status, `${scenario.id}: ${result.stdout}\n${result.stderr}`).toBe(0);
          const lines = readFileSync(resultFile, 'utf16le').split(/\r?\n/);
          const mode = scenario.rootKey === 'HKEY_CURRENT_USER' ? 'CurrentUser' : scenario.mode;
          const stateAfterLookup = scenario.id === 'retry-registration-removed' ? 'confirmed' : scenario.state;
          expect(lines[0], `${scenario.id}: ${JSON.stringify(lines)}, child=${existsSync(observedFile)}`)
            .toBe(`${scenario.error ? 1 : 0}\t${childExit}\t${scenario.arp === 'absent' ? '' : mode}\t${stateAfterLookup}`);
          expect(lines[1], scenario.id).toBe(scenario.state === 'confirmed'
            ? (scenario.customLive ? customDirectory : actualDirectory) : '');
          expect(lines[2], scenario.id).toBe(scenario.executes || scenario.id === 'registration-write-denied' ? actualDirectory : '');
          expect(lines[3], `${scenario.id}: child=${existsSync(observedFile) ? readFileSync(observedFile, 'utf16le') : 'none'}`)
            .toBe(scenario.executes ? actualDirectory : customDirectory);
          expect(lines[4], scenario.id).toBe(String(scenario.corrections));
          const retrySuccess = scenario.id === 'retry-failed-current-user-scope';
          expect(lines[5], scenario.id).toBe(retrySuccess ? '2' : scenario.executes ? '1' : '0');
          if (scenario.id === 'slow-uninstaller') expect(Number(lines[6])).toBeGreaterThanOrEqual(1);
          expect(existsSync(observedFile), scenario.id).toBe(scenario.executes);
          if (scenario.executes) {
            const invocations = readFileSync(observedFile, 'utf16le').trimEnd().split(/\r?\n/);
            expect(invocations, scenario.id).toHaveLength(retrySuccess ? 4 : 2);
            const [directory, command] = invocations;
            expect(directory, scenario.id).toBe(actualDirectory);
            expect(command, scenario.id).toContain(`_?=${actualDirectory}`);
            expect(command, scenario.id).toContain('/KEEP_APP_DATA');
            expect(command, scenario.id).toContain(mode === 'all' ? '/allusers' : '/currentuser');
            expect(command, scenario.id).not.toContain(mode === 'all' ? '/currentuser' : '/allusers');
            expect(command, scenario.id).toContain('--updated');
            expect(command, scenario.id).not.toContain('--delete-app-data');
            const inPlace = scenario.id === 'copied-uninstaller-cannot-start' || scenario.id === 'copy-failure-with-existing-file';
            expect(command, scenario.id).toContain(inPlace
              ? path.join(actualDirectory, 'Uninstall Wedax.exe') : `old-${mode}-1.exe`);
            if (retrySuccess) {
              expect(invocations[2]).toBe(actualDirectory);
              expect(invocations[3]).toContain('old-CurrentUser-2.exe');
              expect(invocations[3]).toContain('/currentuser');
              expect(invocations[3]).not.toContain('/allusers');
            }
          }
          expect(existsSync(path.join(actualDirectory, 'Uninstall Wedax.exe'))).toBe(true);
        }
      } finally {
        spawnSync('reg.exe', ['delete', `HKCU\\${registryKey}`, '/f', '/reg:64'], {
          windowsHide: true, timeout: 5_000, stdio: 'ignore',
        });
        expect(path.dirname(path.resolve(fixture))).toBe(buildRoot);
        rmSync(fixture, { recursive: true, force: true });
      }
    }, 90_000);
  },
);
