import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const cache = process.env.ELECTRON_BUILDER_CACHE || path.join(process.env.LOCALAPPDATA || '', 'electron-builder/Cache');
const compiler = path.join(cache, 'nsis/nsis-3.0.4.1/makensis.exe');
const plugins = path.join(cache, 'nsis/nsis-resources-3.4.1/plugins/x86-unicode');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const nsisPath = (value: string): string => value.replaceAll('$', () => '$$');
const macro = (name: string): string => '$' + '{' + name + '}';
const crlf = '$\\r$\\n';
function sourceFunction(source: string, name: string): string {
  const result = source.match(new RegExp('Function ' + name + '\\b[^]*?FunctionEnd'))?.[0];
  if (!result) throw new Error('Installer function missing: ' + name);
  return result;
}

describe.runIf(process.platform === 'win32' && existsSync(compiler)
  && process.env.INSTALLER_PRESENTATION_NATIVE_UI === '1')('native combined installer setup', () => {
  it('shows one scope-and-directory page, preserves path policy and enters installation without moving the window', () => {
    const buildRoot = path.join(repoRoot, 'build');
    mkdirSync(buildRoot, { recursive: true });
    const root = mkdtempSync(path.join(buildRoot, 'installer-setup-test-'));
    const literal = (name: string): string => nsisPath(path.join(root, name));
    const registryKey = 'Software\\InstallerSetupFixture-' + randomUUID();
    try {
      const definitions = require('../../scripts/packaging/installer-animation-script.cjs').prepareInstallerAnimationScript(repoRoot);
      const hero = require('../../scripts/packaging/installer-animation-assets.cjs').ANIMATION_CONTRACT.scales.find((scale: { percent: number }) => scale.percent === 100);
      const clock = require('../../scripts/packaging/installer-clock-assets.cjs').prepareInstallerClockAssets(repoRoot);
      const productName = require('../../package.json').productName;
      const installer = readFileSync(path.join(repoRoot, 'scripts/packaging/nsis-installer.nsh'), 'utf8');
      const upstream = readFileSync(path.join(repoRoot, 'node_modules/app-builder-lib/templates/nsis/assistedInstaller.nsh'), 'utf8');
      const combined = readFileSync(path.join(repoRoot, 'scripts/packaging/nsis-setup-presentation.nsh'), 'utf8');
      const lookup = readFileSync(path.join(repoRoot, 'scripts/packaging/nsis-existing-installation.nsh'), 'utf8');
      writeFileSync(path.join(root, 'lookup-fixture.nsh'), lookup
        .replaceAll('HKLM "' + macro('INSTALL_REGISTRY_KEY') + '"', 'HKCU "' + macro('INSTALL_REGISTRY_KEY') + '\\machine"')
        .replaceAll('HKCU "' + macro('INSTALL_REGISTRY_KEY') + '"', 'HKCU "' + macro('INSTALL_REGISTRY_KEY') + '\\user"')
        .replaceAll('HKLM "' + macro('UNINSTALL_REGISTRY_KEY') + '"', 'HKCU "' + macro('UNINSTALL_REGISTRY_KEY') + '\\machine"')
        .replaceAll('HKCU "' + macro('UNINSTALL_REGISTRY_KEY') + '"', 'HKCU "' + macro('UNINSTALL_REGISTRY_KEY') + '\\user"'));
      expect(combined.match(/^\s*nsDialogs::Show\s*$/gm)).toHaveLength(1);
      // Run actual production callbacks; isolate only account/UAC ports.
      writeFileSync(path.join(root, 'combined-fixture.nsh'), combined
        .replace('"' + macro('PROJECT_DIR') + '\\scripts\\packaging\\nsis-existing-installation.nsh"', '"' + literal('lookup-fixture.nsh') + '"')
        .replaceAll('HKLM "' + macro('INSTALL_REGISTRY_KEY') + '"', 'HKCU "' + macro('INSTALL_REGISTRY_KEY') + '\\machine"')
        .replaceAll('HKCU "' + macro('INSTALL_REGISTRY_KEY') + '"', 'HKCU "' + macro('INSTALL_REGISTRY_KEY') + '\\user"')
        .replace(/^\s*nsDialogs::Show\s*$/m, '\n  Call FixtureCombinedObserved\n  nsDialogs::Show')
        .replace('  InstallerCombinedScopeDone:', '  InstallerCombinedScopeDone:\n  Call FixtureScopeObserved'));
      const resolver = sourceFunction(installer, 'InstallerRestoreUpgradeDirectory')
        .replace('HKLM "' + macro('INSTALL_REGISTRY_KEY') + '"', 'HKCU "' + macro('INSTALL_REGISTRY_KEY') + '\\machine"')
        .replace('HKCU "' + macro('INSTALL_REGISTRY_KEY') + '"', 'HKCU "' + macro('INSTALL_REGISTRY_KEY') + '\\user"');
      const proof = '$InstallerSetupReady|$InstallerSetupFont|$InstallerSetupTitleFont|$InstallerSetupLogo|$InstallerSetupBitmap|$InstallerSetupNextImage|$InstallerSetupCancelImage|$InstallerSetupBrowseImage|$InstallerCombinedDirectorySurface';
      const source = [
        'Unicode true', 'RequestExecutionLevel user', 'ShowInstDetails show',
        'Name "' + productName + '"', 'Caption "Installer setup fixture"', 'OutFile "' + literal('wizard.exe') + '"',
        '!addplugindir /x86-unicode "' + nsisPath(plugins) + '"',
        '!include "MUI2.nsh"', '!include "LogicLib.nsh"', '!include "FileFunc.nsh"',
        '!include "' + nsisPath(path.join(repoRoot, 'node_modules/app-builder-lib/templates/nsis/include/StdUtils.nsh')) + '"',
        '!include "' + nsisPath(path.join(repoRoot, 'node_modules/app-builder-lib/templates/nsis/include/StrContains.nsh')) + '"',
        '!define PROJECT_DIR "' + nsisPath(repoRoot) + '"', '!define PRODUCT_NAME "' + productName + '"',
        '!define APP_FILENAME "' + productName + '"', '!define INSTALL_REGISTRY_KEY "' + registryKey + '"',
        '!define APP_EXECUTABLE_FILENAME "' + productName + '.exe"', '!define UNINSTALL_FILENAME "Uninstall ' + productName + '.exe"',
        '!define UNINSTALL_REGISTRY_KEY "' + registryKey + '\\uninstall"',
        '!define MUI_ICON "' + nsisPath(path.join(repoRoot, 'resources/icons/win/icon.ico')) + '"',
        '!define JUSTDO_LANG_SIMPCHINESE 2052', '!define JUSTDO_LANG_TRADCHINESE 1028',
        '!define JUSTDO_WM_SETTEXT 0x000C', '!define JUSTDO_WM_SETREDRAW 0x000B',
        '!define JUSTDO_RDW_ATOMIC_REFRESH 0x0185', '!define JUSTDO_PBM_SETRANGE32 0x0406',
        '!define JUSTDO_PBM_SETPOS 0x0402', '!define JUSTDO_PBM_SETBARCOLOR 0x0409',
        '!define JUSTDO_PBM_SETBKCOLOR 0x2001', '!define MULTIUSER_INSTALLMODE_ALLOW_ELEVATION',
        '!define allowToChangeInstallationDirectory',
        '!define UAC_IsInnerInstance \'$FixtureInner == "1"\'', '!define UAC_IsAdmin \'$FixtureAdmin == "1"\'',
        '!define isForAllUsers \'$FixtureForceMachine == "1"\'', '!define isForCurrentUser \'$FixtureForceCurrent == "1"\'',
        '!define isUpdated \'$FixtureUpdated == "1"\'',
        ...['FixtureCase', 'FixtureInner', 'FixtureAdmin', 'FixtureForceMachine', 'FixtureForceCurrent',
          'FixtureUpdated', 'FixtureSetupVisits', 'FixtureOriginalFont', 'FixtureProcessChecks', 'FixtureScopeEvents', 'FixtureBridgeValue', 'FixtureBridgeFailure', 'InstallerUpgradeDirectory',
          'installMode', 'hasPerUserInstallation', 'hasPerMachineInstallation', 'perUserInstallationFolder',
          'perMachineInstallationFolder', 'JustDoInstallMode', 'JustDoInstFilesPage', 'JustDoInstallLog',
          'JustDoShowLogButton', 'JustDoProgressBar', 'JustDoNativeProgressBar', 'JustDoStatusText',
          'JustDoExtractorActive'].map(name => 'Var ' + name),
        '!define MUI_CUSTOMFUNCTION_GUIINIT FixtureGuiInit',
        '!macro UAC_RunElevated', '  Call FixtureElevation', '!macroend',
        '!macro UAC_AsUser_GetGlobal OUT VALUE', '  StrCpy $FixtureBridgeValue ' + macro('VALUE'),
        ...Array.from({ length: 10 }, (_, index) => '  StrCpy $' + index + ' ' + (21000 + index)),
        ...Array.from({ length: 10 }, (_, index) => '  StrCpy $R' + index + ' ' + (22000 + index)),
        '  !if "' + macro('VALUE') + '" == "$HWNDPARENT"', '    SetErrors', '  !else',
        '    ' + macro('If') + ' $FixtureBridgeFailure == "1"', '      SetErrors',
        '    ' + macro('Else'), '      ClearErrors', '    ' + macro('EndIf'), '  !endif',
        '  StrCpy ' + macro('OUT') + ' $FixtureBridgeValue', '!macroend',
        '!macro setInstallModePerUser', '  StrCpy $installMode "CurrentUser"', '  SetShellVarContext current',
        '  ReadRegStr $perUserInstallationFolder HKCU "' + macro('INSTALL_REGISTRY_KEY') + '\\user" InstallLocation',
        '  StrCpy $INSTDIR "' + literal('fresh location') + '"', '  ' + macro('If') + ' $perUserInstallationFolder != ""',
        '    StrCpy $INSTDIR "$perUserInstallationFolder"', '  ' + macro('EndIf'), '!macroend',
        '!macro setInstallModePerAllUsers', '  StrCpy $installMode "all"', '  SetShellVarContext all',
        '  ReadRegStr $perMachineInstallationFolder HKCU "' + macro('INSTALL_REGISTRY_KEY') + '\\machine" InstallLocation',
        '  StrCpy $INSTDIR "' + literal('machine location') + '"', '  ' + macro('If') + ' $perMachineInstallationFolder != ""',
        '    StrCpy $INSTDIR "$perMachineInstallationFolder"', '  ' + macro('EndIf'), '!macroend',
        '!macro JustDoSetInstallStatus ZH EN', '  !insertmacro InstallerText $JustDoStatusText "' + macro('ZH') + '" "' + macro('EN') + '"', '!macroend',
        '!macro JustDoAddInstallActivity ZH EN', '  DetailPrint "' + macro('EN') + '"', '!macroend',
        '!macro JustDoLogInstallEvent TEXT', '  ClearErrors', '!macroend',
        '!macro InstallerWindowDpi', '  ' + macro('If') + ' $FixtureCase == "short"', '    StrCpy $InstallerDpi 288',
        ...[[125, 120], [175, 168], [200, 192]].flatMap(([percent, dpi]) => [
          '  ' + macro('ElseIf') + ' $FixtureCase == "dpi' + percent + '"', '    StrCpy $InstallerDpi ' + dpi,
        ]),
        '  ' + macro('ElseIf') + ' $FixtureCase == "header-short"', '    StrCpy $InstallerDpi 192',
        '  ' + macro('ElseIf') + ' $FixtureCase == "compact"', '    StrCpy $InstallerDpi 192',
        '  ' + macro('EndIf'), '!macroend',
        '!macro InstallerWindowWorkArea', '  ' + macro('If') + ' $FixtureCase == "short"',
        '    ' + macro('If') + ' $InstallerWorkWidth > 1366', '      StrCpy $InstallerWorkWidth 1366', '    ' + macro('EndIf'),
        '    ' + macro('If') + ' $InstallerWorkHeight > 728', '      StrCpy $InstallerWorkHeight 728', '    ' + macro('EndIf'),
        '  ' + macro('ElseIf') + ' $FixtureCase == "header-short"',
        '    ' + macro('If') + ' $InstallerWorkHeight > 793', '      StrCpy $InstallerWorkHeight 793', '    ' + macro('EndIf'),
        '  ' + macro('ElseIf') + ' $FixtureCase == "compact"',
        '    ' + macro('If') + ' $InstallerWorkHeight > 941', '      StrCpy $InstallerWorkHeight 941', '    ' + macro('EndIf'),
        '  ' + macro('EndIf'), '!macroend',
        definitions, '!define INSTALLER_CLOCK_LIBRARY "' + nsisPath(clock.path) + '"',
        '!macro InstallerMotionTraceComplete', '  Push $0', '  FileOpen $0 "' + literal('motion.txt') + '" a',
        '  FileSeek $0 0 END', '  FileWrite $0 "$InstallerMotionKind' + crlf + '"', '  FileClose $0', '  Pop $0', '!macroend',
        '!include "' + nsisPath(path.join(repoRoot, 'scripts/packaging/nsis-install-presentation.nsh')) + '"',
        '!include "' + literal('combined-fixture.nsh') + '"', '!insertmacro InstallerSetupPage',
        '!define MUI_PAGE_CUSTOMFUNCTION_PRE FixtureProgressPre', '!define MUI_PAGE_CUSTOMFUNCTION_SHOW FixtureProgressShow',
        '!define MUI_PAGE_CUSTOMFUNCTION_LEAVE InstallerPresentationLeave', '!insertmacro MUI_PAGE_INSTFILES',
        '!insertmacro MUI_LANGUAGE "English"', '!insertmacro MUI_LANGUAGE "SimpChinese"',
        resolver, sourceFunction(upstream, 'instFilesPre'), sourceFunction(installer, 'JustDoInstFilesPre'),
        'Function JustDoCheckAppRunning', '  IntOp $FixtureProcessChecks $FixtureProcessChecks + 1', 'FunctionEnd',
        'Function .onInit', '  SetRegView 64', '  StrCpy $FixtureInner "0"', '  StrCpy $FixtureAdmin "0"',
        '  StrCpy $JustDoExtractorActive "0"', '  StrCpy $FixtureUpdated "0"',
        '  StrCpy $FixtureForceMachine "0"', '  StrCpy $FixtureForceCurrent "0"',
        '  StrCpy $FixtureSetupVisits "0"', '  StrCpy $FixtureProcessChecks "0"', '  StrCpy $FixtureScopeEvents "0"', '  StrCpy $FixtureBridgeFailure "0"',
        '  StrCpy $hasPerUserInstallation "0"', '  StrCpy $hasPerMachineInstallation "0"',
        '  StrCpy $perUserInstallationFolder ""', '  StrCpy $perMachineInstallationFolder ""',
        '  FileOpen $0 "' + literal('path-limit.txt') + '" w',
        '  FileWrite $0 "' + macro('INSTALLER_COMBINED_PATH_LIMIT') + '"', '  FileClose $0',
        '  DeleteRegKey HKCU "' + macro('INSTALL_REGISTRY_KEY') + '"',
        '  ' + macro('GetParameters') + ' $0', '  ' + macro('GetOptions') + ' $0 "/case=" $FixtureCase', '  StrCpy $LANGUAGE 2052',
        '  ' + macro('If') + ' $FixtureCase == "short"', '  ' + macro('OrIf') + ' $FixtureCase == "english"', '    StrCpy $LANGUAGE 1033', '  ' + macro('EndIf'),
        '  ' + macro('If') + ' $FixtureCase == "upgrade"', '  ' + macro('OrIf') + ' $FixtureCase == "both-all"',
        '    WriteRegStr HKCU "' + macro('INSTALL_REGISTRY_KEY') + '\\user" InstallLocation "' + literal('已安装 软件') + '"',
        '    WriteRegStr HKCU "' + macro('INSTALL_REGISTRY_KEY') + '\\machine" InstallLocation "' + literal('machine existing') + '"',
        '    StrCpy $hasPerUserInstallation "1"', '    StrCpy $hasPerMachineInstallation "1"',
        '  ' + macro('ElseIf') + ' $FixtureCase == "mixed-scope"',
        '    WriteRegStr HKCU "' + macro('INSTALL_REGISTRY_KEY') + '\\user" InstallLocation "' + literal('已安装 软件') + '"',
        '    StrCpy $hasPerUserInstallation "1"',
        '  ' + macro('ElseIf') + ' $FixtureCase == "upgrade-machine"',
        '    WriteRegStr HKCU "' + macro('INSTALL_REGISTRY_KEY') + '\\machine" InstallLocation "' + literal('machine existing') + '"',
        '    StrCpy $FixtureAdmin "1"', '  ' + macro('EndIf'),
        '  ' + macro('If') + ' $FixtureCase == "stale-user-live-machine"',
        '    WriteRegStr HKCU "' + macro('INSTALL_REGISTRY_KEY') + '\\user" InstallLocation "' + literal('stale location') + '"',
        '    WriteRegStr HKCU "' + macro('INSTALL_REGISTRY_KEY') + '\\machine" InstallLocation "' + literal('machine existing') + '"',
        '    StrCpy $FixtureAdmin "1"',
        '  ' + macro('ElseIf') + ' $FixtureCase == "recovered-location"',
        '    WriteRegStr HKCU "' + macro('INSTALL_REGISTRY_KEY') + '\\user" InstallLocation "' + literal('stale location') + '"',
        '    WriteRegStr HKCU "' + macro('UNINSTALL_REGISTRY_KEY') + '\\user" UninstallString \'"' + literal('已安装 软件\\Uninstall ' + productName + '.exe') + '" /currentuser\'',
        '  ' + macro('ElseIf') + ' $FixtureCase == "stale-only"',
        '    WriteRegStr HKCU "' + macro('INSTALL_REGISTRY_KEY') + '\\user" InstallLocation "' + literal('stale location') + '"',
        '  ' + macro('EndIf'),
        '  !insertmacro setInstallModePerUser',
        '  ' + macro('If') + ' $FixtureCase == "both-all"',
        '    !insertmacro setInstallModePerAllUsers', '    StrCpy $FixtureAdmin "1"',
        '  ' + macro('ElseIf') + ' $FixtureCase == "forced-current"', '    StrCpy $FixtureForceCurrent "1"',
        '  ' + macro('ElseIf') + ' $FixtureCase == "forced-all"', '    StrCpy $FixtureForceMachine "1"', '    !insertmacro setInstallModePerAllUsers',
        '  ' + macro('ElseIf') + ' $FixtureCase == "handoff"', '    StrCpy $FixtureForceMachine "1"', '    !insertmacro setInstallModePerAllUsers',
        '  ' + macro('ElseIf') + ' $FixtureCase == "inner"', '    StrCpy $FixtureInner "1"', '    StrCpy $FixtureAdmin "1"',
        // The elevated account's HKCU must not reselect the outer user's scope.
        '    WriteRegStr HKCU "' + macro('INSTALL_REGISTRY_KEY') + '\\user" InstallLocation "' + literal('已安装 软件') + '"',
        '    !insertmacro setInstallModePerAllUsers', '    StrCpy $InstallerCombinedSelectionReady "1"',
        '    StrCpy $InstallerCombinedSelectionPath "' + literal('selected machine') + '"',
        '  ' + macro('ElseIf') + ' $FixtureCase == "inner-denied"', '    StrCpy $FixtureInner "1"',
        '    StrCpy $InstallerCombinedSelectionReady "1"', '    StrCpy $InstallerCombinedSelectionPath "' + literal('selected machine') + '"',
        '  ' + macro('ElseIf') + ' $FixtureCase == "inner-empty"', '    StrCpy $FixtureInner "1"', '    StrCpy $FixtureAdmin "1"',
        '    StrCpy $InstallerCombinedSelectionReady "1"', '    StrCpy $InstallerCombinedSelectionPath ""',
        '  ' + macro('ElseIf') + ' $FixtureCase == "inner-relative"', '    StrCpy $FixtureInner "1"', '    StrCpy $FixtureAdmin "1"',
        '    StrCpy $InstallerCombinedSelectionReady "1"', '    StrCpy $InstallerCombinedSelectionPath "relative folder"',
        '  ' + macro('ElseIf') + ' $FixtureCase == "inner-not-ready"', '    StrCpy $FixtureInner "1"', '    StrCpy $FixtureAdmin "1"',
        '    StrCpy $InstallerCombinedSelectionReady "0"', '    StrCpy $InstallerCombinedSelectionPath "' + literal('selected machine') + '"',
        '  ' + macro('ElseIf') + ' $FixtureCase == "inner-bridge-failed"', '    StrCpy $FixtureInner "1"', '    StrCpy $FixtureAdmin "1"',
        '    StrCpy $InstallerCombinedSelectionReady "1"', '    StrCpy $InstallerCombinedSelectionPath "' + literal('selected machine') + '"', '    StrCpy $FixtureBridgeFailure "1"',
        '  ' + macro('ElseIf') + ' $FixtureCase == "updated"', '    StrCpy $FixtureUpdated "1"', '  ' + macro('EndIf'),
        '  ClearErrors', 'FunctionEnd',
        'Function FixtureGuiInit', '  GetDlgItem $0 $HWNDPARENT 1', '  SendMessage $0 0x0031 0 0 $FixtureOriginalFont', 'FunctionEnd',
        'Function FixtureElevation', '  FileOpen $0 "' + literal('elevation.txt') + '" w',
        '  FileWriteUTF16LE $0 "$InstallerCombinedSelectionPath|$installMode"', '  FileClose $0',
        '  ' + macro('If') + ' $FixtureCase == "handoff"', '    StrCpy $0 "0"', '    StrCpy $1 "1"', '    StrCpy $2 "0"',
        '  ' + macro('Else'), '    StrCpy $0 "1223"', '    StrCpy $1 "0"', '    StrCpy $2 "0"', '  ' + macro('EndIf'), 'FunctionEnd',
        // GDI handles are process-private: inspect actual attached fonts and
        // loaded bitmaps inside this fixture, then let the external probe assert.
        'Function FixtureRecordFont', '  Exch $0',
        ...Array.from({ length: 9 }, (_, index) => `  Push $${index + 1}`),
        ...Array.from({ length: 5 }, (_, index) => `  Push $R${index}`),
        '  System::Alloc 92', '  Pop $R0',
        '  SendMessage $0 0x0031 0 0 $R1', '  StrCpy $R4 "$R1"',
        "  System::Call 'gdi32::GetObjectW(p $R1, i 92, p $R0)i.r1'",
        "  System::Call '*$R0(i .r2, i, i, i, i .r3)'",
        '  IntOp $9 $R0 + 26', "  System::Call '*$9(&i1 .r4)'",
        "  System::Call 'user32::GetDC(p r0)p.s'", '  Pop $R2',
        "  System::Call 'gdi32::SelectObject(p $R2, p $R1)p.s'", '  Pop $R3',
        "  System::Call 'gdi32::GetTextMetricsW(p $R2, p $R0)i.r1'",
        "  System::Call '*$R0(i .r5)'",
        "  System::Call 'user32::GetWindowTextW(p r0, w .r6, i 1024)i.r1'",
        '  StrLen $1 $6',
        "  System::Call 'gdi32::GetTextExtentPoint32W(p $R2, w r6, i r1, p $R0)i.r1'",
        "  System::Call '*$R0(i .r6)'",
        "  System::Call 'gdi32::GetTextFaceW(p $R2, i 64, w .r9)i.r1'", '  StrCpy $R1 "$9"',
        "  System::Call 'gdi32::SelectObject(p $R2, p $R3)p.r1'",
        "  System::Call 'user32::ReleaseDC(p r0, p $R2)i.r1'",
        "  System::Call 'user32::GetClientRect(p r0, p $R0)i.r1'",
        "  System::Call '*$R0(i, i, i .r7, i .r8)'",
        `  FileOpen $9 "${literal('dpi-fonts.txt')}" a`, '  FileSeek $9 0 END',
        '  FileWrite $9 "$0|$2|$3|$4|$5|$6|$7|$8|$R1|$R4$\\r$\\n"', '  FileClose $9',
        '  System::Free $R0',
        ...Array.from({ length: 5 }, (_, index) => `  Pop $R${4 - index}`),
        ...Array.from({ length: 9 }, (_, index) => `  Pop $${9 - index}`),
        '  Pop $0', 'FunctionEnd',
        'Function FixtureRecordSetupDpi', '  Push $0', '  Push $1', '  Push $2', '  Push $3',
        '  Push $InstallerSetupHeading', '  Call FixtureRecordFont',
        '  Push $InstallerSetupSubheading', '  Call FixtureRecordFont',
        '  SendMessage $InstallerSetupLogo 0x0173 0 0 $0',
        '  System::Alloc 24', '  Pop $1',
        "  System::Call 'gdi32::GetObjectW(p r0, i 24, p r1)i.r2'",
        "  System::Call '*$1(i, i .r2, i .r3)'",
        `  FileOpen $0 "${literal('dpi-bitmap.txt')}" w`,
        '  FileWrite $0 "$2|$3"', '  FileClose $0', '  System::Free $1',
        '  Pop $3', '  Pop $2', '  Pop $1', '  Pop $0', 'FunctionEnd',

        'Function FixtureScopeObserved', '  Push $0', '  IntOp $FixtureScopeEvents $FixtureScopeEvents + 1',
        '  FileOpen $0 "' + literal('scope-sequence.txt') + '" w',
        '  FileWriteUTF16LE $0 "$FixtureScopeEvents|$InstallerCombinedMode"', '  FileClose $0', '  Pop $0', 'FunctionEnd',
        'Function FixtureCombinedObserved', '  IntOp $FixtureSetupVisits $FixtureSetupVisits + 1',
        '  ' + macro('If') + ' $InstallerSetupLogo != "0"', '  ' + macro('AndIf') + ' $InstallerSetupLogo != ""',
        '    Call FixtureRecordSetupDpi', '  ' + macro('EndIf'),
        '  Push $0', '  FileOpen $0 "' + literal('state.txt') + '" w',
        '  FileWrite $0 "setup|$FixtureSetupVisits|$InstallerCombinedPage|$InstallerCombinedCurrentUser|$InstallerCombinedAllUsers|$InstallerCombinedDirectory|$InstallerCombinedBrowse|$InstallerCombinedHint|$InstallerCombinedSpaceRequired|$InstallerCombinedSpaceAvailable|$InstallerSetupHeading|$InstallerSetupSubheading|$InstallerSetupLogo|$InstallerCombinedLockedDirectory|$InstallerCombinedMode|$InstallerSetupCompact|$InstallerSetupMinimal|$InstallerCombinedScopeLabel|$InstallerSetupFieldLabel|$InstallerCombinedDirectorySurface"',
        '  FileClose $0', '  Pop $0', 'FunctionEnd',
        'Function FixtureProgressPre', '  Call JustDoInstFilesPre', '  Call InstallerSetupResetForProgress', 'FunctionEnd',
        'Function FixtureProgressShow', '  Call InstallerPresentationShow',
        '  Push $0', '  FileOpen $0 "' + literal('state.txt') + '" w',
        '  FileWrite $0 "progress|$FixtureSetupVisits|$JustDoInstFilesPage|$InstallerScene|$InstallerTitle|$InstallerSubtitle|$InstallerSceneHeight|$InstallerCompactLayout|$JustDoInstallLog|$JustDoStatusText|$InstallerExplanation|$InstallerStepCheck|$InstallerMinimalLayout"',
        '  FileClose $0', '  Pop $0', 'FunctionEnd',
        'Function .onInstSuccess', '  Call InstallerPresentationCloseMotion', 'FunctionEnd',
        'Function .onGUIEnd', '  Call InstallerSetupDestroy', '  Call InstallerPresentationDestroy',
        '  DeleteRegKey HKCU "' + macro('INSTALL_REGISTRY_KEY') + '"',
        '  FileOpen $0 "' + literal('closed.txt') + '" w', '  FileWrite $0 "' + proof + '"', '  FileClose $0', 'FunctionEnd',
        'Section', '  ' + macro('If') + ' ' + macro('Silent'),
        '    FileOpen $0 "' + literal('silent.txt') + '" w', '    FileWrite $0 "' + proof + '"', '    FileClose $0',
        '  ' + macro('Else'), '    FileOpen $0 "' + literal('finished.txt') + '" w',
        '    FileWriteUTF16LE $0 "$installMode|$INSTDIR|$FixtureProcessChecks"', '    FileClose $0', '  ' + macro('EndIf'), 'SectionEnd',
      ].join('\n');
      writeFileSync(path.join(root, 'setup.nsi'), source);
      for (const folder of ['fresh location', 'machine location', '已安装 软件', 'machine existing', 'selected current 汉字 & %value%', 'selected machine']) mkdirSync(path.join(root, folder));
      for (const folder of ['已安装 软件', 'machine existing']) {
        writeFileSync(path.join(root, folder, `${productName}.exe`), 'fixture product executable');
        writeFileSync(path.join(root, folder, `Uninstall ${productName}.exe`), 'fixture uninstaller');
      }
      writeFileSync(path.join(root, 'existing-file'), 'path validation canary');
      const compiled = spawnSync(compiler, ['/WX', '/V2', '/INPUTCHARSET', 'UTF8', path.join(root, 'setup.nsi')], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
      expect(compiled.status, compiled.stdout + '\n' + compiled.stderr).toBe(0);
      if (process.env.INSTALLER_PRESENTATION_COMPILE_ONLY === '1') return;
      const checked = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(repoRoot, 'scripts/fixtures/nsis-setup-presentation-probe.ps1'),
        '-Executable', path.join(root, 'wizard.exe'), '-FixtureRoot', root, '-PreviewRoot', buildRoot,
        '-HeroWidth', String(hero.width), '-HeroHeight', String(hero.height), '-ProductName', productName,
      ], { encoding: 'utf8', windowsHide: true, timeout: 100_000 });
      expect(checked.status, checked.stdout + '\n' + checked.stderr).toBe(0);
      expect(checked.stdout).toContain('combined setup presentation checks passed');
    } finally {
      spawnSync('reg.exe', ['delete', 'HKCU\\' + registryKey, '/f', '/reg:64'], { windowsHide: true, timeout: 5_000, stdio: 'ignore' });
      expect(path.dirname(path.resolve(root))).toBe(buildRoot);
      rmSync(root, { recursive: true, force: true });
    }
  }, 140_000);
});
