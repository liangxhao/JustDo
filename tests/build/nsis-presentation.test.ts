import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const cache = process.env.ELECTRON_BUILDER_CACHE || path.join(process.env.LOCALAPPDATA || '', 'electron-builder/Cache');
const compiler = path.join(cache, 'nsis/nsis-3.0.4.1/makensis.exe');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');

// Pixel animation acceptance needs a visible desktop. Offscreen/occluded
// windows can be throttled by Windows even while ACM_ISPLAYING returns true.
describe.runIf(process.platform === 'win32' && existsSync(compiler)
  && process.env.INSTALLER_PRESENTATION_NATIVE_UI === '1')('native installer presentation', () => {
  it('plays during work, opens native details, stops at terminal states and stays absent in silent mode', () => {
    const buildRoot = path.join(repoRoot, 'build');
    mkdirSync(buildRoot, { recursive: true });
    const root = mkdtempSync(path.join(buildRoot, 'installer-presentation-test-'));
    try {
      const executable = path.join(root, 'presentation.exe');
      const definitions = require('../../scripts/packaging/installer-animation-script.cjs')
        .prepareInstallerAnimationScript(repoRoot);
      const productName = require('../../package.json').productName;
      const source = [
        'Unicode true',
        'RequestExecutionLevel user',
        'ShowInstDetails hide',
        'Name "Installer presentation fixture"',
        `OutFile "${executable}"`,
        '!include "LogicLib.nsh"',
        '!include "FileFunc.nsh"',
        '!include "MUI2.nsh"',
        `!define PRODUCT_NAME "${productName}"`,
        `!define PROJECT_DIR "${repoRoot}"`,
        '!define JUSTDO_LANG_SIMPCHINESE 2052',
        '!define JUSTDO_LANG_TRADCHINESE 1028',
        '!define JUSTDO_WM_SETTEXT 0x000C',
        '!define JUSTDO_WM_SETREDRAW 0x000B',
        '!define JUSTDO_RDW_ATOMIC_REFRESH 0x0185',
        '!define JUSTDO_PBM_SETRANGE32 0x0406',
        '!define JUSTDO_PBM_SETPOS 0x0402',
        '!define JUSTDO_PBM_SETBARCOLOR 0x0409',
        '!define JUSTDO_PBM_SETBKCOLOR 0x2001',
        ...['JustDoInstFilesPage', 'JustDoInstallLog', 'JustDoShowLogButton', 'JustDoProgressBar', 'JustDoNativeProgressBar', 'JustDoStatusText', 'JustDoExtractorActive'].map(name => `Var ${name}`),
        '!macro JustDoSetInstallStatus ZH EN',
        '  !insertmacro InstallerText $JustDoStatusText "${ZH}" "${EN}"',
        '!macroend',
        '!macro JustDoAddInstallActivity ZH EN',
        '  DetailPrint "${EN}"',
        '!macroend',
        '!macro JustDoLogInstallEvent TEXT',
        '  ClearErrors',
        '!macroend',
        '!macro InstallerMotionTraceFrame',
        ...Array.from({ length: 10 }, (_, index) => `  Push $${index}`),
        "  System::Call 'user32::GetLayeredWindowAttributes(p $HWNDPARENT, p 0, *i .r1, p 0)i.r8'",
        '  IntOp $1 $1 & 255',
        "  System::Call 'user32::GetWindowRect(p $HWNDPARENT, p $InstallerMotionRect)i.r0'",
        "  System::Call '*$InstallerMotionRect(i .r4, i .r5, i .r6, i .r7)'",
        '  IntOp $6 $6 - $4',
        '  IntOp $7 $7 - $5',
        "  System::Call 'kernel32::GetTickCount()i.r3'",
        `  FileOpen $9 "${root}\\motion.txt" a`,
        '  FileSeek $9 0 END',
        '  FileWrite $9 "FRAME|$InstallerMotionKind|$1|$4|$5|$6|$7|$8|$3$\\r$\\n"',
        '  FileClose $9',
        ...Array.from({ length: 10 }, (_, index) => `  Pop $${9 - index}`),
        '!macroend',
        '!macro InstallerMotionTraceComplete',
        ...Array.from({ length: 10 }, (_, index) => `  Push $${index}`),
        "  System::Call 'user32::GetWindowLongW(p $HWNDPARENT, i -20)i.r1'",
        "  System::Call 'user32::IsWindowVisible(p $HWNDPARENT)i.r2'",
        "  System::Call 'user32::GetWindowRect(p $HWNDPARENT, p $InstallerMotionRect)i.r0'",
        "  System::Call '*$InstallerMotionRect(i .r4, i .r5, i .r6, i .r7)'",
        '  IntOp $6 $6 - $4',
        '  IntOp $7 $7 - $5',
        `  FileOpen $9 "${root}\\motion.txt" a`,
        '  FileSeek $9 0 END',
        '  FileWrite $9 "END|$InstallerMotionKind|$1|$4|$5|$6|$7|$2$\\r$\\n"',
        '  FileClose $9',
        ...Array.from({ length: 10 }, (_, index) => `  Pop $${9 - index}`),
        '!macroend',
        definitions,
        `!include "${path.join(repoRoot, 'scripts/packaging/nsis-install-presentation.nsh')}"`,
        '!define MUI_PAGE_CUSTOMFUNCTION_SHOW FixtureShow',
        '!define MUI_PAGE_CUSTOMFUNCTION_LEAVE InstallerPresentationLeave',
        '!insertmacro MUI_PAGE_INSTFILES',
        '!insertmacro MUI_LANGUAGE "English"',
        '!insertmacro MUI_LANGUAGE "SimpChinese"',
        'Function .onInit',
        '  StrCpy $LANGUAGE 1033',
        '  ${GetParameters} $0',
        '  ${GetOptions} $0 "/zh" $1',
        '  ${IfNot} ${Errors}',
        '    StrCpy $LANGUAGE 2052',
        '  ${EndIf}',
        '  ClearErrors',
        'FunctionEnd',
        'Function FixtureShow',
        '  Call InstallerPresentationShow',
        '  ShowWindow $HWNDPARENT 4', // SW_SHOWNOACTIVATE; visible, no focus request.
        'FunctionEnd',
        'Function .onInstFailed',
        '  Push "failed"',
        '  Call InstallerPresentationSetStage',
        '  StrCpy $0 "8731"',
        '  StrCpy $R9 "9317"',
        '  SetErrors',
        '  Call InstallerPresentationCloseMotion',
        '  Call InstallerPresentationCloseMotion', // Must be idempotent.
        '  StrCpy $2 "0"',
        '  ${If} ${Errors}',
        '    StrCpy $2 "1"',
        '  ${EndIf}',
        `  FileOpen $3 "${root}\\callback.txt" w`,
        '  FileWrite $3 "$0|$R9|$2"',
        '  FileClose $3',
        'FunctionEnd',
        'Function .onInstSuccess',
        '  StrCpy $0 "8731"',
        '  StrCpy $R9 "9317"',
        '  SetErrors',
        '  Call InstallerPresentationCloseMotion',
        '  Call InstallerPresentationCloseMotion',
        '  StrCpy $2 "0"',
        '  ${If} ${Errors}',
        '    StrCpy $2 "1"',
        '  ${EndIf}',
        `  FileOpen $3 "${root}\\callback.txt" w`,
        '  FileWrite $3 "$0|$R9|$2"',
        '  FileClose $3',
        'FunctionEnd',
        'Function .onGUIEnd',
        '  Call InstallerPresentationDestroy',
        `  FileOpen $0 "${root}\\closed.txt" w`,
        '  FileWrite $0 "$InstallerScene|$InstallerBitmap|$InstallerTitleFont|$InstallerBaseFontOwned|$InstallerNextButtonImage|$InstallerCancelButtonImage|$InstallerDetailsButtonImage"',
        '  FileClose $0',
        'FunctionEnd',
        'Section',
        '  ${If} ${Silent}',
        `    FileOpen $0 "${root}\\silent.txt" w`,
        '    FileWrite $0 "$InstallerPresentationReady|$InstallerScene"',
        '    FileClose $0',
        '    Goto FixtureDone',
        '  ${EndIf}',
        '  StrCpy $JustDoExtractorActive "1"',
        '  StrCpy $8 0',
        '  FixtureDetails:',
        '  DetailPrint "Presentation sample record $8"',
        '  IntOp $8 $8 + 1',
        '  IntCmp $8 40 FixtureDetailsDone FixtureDetails FixtureDetailsDone',
        '  FixtureDetailsDone:',
        '  StrCpy $9 0',
        '  FixtureWait:',
        '  Sleep 150',
        '  Call InstallerPresentationTick',
        `  System::Call 'kernel32::CreateFileW(w "${root}\\action.txt", i 0x80000000, i 7, p 0, i 3, i 0x80, p 0)p.r0'`,
        '  FileRead $0 $1',
        '  FileClose $0',
        '  ClearErrors',
        '  ${If} $1 == "complete"',
        '    StrCpy $JustDoExtractorActive "0"',
        '    Push "complete"',
        '    Call InstallerPresentationSetStage',
        '    Goto FixtureDone',
        '  ${ElseIf} $1 == "failed"',
        '    StrCpy $JustDoExtractorActive "0"',
        '    SetErrorLevel 2',
        '    Abort',
        '  ${ElseIf} $1 == "resources"',
        '    Push "resources"',
        '    Call InstallerPresentationSetStage',
        '    !insertmacro JustDoSetInstallStatus "正在读取核心资源：40%…" "Reading core resources: 40%…"',
        '    SendMessage $JustDoNativeProgressBar ${JUSTDO_PBM_SETPOS} 40 0',
        '  ${ElseIf} $1 == "blocked-close"',
        '    StrCpy $0 "4217"',
        '    SetErrors',
        '    Call InstallerPresentationCloseMotion',
        '    StrCpy $2 "0"',
        '    ${If} ${Errors}',
        '      StrCpy $2 "1"',
        '    ${EndIf}',
        `    FileOpen $3 "${root}\\blocked.txt" w`,
        '    FileWrite $3 "$0|$2|$InstallerMotionClosed"',
        '    FileClose $3',
        '  ${EndIf}',
        '  IntOp $9 $9 + 1',
        '  IntCmp $9 160 FixtureDone FixtureWait FixtureDone',
        '  FixtureDone:',
        '  StrCpy $JustDoExtractorActive "0"',
        'SectionEnd',
      ].join('\n');
      const sourcePath = path.join(root, 'presentation.nsi');
      writeFileSync(sourcePath, source);
      const compiled = spawnSync(compiler, ['/WX', '/V2', '/INPUTCHARSET', 'UTF8', sourcePath], {
        encoding: 'utf8', timeout: 20_000, windowsHide: true,
      });
      expect(compiled.status, `${compiled.stdout}\n${compiled.stderr}`).toBe(0);
      const checked = spawnSync(powershell, [
        '-NoProfile', '-NonInteractive', '-File',
        path.join(repoRoot, 'scripts/fixtures/nsis-presentation-probe.ps1'),
        '-Executable', executable, '-FixtureRoot', root,
        '-PreviewPath', path.join(buildRoot, 'installer-presentation-preview.png'),
      ], { encoding: 'utf8', timeout: 35_000, windowsHide: true });
      expect(checked.status, `${checked.stdout}\n${checked.stderr}`).toBe(0);
      expect(checked.stdout).toContain('presentation checks passed');
    } finally {
      expect(path.dirname(path.resolve(root))).toBe(buildRoot);
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
