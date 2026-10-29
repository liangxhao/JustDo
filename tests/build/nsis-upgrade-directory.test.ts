import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(__dirname, '../..');
const cacheRoot = process.env.ELECTRON_BUILDER_CACHE ||
  path.join(process.env.LOCALAPPDATA || '', 'electron-builder/Cache');
const compiler = [
  path.join(cacheRoot, 'nsis/nsis-3.0.4.1/makensis.exe'),
  path.join(cacheRoot, 'nsis/nsis-3.0.4.1/Bin/makensis.exe'),
].find(candidate => existsSync(candidate));
const installer = readFileSync(
  path.join(repositoryRoot, 'scripts/packaging/nsis-installer.nsh'), 'utf8',
);
const upstream = readFileSync(
  path.join(repositoryRoot, 'node_modules/app-builder-lib/templates/nsis/assistedInstaller.nsh'), 'utf8',
);
const installerText = readFileSync(
  path.join(repositoryRoot, 'scripts/packaging/nsis-install-presentation.nsh'), 'utf8',
).match(/!macro InstallerText\b[^]*?!macroend/)?.[0];
if (!installerText) throw new Error('Installer text macro missing');

function sourceFunction(source: string, name: string): string {
  const result = source.match(new RegExp(`Function ${name}\\b[^]*?FunctionEnd`));
  if (!result) throw new Error(`Installer function missing: ${name}`);
  return result[0];
}

const nsisPath = (value: string): string => value.replaceAll('$', () => '$$');
const scenarios = [
  { id: 'fresh-current', mode: 'CurrentUser', user: false, machine: false },
  { id: 'upgrade-current', mode: 'CurrentUser', user: true, machine: true },
  { id: 'upgrade-current-zh', mode: 'CurrentUser', user: true, machine: false, language: 2052 },
  { id: 'upgrade-all-inner', mode: 'all', user: true, machine: true, inner: true },
  { id: 'fresh-all-with-user-install', mode: 'all', user: true, machine: false },
  { id: 'updated-skip', mode: 'CurrentUser', user: true, machine: false, updated: true },
  { id: 'back-switch-to-fresh', mode: 'CurrentUser', user: true, machine: false, back: true },
] as const;

describe.runIf(process.platform === 'win32' && Boolean(compiler))('native installer upgrade directory', () => {
  it('locks the selected installation, preserves its exact path, and unlocks first installs', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'installer-directory-'));
    const registryKey = `Software\\InstallerDirectoryFixture-${randomUUID()}`;
    const registeredUser = path.join(root, '已安装 软件 & %value% $literal', 'Legacy User Folder');
    const registeredMachine = path.join(root, '机器 软件', 'Legacy Machine Folder');
    const candidate = path.join(root, 'command-line override');
    const selection = path.join(root, 'new selection');
    for (const directory of [registeredUser, registeredMachine, candidate, selection]) {
      mkdirSync(directory, { recursive: true });
    }
    try {
      // Keep the production resolver, callbacks and upstream first-install
      // normalizer. Map the machine read to a private HKCU fixture subkey so
      // this executable never needs elevation or touches a product registry key.
      const policy = [
        sourceFunction(installer, 'InstallerRestoreUpgradeDirectory')
          .replace('HKLM "${INSTALL_REGISTRY_KEY}"', 'HKCU "${INSTALL_REGISTRY_KEY}\\machine"')
          .replace('HKCU "${INSTALL_REGISTRY_KEY}"', 'HKCU "${INSTALL_REGISTRY_KEY}\\user"'),
        sourceFunction(installer, 'InstallerDirectoryPre'),
        sourceFunction(installer, 'InstallerDirectoryShow'),
        sourceFunction(installer, 'JustDoInstFilesPre')
          .replaceAll('${UAC_IsInnerInstance}', '$ProbeInner == "1"'),
        sourceFunction(upstream, 'instFilesPre'),
      ].join('\n');
      const initializers = scenarios.map(scenario => [
        `\${If} $ProbeCase == "${scenario.id}"`,
        `StrCpy $installMode "${scenario.mode}"`,
        `StrCpy $LANGUAGE ${'language' in scenario ? scenario.language : 1033}`,
        `StrCpy $ProbeInner "${Number('inner' in scenario && scenario.inner)}"`,
        `StrCpy $ProbeUpdated "${Number('updated' in scenario && scenario.updated)}"`,
        `StrCpy $ProbeBack "${Number('back' in scenario && scenario.back)}"`,
        ...(scenario.user ? [`WriteRegStr HKCU "\${INSTALL_REGISTRY_KEY}\\user" InstallLocation "${nsisPath(registeredUser)}"`] : []),
        ...(scenario.machine ? [`WriteRegStr HKCU "\${INSTALL_REGISTRY_KEY}\\machine" InstallLocation "${nsisPath(registeredMachine)}"`] : []),
        '\${EndIf}',
      ].join('\n')).join('\n');
      const source = [
        'Unicode true', 'RequestExecutionLevel user',
        '!include "MUI2.nsh"', '!include "FileFunc.nsh"', '!include "LogicLib.nsh"',
        '!include "nsDialogs.nsh"',
        `!include "${path.join(repositoryRoot, 'node_modules/app-builder-lib/templates/nsis/include/StrContains.nsh')}"`,
        `OutFile "${nsisPath(path.join(root, 'directory.exe'))}"`,
        'Name "Directory policy fixture"', '!define APP_FILENAME "DirectoryFixture"',
        '!define PRODUCT_NAME "DirectoryFixture"',
        '!define JUSTDO_LANG_SIMPCHINESE 2052', '!define JUSTDO_LANG_TRADCHINESE 1028',
        '!define JUSTDO_WM_SETTEXT 0x000C', installerText,
        `!define INSTALL_REGISTRY_KEY "${registryKey}"`,
        '!define isUpdated \'$ProbeUpdated == "1"\'',
        'Var InstallerUpgradeDirectory', 'Var installMode', 'Var JustDoInstallMode',
        'Var ProbeCase', 'Var ProbeInner', 'Var ProbeUpdated', 'Var ProbeBack',
        'Var ProbeModeVisits', 'Var ProbeDirectoryVisits', 'Var ProbeProcessChecks',
        'Page custom ProbeModePage',
        '!define MUI_PAGE_CUSTOMFUNCTION_PRE InstallerDirectoryPre',
        '!define MUI_PAGE_CUSTOMFUNCTION_SHOW ProbeDirectoryShow',
        '!insertmacro MUI_PAGE_DIRECTORY',
        'Page custom ProbeFinal', 'Page instfiles', '!insertmacro MUI_LANGUAGE "English"',
        '!insertmacro MUI_LANGUAGE "SimpChinese"',
        '!macro JustDoLogInstallEvent TEXT', 'DetailPrint "${TEXT}"', '!macroend',
        'Function InstallerSetupDirectoryShow', 'FunctionEnd',
        'Function JustDoCheckAppRunning', 'IntOp $ProbeProcessChecks $ProbeProcessChecks + 1', 'FunctionEnd',
        policy,
        'Function .onInit', 'SetRegView 64',
        '${GetParameters} $0', '${GetOptions} $0 "/case=" $ProbeCase',
        'DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"',
        'StrCpy $ProbeModeVisits 0', 'StrCpy $ProbeDirectoryVisits 0', 'StrCpy $ProbeProcessChecks 0',
        `StrCpy $INSTDIR "${nsisPath(candidate)}"`,
        initializers, 'FunctionEnd',
        'Function ProbeModePage',
        'IntOp $ProbeModeVisits $ProbeModeVisits + 1',
        '${If} $ProbeBack == "1"', '${AndIf} $ProbeModeVisits == "2"',
        'StrCpy $installMode "all"', `StrCpy $INSTDIR "${nsisPath(candidate)}"`, '${EndIf}',
        'nsDialogs::Create 1018', 'Pop $0',
        'System::Call \'user32::PostMessageW(p $HWNDPARENT, i ${WM_COMMAND}, p 1, p 0)i\'', 'nsDialogs::Show', 'FunctionEnd',
        'Function ProbeDirectoryShow',
        'Call InstallerDirectoryShow', 'IntOp $ProbeDirectoryVisits $ProbeDirectoryVisits + 1',
        'System::Call \'user32::IsWindowEnabled(p $mui.DirectoryPage.Directory)i.r0\'',
        'System::Call \'user32::IsWindowEnabled(p $mui.DirectoryPage.BrowseButton)i.r1\'',
        '${NSD_GetText} $mui.DirectoryPage.Directory $2',
        `FileOpen $3 "${nsisPath(path.join(root, 'result.txt'))}" a`,
        'FileSeek $3 0 END',
        String.raw`FileWriteUTF16LE $3 "page$\t$installMode$\t$INSTDIR$\t$2$\t$0$\t$1$\r$\n"`,
        'FileClose $3',
        '${NSD_GetText} $mui.Header.Text $4',
        '${NSD_GetText} $mui.Header.SubText $5',
        '${NSD_GetText} $mui.DirectoryPage.Text $6',
        `FileOpen $3 "${nsisPath(path.join(root, 'copy-'))}$ProbeDirectoryVisits.txt" w`,
        String.raw`FileWriteUTF16LE $3 "$4$\r$\n$5$\r$\n$6"`,
        'FileClose $3',
        '${If} $ProbeBack == "1"', '${AndIf} $ProbeDirectoryVisits == "1"',
        'System::Call \'user32::PostMessageW(p $HWNDPARENT, i ${WM_COMMAND}, p 3, p 0)i\'',
        '${Else}',
        // Changing even a disabled edit simulates a late directory override.
        // The install-page callback must restore a registered location again.
        `SendMessage $mui.DirectoryPage.Directory \${WM_SETTEXT} 0 "STR:${nsisPath(selection)}"`,
        'System::Call \'user32::PostMessageW(p $HWNDPARENT, i ${WM_COMMAND}, p 1, p 0)i\'', '${EndIf}', 'FunctionEnd',
        'Function ProbeFinal', 'Call JustDoInstFilesPre',
        `FileOpen $0 "${nsisPath(path.join(root, 'result.txt'))}" a`,
        'FileSeek $0 0 END',
        String.raw`FileWriteUTF16LE $0 "final$\t$INSTDIR$\t$JustDoInstallMode$\t$ProbeProcessChecks$\r$\n"`,
        'FileClose $0', 'SetErrorLevel 0', 'Quit', 'FunctionEnd',
        'Function .onGUIEnd', 'DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"', 'FunctionEnd',
        // Never install payloads, launch the product or enter an install section.
        'Section', 'SetErrorLevel 9', 'SectionEnd',
      ].join('\n');
      const scriptPath = path.join(root, 'directory.nsi');
      writeFileSync(scriptPath, source);
      const compilation = spawnSync(compiler!, ['/WX', '/V2', '/INPUTCHARSET', 'UTF8', scriptPath], {
        encoding: 'utf8', windowsHide: true, timeout: 15_000,
      });
      expect(compilation.status, `${compilation.stdout}\n${compilation.stderr}`).toBe(0);
      for (const scenario of scenarios) {
        rmSync(path.join(root, 'result.txt'), { force: true });
        const run = spawnSync(path.join(root, 'directory.exe'), [`/case=${scenario.id}`], {
          windowsHide: true, timeout: 10_000,
        });
        expect(run.status, `${scenario.id}: ${run.error || ''}`).toBe(0);
        const lines = readFileSync(path.join(root, 'result.txt'), 'utf16le').trimEnd().split('\r\n');
        const isBack = 'back' in scenario && scenario.back;
        const isUpdated = 'updated' in scenario && scenario.updated;
        const mode = isBack ? 'all' : scenario.mode;
        const registered = mode === 'all'
          ? (scenario.machine ? registeredMachine : undefined)
          : (scenario.user ? registeredUser : undefined);
        const pages = isUpdated ? [] : [
          ...(isBack ? [`page\tCurrentUser\t${registeredUser}\t${registeredUser}\t0\t0`] : []),
          `page\t${mode}\t${registered || candidate}\t${registered || candidate}\t${Number(!registered)}\t${Number(!registered)}`,
        ];
        expect(lines, scenario.id).toEqual([
          ...pages,
          `final\t${registered || path.join(selection, 'DirectoryFixture')}\t${mode}\t${Number('inner' in scenario && scenario.inner)}`,
        ]);
        const pageRegistrations = isUpdated ? [] : [
          ...(isBack ? [registeredUser] : []),
          registered,
        ];
        for (const [index, pageRegistration] of pageRegistrations.entries()) {
          const copy = readFileSync(path.join(root, `copy-${index + 1}.txt`), 'utf16le');
          if (pageRegistration) {
            const chinese = 'language' in scenario && scenario.language === 2052;
            expect(copy).toContain(chinese ? '确认升级位置' : 'Confirm upgrade location');
            expect(copy).toContain(chinese ? '无法更改安装位置' : 'The location cannot be changed.');
            expect(copy).toContain(chinese ? '将 DirectoryFixture 升级' : 'Upgrade DirectoryFixture');
            expect(copy).not.toMatch(/Browse|浏览/);
          } else {
            expect(copy).toContain('Choose Install Location');
            expect(copy).toContain('Browse');
            expect(copy).not.toContain('The location cannot be changed.');
          }
        }
      }
    } finally {
      spawnSync('reg.exe', ['delete', `HKCU\\${registryKey}`, '/f', '/reg:64'], {
        windowsHide: true, timeout: 5_000, stdio: 'ignore',
      });
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
