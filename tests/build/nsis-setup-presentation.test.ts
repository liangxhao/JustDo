import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const cache = process.env.ELECTRON_BUILDER_CACHE || path.join(process.env.LOCALAPPDATA || '', 'electron-builder/Cache');
const compiler = path.join(cache, 'nsis/nsis-3.0.4.1/makensis.exe');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const nsisPath = (value: string): string => value.replaceAll('$', () => '$$');

function sourceFunction(source: string, name: string): string {
  const result = source.match(new RegExp(`Function ${name}\\b[^]*?FunctionEnd`))?.[0];
  if (!result) throw new Error(`Installer function missing: ${name}`);
  return result;
}

describe.runIf(process.platform === 'win32' && existsSync(compiler)
  && process.env.INSTALLER_PRESENTATION_NATIVE_UI === '1')('native installer setup presentation', () => {
  it('preserves native mode and directory behavior across back navigation and releases decoration before writing', () => {
    const buildRoot = path.join(repoRoot, 'build');
    mkdirSync(buildRoot, { recursive: true });
    const root = mkdtempSync(path.join(buildRoot, 'installer-setup-test-'));
    const literal = (name: string): string => nsisPath(path.join(root, name));
    try {
      const definitions = require('../../scripts/packaging/installer-animation-script.cjs')
        .prepareInstallerAnimationScript(repoRoot);
      const clock = require('../../scripts/packaging/installer-clock-assets.cjs')
        .prepareInstallerClockAssets(repoRoot);
      const productName = require('../../package.json').productName;
      const installer = readFileSync(path.join(repoRoot, 'scripts/packaging/nsis-installer.nsh'), 'utf8');
      const upstream = readFileSync(path.join(repoRoot, 'node_modules/app-builder-lib/templates/nsis/multiUserUi.nsh'), 'utf8');
      // Keep the real native controls, radio callbacks and page-leave logic.
      // Replace only account inspection/elevation with isolated fixture state.
      const mode = upstream
        .replaceAll('${UAC_IsInnerInstance}', '$FixtureInner == "1"')
        .replaceAll('${UAC_IsAdmin}', '$FixtureAdmin == "1"')
        .replaceAll('${isForAllUsers}', '$FixtureForceMachine == "1"')
        .replaceAll('${isForCurrentUser}', '$FixtureForceCurrent == "1"')
        .replaceAll('!insertmacro UAC_RunElevated', 'Call FixtureElevationDenied')
        .replace('SendMessage $0 ${BCM_SETSHIELD} 0 1', [
          'SendMessage $0 ${BCM_SETSHIELD} 0 1',
          'Push "on"', 'Call FixtureRecordShield',
        ].join('\n'));
      writeFileSync(path.join(root, 'multi-user-fixture.nsh'), mode);
      const proof = '$InstallerSetupReady|$InstallerSetupFont|$InstallerSetupTitleFont|$InstallerSetupLogo|$InstallerSetupBitmap|$InstallerSetupFieldLabel|$InstallerSetupNextImage|$InstallerSetupBackImage|$InstallerSetupCancelImage|$InstallerSetupBrowseImage|$InstallerSetupHeading|$InstallerSetupSubheading';
      const source = [
        'Unicode true', 'RequestExecutionLevel user', 'ShowInstDetails hide',
        'Name "Installer setup fixture"', `OutFile "${literal('wizard.exe')}"`,
        '!include "MUI2.nsh"', '!include "LogicLib.nsh"', '!include "FileFunc.nsh"',
        `!define PROJECT_DIR "${nsisPath(repoRoot)}"`, `!define PRODUCT_NAME "${productName}"`,
        `!define MUI_ICON "${nsisPath(path.join(repoRoot, 'resources/icons/win/icon.ico'))}"`,
        '!define JUSTDO_LANG_SIMPCHINESE 2052', '!define JUSTDO_LANG_TRADCHINESE 1028',
        '!define JUSTDO_WM_SETTEXT 0x000C', '!define JUSTDO_WM_SETREDRAW 0x000B',
        '!define JUSTDO_RDW_ATOMIC_REFRESH 0x0185', '!define JUSTDO_PBM_SETRANGE32 0x0406',
        '!define JUSTDO_PBM_SETPOS 0x0402', '!define JUSTDO_PBM_SETBARCOLOR 0x0409',
        '!define JUSTDO_PBM_SETBKCOLOR 0x2001', '!define MULTIUSER_INSTALLMODE_ALLOW_ELEVATION',
        ...['FixtureCase', 'FixtureInner', 'FixtureAdmin', 'FixtureForceMachine', 'FixtureForceCurrent',
          'FixtureModeVisits', 'FixtureDirectoryVisits', 'FixtureOriginalFont', 'InstallerUpgradeDirectory',
          'installMode', 'hasPerUserInstallation', 'hasPerMachineInstallation', 'perUserInstallationFolder',
          'perMachineInstallationFolder', 'JustDoInstFilesPage', 'JustDoInstallLog', 'JustDoShowLogButton',
          'JustDoProgressBar', 'JustDoNativeProgressBar', 'JustDoStatusText', 'JustDoExtractorActive']
          .map(name => `Var ${name}`),
        '!define MUI_CUSTOMFUNCTION_GUIINIT FixtureGuiInit',
        '!macro setInstallModePerUser', '  StrCpy $installMode "CurrentUser"',
        `  StrCpy $INSTDIR "${literal('fresh location')}"`,
        '  ${If} $FixtureCase == "upgrade"', `    StrCpy $INSTDIR "${literal('已安装 软件')}"`,
        '  ${EndIf}', '!macroend',
        '!macro setInstallModePerAllUsers', '  StrCpy $installMode "all"',
        `  StrCpy $INSTDIR "${literal('machine location')}"`, '!macroend',
        '!macro JustDoSetInstallStatus ZH EN',
        '  !insertmacro InstallerText $JustDoStatusText "${ZH}" "${EN}"', '!macroend',
        '!macro JustDoAddInstallActivity ZH EN', '  DetailPrint "${EN}"', '!macroend',
        '!macro JustDoLogInstallEvent TEXT', '  ClearErrors', '!macroend',
        '!macro InstallerSetupWorkArea', '  ${If} $FixtureCase == "short"',
        '    StrCpy $InstallerSetupDpi 288', '  ${EndIf}', '!macroend',
        '!macro InstallerSetupClampWorkArea', '  ${If} $FixtureCase == "short"',
        '    ${If} $4 > 1366', '      StrCpy $4 1366', '    ${EndIf}',
        '    ${If} $5 > 728', '      StrCpy $5 728', '    ${EndIf}', '  ${EndIf}', '!macroend',
        definitions,
        `!define INSTALLER_CLOCK_LIBRARY "${nsisPath(clock.path)}"`,
        `!include "${nsisPath(path.join(repoRoot, 'scripts/packaging/nsis-install-presentation.nsh'))}"`,
        `!include "${literal('multi-user-fixture.nsh')}"`,
        '!define MUI_PAGE_CUSTOMFUNCTION_SHOW FixtureModeShow',
        '!define MUI_PAGE_CUSTOMFUNCTION_LEAVE InstallerSetupLeave',
        '!insertmacro PAGE_INSTALL_MODE',
        '!define MUI_PAGE_CUSTOMFUNCTION_PRE FixtureDirectoryPre',
        '!define MUI_PAGE_CUSTOMFUNCTION_SHOW FixtureDirectoryShow',
        '!define MUI_PAGE_CUSTOMFUNCTION_LEAVE InstallerSetupLeave',
        '!insertmacro MUI_PAGE_DIRECTORY',
        `!include "${nsisPath(path.join(repoRoot, 'scripts/packaging/nsis-setup-presentation.nsh'))}"`,
        '!define MUI_PAGE_CUSTOMFUNCTION_PRE FixtureProgressPre',
        '!define MUI_PAGE_CUSTOMFUNCTION_SHOW FixtureProgressShow',
        '!define MUI_PAGE_CUSTOMFUNCTION_LEAVE InstallerPresentationLeave',
        '!insertmacro MUI_PAGE_INSTFILES',
        '!insertmacro MUI_LANGUAGE "English"', '!insertmacro MUI_LANGUAGE "SimpChinese"',
        ...[
          ['chooseInstallationOptions', 'Installation scope', '选择安装范围'],
          ['whoShouldThisApplicationBeInstalledFor', 'Choose who can use this application.', '选择哪些账户可以使用此应用。'],
          ['selectUserMode', 'Choose an installation scope.', '选择适合你的安装范围。'],
          ['forAll', 'For all users', '为所有用户安装'], ['onlyForMe', 'Only for me', '仅为我安装'],
          ['perUserInstallExists', 'Existing user installation ', '已存在当前用户安装 '],
          ['perMachineInstallExists', 'Existing machine installation ', '已存在所有用户安装 '],
          ['reinstallUpgrade', 'Reinstall or upgrade.', '重新安装或升级。'],
          ['freshInstallForCurrent', 'Fresh installation for the current user.', '仅为当前用户进行全新安装。'],
          ['freshInstallForAll', 'Fresh installation for all users.', '为所有用户进行全新安装。'],
          ['loginWithAdminAccount', 'Fixture elevation was denied.', '测试未允许提权。'],
        ].flatMap(([key, en, zh]) => [
          `LangString ${key} 1033 "${en}"`, `LangString ${key} 2052 "${zh}"`,
        ]),
        sourceFunction(installer, 'InstallerDirectoryShow'),
        'Function .onInit', '  StrCpy $FixtureInner "0"', '  StrCpy $FixtureAdmin "0"',
        '  StrCpy $JustDoExtractorActive "0"',
        '  StrCpy $FixtureForceMachine "0"', '  StrCpy $FixtureForceCurrent "0"',
        '  StrCpy $FixtureModeVisits "0"', '  StrCpy $FixtureDirectoryVisits "0"',
        '  StrCpy $hasPerUserInstallation "0"', '  StrCpy $hasPerMachineInstallation "0"',
        '  StrCpy $perUserInstallationFolder ""', '  StrCpy $perMachineInstallationFolder ""',
        '  ${GetParameters} $0', '  ${GetOptions} $0 "/case=" $FixtureCase',
        '  StrCpy $LANGUAGE 2052',
        '  ${If} $FixtureCase == "short"', '    StrCpy $LANGUAGE 1033', '  ${EndIf}',
        '  ${If} $FixtureCase == "upgrade"',
        '    StrCpy $hasPerUserInstallation "1"',
        `    StrCpy $perUserInstallationFolder "${literal('已安装 软件')}"`, '  ${EndIf}',
        '  !insertmacro setInstallModePerUser', '  ClearErrors', 'FunctionEnd',
        'Function FixtureGuiInit', '  GetDlgItem $0 $HWNDPARENT 1',
        '  SendMessage $0 0x0031 0 0 $FixtureOriginalFont', 'FunctionEnd',
        'Function FixtureElevationDenied',
        `  FileOpen $0 "${literal('elevation.txt')}" w`, '  FileWrite $0 "denied"', '  FileClose $0',
        '  StrCpy $0 "1223"', '  StrCpy $1 "0"', '  StrCpy $2 "0"', 'FunctionEnd',
        'Function FixtureRecordShield', '  Exch $0', '  Push $1',
        `  FileOpen $1 "${literal('shield.txt')}" a`, '  FileSeek $1 0 END',
        '  FileWrite $1 "$0$\\r$\\n"', '  FileClose $1', '  Pop $1', '  Pop $0', 'FunctionEnd',
        'Function FixtureModeShow', '  Call InstallerSetupModeShow',
        '  IntOp $FixtureModeVisits $FixtureModeVisits + 1',
        '  Push $0', '  Push $1', '  Push $2',
        '  nsDialogs::GetUserData $MultiUser.InstallModePage.CurrentUser', '  Pop $1',
        '  nsDialogs::GetUserData $MultiUser.InstallModePage.AllUsers', '  Pop $2',
        `  FileOpen $0 "${literal('state.txt')}" w`,
        '  FileWrite $0 "mode|$FixtureModeVisits|$MultiUser.InstallModePage|$MultiUser.InstallModePage.AllUsers|$MultiUser.InstallModePage.CurrentUser|$RadioButtonLabel1|$InstallerSetupNextImage|$1|$2|$InstallerSetupHeading|$InstallerSetupSubheading|$InstallerSetupLogo"',
        '  FileClose $0', '  Pop $2', '  Pop $1', '  Pop $0', '  ShowWindow $HWNDPARENT 4', 'FunctionEnd',
        'Function FixtureDirectoryPre', '  StrCpy $InstallerUpgradeDirectory ""',
        '  ${If} $FixtureCase == "upgrade"',
        `    StrCpy $InstallerUpgradeDirectory "${literal('已安装 软件')}"`,
        '    StrCpy $INSTDIR "$InstallerUpgradeDirectory"', '  ${EndIf}', 'FunctionEnd',
        'Function FixtureDirectoryShow', '  Call InstallerDirectoryShow',
        '  IntOp $FixtureDirectoryVisits $FixtureDirectoryVisits + 1',
        '  Push $0', `  FileOpen $0 "${literal('state.txt')}" w`,
        '  FileWrite $0 "directory|$FixtureDirectoryVisits|$mui.DirectoryPage|$mui.DirectoryPage.Directory|$mui.DirectoryPage.BrowseButton|$mui.DirectoryPage.Text|$InstallerSetupHeading|$InstallerSetupSubheading|$InstallerSetupLogo|$InstallerSetupFieldLabel"',
        '  FileClose $0', '  Pop $0', 'FunctionEnd',
        'Function FixtureProgressPre', '  Call InstallerSetupResetForProgress',
        '  Push $0', '  Push $1', '  Push $2', '  Push $3', '  Push $4', '  Push $5',
        '  GetDlgItem $0 $HWNDPARENT 1', '  SendMessage $0 0x00F6 0 0 $1',
        '  SendMessage $0 0x0031 0 0 $2',
        '  GetDlgItem $0 $HWNDPARENT 2', '  SendMessage $0 0x00F6 0 0 $3',
        '  GetDlgItem $0 $HWNDPARENT 3', '  SendMessage $0 0x00F6 0 0 $4',
        `  FileOpen $5 "${literal('reset.txt')}" w`,
        `  FileWrite $5 "${proof}|$1|$3|$4|$2|$FixtureOriginalFont"`, '  FileClose $5',
        '  Pop $5', '  Pop $4', '  Pop $3', '  Pop $2', '  Pop $1', '  Pop $0', 'FunctionEnd',
        'Function FixtureProgressShow', '  Call InstallerPresentationShow',
        '  Push $0', `  FileOpen $0 "${literal('state.txt')}" w`,
        '  FileWrite $0 "progress|1"', '  FileClose $0', '  Pop $0', 'FunctionEnd',
        'Function .onInstSuccess', '  Call InstallerPresentationCloseMotion', 'FunctionEnd',
        'Function .onGUIEnd', '  Call InstallerPresentationDestroy', '  Call InstallerSetupDestroy', '  Push $0',
        `  FileOpen $0 "${literal('closed.txt')}" w`, `  FileWrite $0 "${proof}"`,
        '  FileClose $0', '  Pop $0', 'FunctionEnd',
        'Section', '  ${If} ${Silent}',
        `    FileOpen $0 "${literal('silent.txt')}" w`, `    FileWrite $0 "${proof}"`,
        '    FileClose $0', '  ${Else}',
        `    FileOpen $0 "${literal('finished.txt')}" w`,
        '    FileWriteUTF16LE $0 "$INSTDIR"', '    FileClose $0', '  ${EndIf}', 'SectionEnd',
      ].join('\n');
      for (const folder of ['fresh location', 'machine location', '已安装 软件', 'selected location']) {
        mkdirSync(path.join(root, folder));
      }
      const script = path.join(root, 'setup.nsi');
      writeFileSync(script, source);
      const compiled = spawnSync(compiler, ['/WX', '/V2', '/INPUTCHARSET', 'UTF8', script], {
        encoding: 'utf8', windowsHide: true, timeout: 20_000,
      });
      expect(compiled.status, `${compiled.stdout}\n${compiled.stderr}`).toBe(0);
      const checked = spawnSync(powershell, [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(repoRoot, 'scripts/fixtures/nsis-setup-presentation-probe.ps1'),
        '-Executable', path.join(root, 'wizard.exe'), '-FixtureRoot', root, '-PreviewRoot', buildRoot,
      ], { encoding: 'utf8', windowsHide: true, timeout: 65_000 });
      expect(checked.status, `${checked.stdout}\n${checked.stderr}`).toBe(0);
      expect(checked.stdout).toContain('setup presentation checks passed');
    } finally {
      expect(path.dirname(path.resolve(root))).toBe(buildRoot);
      rmSync(root, { recursive: true, force: true });
    }
  }, 95_000);
});
