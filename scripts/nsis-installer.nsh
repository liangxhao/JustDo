!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "StdUtils.nsh"
!include "TextFunc.nsh"

!define JUSTDO_POWERSHELL "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
!define JUSTDO_INSTALLER_QUIT_SWITCH "--justdo-request-quit-for-update"

!ifndef BUILD_UNINSTALLER
!define JUSTDO_PROGRESS_STYLE 0x50000009
!define JUSTDO_PBM_SETPOS 0x0402
!define JUSTDO_PBM_SETRANGE32 0x0406
!define JUSTDO_PBM_SETBARCOLOR 0x0409
!define JUSTDO_PBM_SETMARQUEE 0x040A
!define JUSTDO_PBM_SETBKCOLOR 0x2001
!define JUSTDO_WM_SETREDRAW 0x000B
!define JUSTDO_WM_SETTEXT 0x000C
!define JUSTDO_RDW_ATOMIC_REFRESH 0x0185
!define JUSTDO_LANG_TRADCHINESE 1028
!define JUSTDO_LANG_SIMPCHINESE 2052

Var JustDoProgressBar
Var JustDoInstFilesPage
Var JustDoStatusText
Var JustDoNativeProgressBar
Var JustDoInstallLog
Var JustDoShowLogButton
Var JustDoResourceProgressFile
Var JustDoLastResourceActivity
Var JustDoLastResourceProgress
Var JustDoInstallLogPath
Var JustDoResourceLogPath
Var JustDoInstallStartedTick
Var JustDoCoreInstallStartedTick
Var JustDoProcessCheckComplete

Function JustDoWriteInstallEvent
  Exch $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9

  System::Call 'kernel32::GetTickCount()i.r1'
  IntOp $1 $1 - $JustDoInstallStartedTick
  ${GetTime} "" "L" $2 $3 $4 $5 $6 $7 $8
  ${If} $JustDoInstallLogPath != ""
    ClearErrors
    FileOpen $9 "$JustDoInstallLogPath" a
    ${IfNot} ${Errors}
      FileWrite $9 "$4-$3-$2 $6:$7:$8 elapsed-ms=$1 $0$\r$\n"
      FileClose $9
    ${EndIf}
  ${EndIf}
  ; Diagnostics are best-effort and must never leak their error flag into the
  ; installer flow, where later IfErrors checks control rollback behavior.
  ClearErrors

  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

!macro JustDoLogInstallEvent _TEXT
  Push "${_TEXT}"
  Call JustDoWriteInstallEvent
!macroend

Function .onInstFailed
  !insertmacro JustDoLogInstallEvent "phase=installer-failed status=terminated-before-success"
  Call JustDoRestoreManagedRuntimes
FunctionEnd

Function JustDoPollResourceProgress
  Push $0
  Push $1
  Push $2
  Push $3

  ${If} $JustDoResourceProgressFile != ""
  ${AndIf} ${FileExists} "$JustDoResourceProgressFile"
    ClearErrors
    FileOpen $0 "$JustDoResourceProgressFile" r
    ${IfNot} ${Errors}
      FileRead $0 $1
      FileRead $0 $2
      FileRead $0 $3
      FileClose $0
      ${TrimNewLines} "$1" $1
      ${TrimNewLines} "$2" $2
      ${TrimNewLines} "$3" $3

      ${If} $1 == "determinate"
      ${AndIf} $2 != ""
        StrCpy $JustDoLastResourceProgress $2
        ${If} $JustDoProgressBar != ""
          SendMessage $JustDoProgressBar ${JUSTDO_PBM_SETMARQUEE} 0 0
          ShowWindow $JustDoProgressBar 0
        ${EndIf}
        ShowWindow $JustDoNativeProgressBar 5
        SendMessage $JustDoNativeProgressBar ${JUSTDO_PBM_SETRANGE32} 0 100
        SendMessage $JustDoNativeProgressBar ${JUSTDO_PBM_SETPOS} $2 0
        ${If} $JustDoStatusText != ""
          ${If} $LANGUAGE == ${JUSTDO_LANG_SIMPCHINESE}
          ${OrIf} $LANGUAGE == ${JUSTDO_LANG_TRADCHINESE}
            StrCpy $1 "正在读取核心资源：$2%…"
          ${Else}
            StrCpy $1 "Reading core resources: $2%…"
          ${EndIf}
          SendMessage $JustDoStatusText ${JUSTDO_WM_SETTEXT} 0 "STR:$1"
        ${EndIf}
      ${Else}
        ${If} $JustDoProgressBar != ""
          SendMessage $JustDoProgressBar ${JUSTDO_PBM_SETMARQUEE} 0 0
          ShowWindow $JustDoProgressBar 0
        ${EndIf}
        ; Validation and filesystem flushes have no trustworthy percentage.
        ; Keep the native bar at the last measured value instead of showing a
        ; looping marquee that can look like flicker or backward progress.
        ShowWindow $JustDoNativeProgressBar 5
        SendMessage $JustDoNativeProgressBar ${JUSTDO_PBM_SETRANGE32} 0 100
        SendMessage $JustDoNativeProgressBar ${JUSTDO_PBM_SETPOS} $JustDoLastResourceProgress 0
        ${If} $JustDoStatusText != ""
          ${If} $LANGUAGE == ${JUSTDO_LANG_SIMPCHINESE}
          ${OrIf} $LANGUAGE == ${JUSTDO_LANG_TRADCHINESE}
            StrCpy $1 "正在展开或验证核心资源；无法精确计算百分比，安装程序仍在运行…"
          ${Else}
            StrCpy $1 "Expanding or validating core resources; no exact percentage is available. Setup is still working…"
          ${EndIf}
          SendMessage $JustDoStatusText ${JUSTDO_WM_SETTEXT} 0 "STR:$1"
        ${EndIf}
      ${EndIf}

      ${If} $3 != ""
      ${AndIf} $3 != $JustDoLastResourceActivity
        StrCpy $JustDoLastResourceActivity $3
        SetDetailsPrint listonly
        DetailPrint "$3"
        SetDetailsPrint none
      ${EndIf}
    ${EndIf}
  ${EndIf}

  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

!macro JustDoAddInstallActivity _ZH_TEXT _EN_TEXT
  SetDetailsPrint listonly
  ${If} $LANGUAGE == ${JUSTDO_LANG_SIMPCHINESE}
  ${OrIf} $LANGUAGE == ${JUSTDO_LANG_TRADCHINESE}
    DetailPrint "${_ZH_TEXT}"
  ${Else}
    DetailPrint "${_EN_TEXT}"
  ${EndIf}
  SetDetailsPrint none
!macroend

!macro JustDoSetInstallStatus _ZH_TEXT _EN_TEXT
  ${If} $LANGUAGE == ${JUSTDO_LANG_SIMPCHINESE}
  ${OrIf} $LANGUAGE == ${JUSTDO_LANG_TRADCHINESE}
    SendMessage $JustDoStatusText ${JUSTDO_WM_SETTEXT} 0 "STR:${_ZH_TEXT}"
  ${Else}
    SendMessage $JustDoStatusText ${JUSTDO_WM_SETTEXT} 0 "STR:${_EN_TEXT}"
  ${EndIf}
!macroend

; Keep NSIS control 1004 visible for the application archive: the Nsis7z plug-in
; drives that native control with real extraction progress. customInstall owns a
; separate marquee only for runtime work that has no trustworthy percentage.
Function JustDoInstFilesShow
  ; MUI invokes this callback while switching away from the directory page.
  ; Configure the header and install controls as one visual update so Windows
  ; never paints a transitional frame containing both pages' text/buttons.
  SendMessage $HWNDPARENT ${JUSTDO_WM_SETREDRAW} 0 0
  FindWindow $JustDoInstFilesPage "#32770" "" $HWNDPARENT
  GetDlgItem $JustDoStatusText $JustDoInstFilesPage 1006
  GetDlgItem $JustDoNativeProgressBar $JustDoInstFilesPage 1004
  GetDlgItem $JustDoShowLogButton $JustDoInstFilesPage 1027
  GetDlgItem $JustDoInstallLog $JustDoInstFilesPage 1016
  SetCtlColors $JustDoInstFilesPage "" "F7F8FC"
  SetCtlColors $JustDoStatusText "29304A" "F7F8FC"

  ; Keep the native MUI header surface. Its dimensions differ across NSIS and
  ; Windows themes, so drawing another full-window STATIC behind it can cover
  ; the install page. Retain the system-selected dialog font so text always
  ; fits the native fixed-height controls at every DPI and language setting.
  GetDlgItem $R5 $HWNDPARENT 1037
  SetCtlColors $R5 "25213F" "FFFFFF"
  GetDlgItem $R6 $HWNDPARENT 1038
  ShowWindow $R6 0

  ; Center the remaining title within the vertical space originally shared by
  ; the title and subtitle. Derive every coordinate from the native controls
  ; so the alignment follows Windows DPI scaling instead of fixed pixels.
  System::Alloc 16
  Pop $0
  System::Call 'user32::GetWindowRect(p $R5, p r0)i.r1'
  System::Call 'user32::MapWindowPoints(p 0, p $HWNDPARENT, p r0, i 2)i.r1'
  System::Call '*$0(i .r1, i .r2, i .r3, i .r4)'
  IntOp $3 $3 - $1
  IntOp $4 $4 - $2
  StrCpy $R7 $1
  StrCpy $R8 $2
  StrCpy $R9 $3
  StrCpy $R0 $4
  System::Call 'user32::GetWindowRect(p $R6, p r0)i.r1'
  System::Call 'user32::MapWindowPoints(p 0, p $HWNDPARENT, p r0, i 2)i.r1'
  System::Call '*$0(i .r1, i .r2, i .r3, i .r4)'
  System::Free $0
  IntOp $2 $4 - $R8
  IntOp $2 $2 - $R0
  IntOp $2 $2 / 2
  IntOp $2 $2 + $R8
  System::Call 'user32::SetWindowPos(p $R5, p 0, i $R7, i r2, i $R9, i $R0, i 0x0004)'

  ${If} $LANGUAGE == ${JUSTDO_LANG_SIMPCHINESE}
  ${OrIf} $LANGUAGE == ${JUSTDO_LANG_TRADCHINESE}
    SendMessage $R5 ${JUSTDO_WM_SETTEXT} 0 "STR:正在安装 ${PRODUCT_NAME}，请稍候"
  ${Else}
    SendMessage $R5 ${JUSTDO_WM_SETTEXT} 0 "STR:Installing ${PRODUCT_NAME}, please wait"
  ${EndIf}

  ; Keep the product mark in the title bar and use the header area for a clean,
  ; uncluttered installation status.
  GetDlgItem $0 $HWNDPARENT 1039
  ShowWindow $0 0

  ; Reuse the native progress control's DPI-scaled rectangle for our overlay.
  System::Alloc 16
  Pop $0
  System::Call 'user32::GetWindowRect(p $JustDoNativeProgressBar, p r0)i.r1'
  System::Call 'user32::MapWindowPoints(p 0, p $JustDoInstFilesPage, p r0, i 2)i.r1'
  System::Call '*$0(i .r1, i .r2, i .r3, i .r4)'
  IntOp $3 $3 - $1
  IntOp $4 $4 - $2
  StrCpy $R1 $1
  StrCpy $R2 $2
  StrCpy $R3 $3
  StrCpy $R4 $4
  System::Call 'user32::CreateWindowExW(i 0, w "msctls_progress32", w "", i ${JUSTDO_PROGRESS_STYLE}, i r1, i r2, i r3, i r4, p $JustDoInstFilesPage, p 0, p 0, p 0)p.s'
  Pop $JustDoProgressBar
  System::Free $0

  ${If} $JustDoProgressBar != ""
    System::Call 'uxtheme::SetWindowTheme(p $JustDoProgressBar, w " ", w " ")'
    SendMessage $JustDoProgressBar ${JUSTDO_PBM_SETRANGE32} 0 100
    ; COLORREF values are BGR: indigo foreground on a cool-gray track.
    SendMessage $JustDoProgressBar ${JUSTDO_PBM_SETBARCOLOR} 0 0xE54F46
    SendMessage $JustDoProgressBar ${JUSTDO_PBM_SETBKCOLOR} 0 0xF0EAE7
    ShowWindow $JustDoProgressBar 0
  ${EndIf}
  ShowWindow $JustDoNativeProgressBar 5
  System::Call 'uxtheme::SetWindowTheme(p $JustDoNativeProgressBar, w " ", w " ")'
  SendMessage $JustDoNativeProgressBar ${JUSTDO_PBM_SETBARCOLOR} 0 0xE54F46
  SendMessage $JustDoNativeProgressBar ${JUSTDO_PBM_SETBKCOLOR} 0 0xF0EAE7

  ; Turn the unused details area into a light activity card. Keep the native
  ; dialog font instead of forcing a face or size; Windows selects a suitable
  ; CJK-capable font and scales it consistently with the surrounding controls.
  ShowWindow $JustDoShowLogButton 0
  System::Alloc 16
  Pop $0
  System::Call 'user32::GetClientRect(p $JustDoInstFilesPage, p r0)i.r1'
  System::Call '*$0(i .r1, i .r2, i .r3, i .r4)'
  System::Free $0
  IntOp $2 $R2 + $R4
  IntOp $2 $2 + 20
  IntOp $4 $4 - $2
  IntOp $4 $4 - 14
  System::Call 'user32::SetWindowPos(p $JustDoInstallLog, p 0, i $R1, i r2, i $R3, i r4, i 0x0004)'
  ShowWindow $JustDoInstallLog 5
  SetCtlColors $JustDoInstallLog "4C526B" "FFFFFF"

  !insertmacro JustDoSetInstallStatus \
    "正在准备应用组件；进度条显示当前解压/写入进度…" \
    "Preparing application components; the bar shows current extraction/write progress…"
  !insertmacro JustDoAddInstallActivity \
    "已确认安装位置" \
    "Installation location confirmed"
  !insertmacro JustDoAddInstallActivity \
    "正在准备应用组件" \
    "Preparing application components"
  !insertmacro JustDoLogInstallEvent "phase=install-page-shown status=preparing-core-application-files"
  SendMessage $HWNDPARENT ${JUSTDO_WM_SETREDRAW} 1 0
  System::Call 'user32::RedrawWindow(p $HWNDPARENT, p 0, p 0, i ${JUSTDO_RDW_ATOMIC_REFRESH})i.r0'
FunctionEnd

!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW JustDoInstFilesShow
!macroend
!endif

!macro FindJustDoProcesses _RESULT
  ; Return 0 only when a process whose executable lives in this installation
  ; is running. Exclude the calling installer/uninstaller and this PowerShell
  ; helper so an installer launched from $INSTDIR cannot match itself.
  System::Call 'Kernel32::GetCurrentProcessId()i.r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("JUSTDO_INSTALL_ROOT", "$INSTDIR").r1'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("JUSTDO_CALLER_PID", "$0").r1'
  nsExec::ExecToStack /TIMEOUT=15000 '"${JUSTDO_POWERSHELL}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\justdo-process-helper.ps1" -Action Find'
  Pop ${_RESULT}
  Pop $R9
  System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_INSTALL_ROOT", t "")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_CALLER_PID", t "")i'
!macroend

!macro WaitForJustDoProcesses _RESULT _MAX_ATTEMPTS
  ; Poll inside one PowerShell process. Re-launching PowerShell for each 500 ms
  ; check would make graceful shutdown noticeably slower.
  System::Call 'Kernel32::GetCurrentProcessId()i.r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("JUSTDO_INSTALL_ROOT", "$INSTDIR").r1'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("JUSTDO_CALLER_PID", "$0").r1'
  nsExec::ExecToStack /TIMEOUT=90000 '"${JUSTDO_POWERSHELL}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\justdo-process-helper.ps1" -Action Wait -MaxAttempts ${_MAX_ATTEMPTS}'
  Pop ${_RESULT}
  Pop $R9
  System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_INSTALL_ROOT", t "")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_CALLER_PID", t "")i'
!macroend

!macro StopJustDoProcesses _RESULT
  ; Only stop processes whose executable is inside the current installation.
  ; Matching by process name or a loose "*JustDo*" path can terminate unrelated
  ; applications and development servers.
  StrCpy ${_RESULT} "0"
  ${If} "$INSTDIR" != ""
    ${If} ${FileExists} "$INSTDIR\*.*"
      ; Pass the path through the process environment instead of embedding it in
      ; PowerShell source. This preserves every Windows-legal Unicode/special path.
      System::Call 'Kernel32::GetCurrentProcessId()i.r0'
      System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("JUSTDO_INSTALL_ROOT", "$INSTDIR").r1'
      System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("JUSTDO_CALLER_PID", "$0").r1'
      nsExec::ExecToStack /TIMEOUT=15000 '"${JUSTDO_POWERSHELL}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\justdo-process-helper.ps1" -Action Stop'
      Pop ${_RESULT}
      Pop $R9
      System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_INSTALL_ROOT", t "")i'
      System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_CALLER_PID", t "")i'
    ${EndIf}
  ${EndIf}
!macroend

!ifndef BUILD_UNINSTALLER
Function JustDoStageManagedRuntimes
  System::Call 'Kernel32::GetCurrentProcessId()i.r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("JUSTDO_INSTALL_ROOT", "$INSTDIR").r1'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("JUSTDO_CALLER_PID", "$0").r1'
  nsExec::ExecToStack /TIMEOUT=30000 '"${JUSTDO_POWERSHELL}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\justdo-process-helper.ps1" -Action StageRuntimes'
  Pop $0
  Pop $R9
  System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_INSTALL_ROOT", t "")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_CALLER_PID", t "")i'
  !insertmacro JustDoLogInstallEvent "phase=runtime-staging result=$0 detail=$R9"
FunctionEnd

Function JustDoStopLegacyPythonProcesses
  ; Older releases ran the managed Python interpreter from userData, outside
  ; $INSTDIR and therefore outside the normal installed-process check. Stop
  ; only executables rooted in that exact obsolete directory. This is cleanup:
  ; access-denied and inspection failures are logged but never block setup.
  System::Call 'Kernel32::GetCurrentProcessId()i.r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("JUSTDO_INSTALL_ROOT", "$INSTDIR").r1'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("JUSTDO_USER_DATA_ROOT", "$APPDATA\${PRODUCT_NAME}").r1'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("JUSTDO_CALLER_PID", "$0").r1'
  nsExec::ExecToStack /TIMEOUT=15000 '"${JUSTDO_POWERSHELL}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\justdo-process-helper.ps1" -Action StopLegacyPython'
  Pop $0
  Pop $R9
  System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_INSTALL_ROOT", t "")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_USER_DATA_ROOT", t "")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_CALLER_PID", t "")i'
  !insertmacro JustDoLogInstallEvent "phase=legacy-python-process-stop result=$0 detail=$R9"
FunctionEnd

Function JustDoRestoreManagedRuntimes
  ${IfNot} ${FileExists} "$PLUGINSDIR\justdo-process-helper.ps1"
    StrCpy $0 "helper-missing"
    Return
  ${EndIf}
  System::Call 'Kernel32::GetCurrentProcessId()i.r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("JUSTDO_INSTALL_ROOT", "$INSTDIR").r1'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("JUSTDO_CALLER_PID", "$0").r1'
  nsExec::ExecToStack /TIMEOUT=30000 '"${JUSTDO_POWERSHELL}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\justdo-process-helper.ps1" -Action RestoreRuntimes'
  Pop $0
  Pop $R9
  System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_INSTALL_ROOT", t "")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_CALLER_PID", t "")i'
  !insertmacro JustDoLogInstallEvent "phase=runtime-restore result=$0 detail=$R9"
FunctionEnd
!endif

!macro customHeader
  ; Hide the (empty) details list — electron-builder uses 7z solid extraction
  ; which produces no per-file output, so the box would just be blank.
  ShowInstDetails nevershow
!macroend

!ifndef BUILD_UNINSTALLER
Function JustDoCheckAppRunning
  ${If} $JustDoProcessCheckComplete == "1"
    Return
  ${EndIf}
  ; Check before the large application archive is extracted. Waiting until the
  ; later atomic copy would make users sit through extraction before learning
  ; that the running app must be closed. Match only executables located under
  ; this installation root so another installation or portable copy is safe.
  !insertmacro JustDoLogInstallEvent "phase=process-check-start install-dir=$INSTDIR"
  InitPluginsDir
  File /oname=$PLUGINSDIR\justdo-process-helper.ps1 "${PROJECT_DIR}\scripts\nsis-process-helper.ps1"
  ${If} ${Silent}
    !insertmacro FindJustDoProcesses $0
    !insertmacro JustDoLogInstallEvent "phase=process-check-result mode=silent result=$0 detail=$R9"
    ${If} $0 == "0"
      !insertmacro JustDoLogInstallEvent "phase=graceful-shutdown-start mode=silent"
      ; Launch without ExecWait: a damaged older app must not be able to block
      ; setup forever before the bounded process poll even starts.
      Exec '"$INSTDIR\${APP_FILENAME}.exe" ${JUSTDO_INSTALLER_QUIT_SWITCH}'
      !insertmacro WaitForJustDoProcesses $0 120
      !insertmacro JustDoLogInstallEvent "phase=graceful-shutdown-result mode=silent result=$0 detail=$R9"
      ${If} $0 == "1"
        !insertmacro JustDoLogInstallEvent "phase=installer-abort reason=app-still-running"
        Abort "${PRODUCT_NAME} is still running after a graceful shutdown request."
      ${ElseIf} $0 != "0"
        !insertmacro JustDoLogInstallEvent "phase=installer-abort reason=process-inspection-failed"
        Abort "Setup could not verify whether ${PRODUCT_NAME} has closed."
      ${EndIf}
    ${ElseIf} $0 != "1"
      !insertmacro JustDoLogInstallEvent "phase=installer-abort reason=initial-process-inspection-failed"
      Abort "Setup could not inspect processes in the installation directory."
    ${EndIf}
  ${Else}
    JustDoInstallProcessCheck:
      !insertmacro FindJustDoProcesses $0
      !insertmacro JustDoLogInstallEvent "phase=process-check-result mode=interactive result=$0 detail=$R9"
      ${If} $0 == "0"
        ${If} $LANGUAGE == ${JUSTDO_LANG_SIMPCHINESE}
        ${OrIf} $LANGUAGE == ${JUSTDO_LANG_TRADCHINESE}
          StrCpy $1 "${PRODUCT_NAME} 正在运行。$\r$\n$\r$\n点击“是”：自动关闭旧版并继续安装。未保存的操作可能会丢失。$\r$\n点击“否”：我已从系统托盘手动退出，重新检测。$\r$\n点击“取消”：退出安装程序。"
        ${Else}
          StrCpy $1 "${PRODUCT_NAME} is running.$\r$\n$\r$\nYes: close the old version automatically and continue. Unsaved work may be lost.$\r$\nNo: I quit it manually from the system tray; check again.$\r$\nCancel: exit setup."
        ${EndIf}
        MessageBox MB_YESNOCANCEL|MB_ICONEXCLAMATION "$1" IDYES JustDoInstallAutoClose IDNO JustDoInstallProcessRetry
        !insertmacro JustDoLogInstallEvent "phase=installer-cancel reason=user-cancelled-running-app-dialog"
        Quit

        JustDoInstallProcessRetry:
          !insertmacro JustDoLogInstallEvent "phase=process-check-retry requested-by=user"
          Sleep 500
          Goto JustDoInstallProcessCheck

        JustDoInstallAutoClose:
          ; Newer releases understand this second-instance switch and run the
          ; normal Gateway/SQLite cleanup path before exiting. Older releases
          ; simply discard the second instance, so a bounded force-close below
          ; remains necessary for backward-compatible upgrades.
          !insertmacro JustDoLogInstallEvent "phase=graceful-shutdown-start mode=interactive"
          ; The bounded poll below owns the timeout. ExecWait would hang setup
          ; indefinitely if an older or damaged app never exits.
          Exec '"$INSTDIR\${APP_FILENAME}.exe" ${JUSTDO_INSTALLER_QUIT_SWITCH}'
          !insertmacro WaitForJustDoProcesses $0 20
          !insertmacro JustDoLogInstallEvent "phase=graceful-shutdown-result mode=interactive result=$0 detail=$R9"
          ${If} $0 == "0"
            Goto JustDoInstallProcessClosed
          ${EndIf}

          ${If} $0 == "1"
            !insertmacro JustDoLogInstallEvent "phase=forced-shutdown-start reason=graceful-timeout"
            !insertmacro StopJustDoProcesses $0
            !insertmacro JustDoLogInstallEvent "phase=forced-shutdown-result result=$0 detail=$R9"
          ${EndIf}
          ${If} $0 == "0"
            Goto JustDoInstallProcessClosed
          ${EndIf}

          Goto JustDoInstallInspectionFailed

        JustDoInstallProcessClosed:
          !insertmacro JustDoLogInstallEvent "phase=process-check-complete result=closed"
      ${ElseIf} $0 != "1"
        JustDoInstallInspectionFailed:
          ${If} $LANGUAGE == ${JUSTDO_LANG_SIMPCHINESE}
          ${OrIf} $LANGUAGE == ${JUSTDO_LANG_TRADCHINESE}
            StrCpy $1 "安装程序无法确认 ${PRODUCT_NAME} 是否已关闭。请点击“重试”重新检测，或点击“取消”退出安装程序。"
          ${Else}
            StrCpy $1 "Setup could not verify whether ${PRODUCT_NAME} has closed. Click Retry to check again, or Cancel to exit setup."
          ${EndIf}
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$1" IDRETRY JustDoInstallProcessRetry
          !insertmacro JustDoLogInstallEvent "phase=installer-cancel reason=process-inspection-failed"
          Quit
      ${EndIf}
  ${EndIf}
  !insertmacro JustDoLogInstallEvent "phase=process-check-complete result=ready"
  Call JustDoStopLegacyPythonProcesses
  Call JustDoStageManagedRuntimes
  ${If} $0 != "0"
    !insertmacro JustDoLogInstallEvent "phase=installer-abort reason=runtime-staging-failed result=$0"
    ${If} $LANGUAGE == ${JUSTDO_LANG_SIMPCHINESE}
    ${OrIf} $LANGUAGE == ${JUSTDO_LANG_TRADCHINESE}
      Abort "无法安全暂存旧版运行环境，安装已停止。请重试并提供安装日志。"
    ${Else}
      Abort "Setup could not safely stage the previous runtime. Retry and provide the install log."
    ${EndIf}
  ${EndIf}
  System::Call 'kernel32::GetTickCount()i.r0'
  StrCpy $JustDoCoreInstallStartedTick $0
  !insertmacro JustDoLogInstallEvent "phase=electron-builder-core-start steps=old-version-cleanup,archive-extraction,atomic-copy,registry,shortcuts"
  !insertmacro JustDoSetInstallStatus \
    "正在解压并写入应用文件…" \
    "Extracting and writing application files…"
  !insertmacro JustDoAddInstallActivity \
    "正在将应用文件解压到安全临时目录并写入安装位置" \
    "Expanding application files to a safe staging area and writing the installation"
  System::Call 'user32::UpdateWindow(p $JustDoInstFilesPage)i.r0'
  System::Call 'user32::UpdateWindow(p $HWNDPARENT)i.r0'
  StrCpy $JustDoProcessCheckComplete "1"
FunctionEnd

!macro customCheckAppRunning
  Call JustDoCheckAppRunning
!macroend
!endif

!macro customInit
  CreateDirectory "$APPDATA\${PRODUCT_NAME}"
  StrCpy $JustDoInstallLogPath "$APPDATA\${PRODUCT_NAME}\install-timing.log"
  StrCpy $JustDoResourceLogPath "$APPDATA\${PRODUCT_NAME}\install-resource.log"
  System::Call 'kernel32::GetTickCount()i.r0'
  StrCpy $JustDoInstallStartedTick $0
  StrCpy $JustDoCoreInstallStartedTick 0
  StrCpy $JustDoProcessCheckComplete "0"

  ; Keep prior sessions in the same append-only files: retries and the outer/
  ; elevated inner UAC instances must not erase the evidence from one another.
  ; Probe the resource log now and fall back to TEMP if APPDATA is unavailable.
  ClearErrors
  FileOpen $2 "$JustDoResourceLogPath" a
  ${If} ${Errors}
    StrCpy $JustDoResourceLogPath "$TEMP\${APP_FILENAME}-install-resource.log"
    ClearErrors
    FileOpen $2 "$JustDoResourceLogPath" a
  ${EndIf}
  ${IfNot} ${Errors}
    FileClose $2
  ${Else}
    StrCpy $JustDoResourceLogPath ""
  ${EndIf}

  ClearErrors
  ClearErrors
  FileOpen $2 "$JustDoInstallLogPath" a
  ${If} ${Errors}
    ClearErrors
    FileOpen $2 "NUL" w
  ${EndIf}
  ${If} ${Errors}
    StrCpy $JustDoInstallLogPath "$TEMP\${APP_FILENAME}-install-timing.log"
    ClearErrors
    FileOpen $2 "$JustDoInstallLogPath" a
  ${EndIf}
  ${If} ${Errors}
    ; Keep all later FileWrite calls harmless even when both diagnostic
    ; locations are unavailable.
    StrCpy $JustDoInstallLogPath ""
    ClearErrors
    FileOpen $2 "NUL" w
  ${EndIf}
  ${GetTime} "" "L" $3 $4 $5 $6 $7 $8 $9
  FileWrite $2 "$\r$\n=== installer-session-start ===$\r$\n"
  FileWrite $2 "init-start: $5-$4-$3 $7:$8:$9$\r$\n"
  FileWrite $2 "log-format-version: 2$\r$\n"
  FileWrite $2 "product: ${PRODUCT_NAME} ${VERSION}$\r$\n"
  FileWrite $2 "app-filename: ${APP_FILENAME}$\r$\n"
  FileWrite $2 "app-executable: ${APP_EXECUTABLE_FILENAME}$\r$\n"
  FileWrite $2 "installer-exe: $EXEPATH$\r$\n"
  ClearErrors
  FileOpen $0 "$EXEPATH" r
  ${IfNot} ${Errors}
    FileSeek $0 0 END $1
    FileClose $0
    FileWrite $2 "installer-size-bytes: $1$\r$\n"
  ${Else}
    FileWrite $2 "installer-size-bytes: unavailable$\r$\n"
  ${EndIf}
  FileWrite $2 "command-line: omitted-for-privacy$\r$\n"
  FileWrite $2 "initial-instdir: $INSTDIR$\r$\n"
  FileWrite $2 "appdata: $APPDATA$\r$\n"
  FileWrite $2 "localappdata: $LOCALAPPDATA$\r$\n"
  FileWrite $2 "temp: $TEMP$\r$\n"
  ${If} ${RunningX64}
    FileWrite $2 "running-x64: yes$\r$\n"
  ${Else}
    FileWrite $2 "running-x64: no$\r$\n"
  ${EndIf}
  ${If} ${Silent}
    FileWrite $2 "silent: yes$\r$\n"
  ${Else}
    FileWrite $2 "silent: no$\r$\n"
  ${EndIf}
  ${If} ${UAC_IsAdmin}
    FileWrite $2 "uac-admin: yes$\r$\n"
  ${Else}
    FileWrite $2 "uac-admin: no$\r$\n"
  ${EndIf}
  FileWrite $2 "detected-per-user-installation: $hasPerUserInstallation$\r$\n"
  FileWrite $2 "detected-per-machine-installation: $hasPerMachineInstallation$\r$\n"
  FileWrite $2 "installer-language-id: $LANGUAGE$\r$\n"
  FileWrite $2 "resource-detail-log: $JustDoResourceLogPath$\r$\n"
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  FileWrite $2 "registry-hkcu-install-location: $0$\r$\n"
  ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  FileWrite $2 "registry-hklm-install-location: $0$\r$\n"
  FileClose $2
  ClearErrors
  !insertmacro JustDoLogInstallEvent "phase=installer-init-complete"
  ${If} ${Silent}
    ; Silent elevated inner instances skip electron-builder's CHECK_APP_RUNNING;
    ; perform the same bounded safety check here so no path can overwrite a
    ; running installation.
    Call JustDoCheckAppRunning
  ${EndIf}
!macroend

!macro customInstall
  ; ─── Install Timing Log ───
  ; Write timestamps to help diagnose slow installation phases.
  ; Log file: %APPDATA%\${PRODUCT_NAME}\install-timing.log

  CreateDirectory "$APPDATA\${PRODUCT_NAME}"
  ; The old uninstaller has now removed the previous app shell. Restore the
  ; same-volume, directory-level runtime staging so unpack-cfmind can replace it
  ; transactionally and roll it back if the new archive is invalid.
  Call JustDoRestoreManagedRuntimes
  ${If} $0 != "0"
    !insertmacro JustDoLogInstallEvent "phase=installer-abort reason=runtime-restore-failed result=$0"
    ${If} $LANGUAGE == ${JUSTDO_LANG_SIMPCHINESE}
    ${OrIf} $LANGUAGE == ${JUSTDO_LANG_TRADCHINESE}
      Abort "无法恢复旧版运行环境，安装已停止。请重试并提供安装日志。"
    ${Else}
      Abort "Setup could not restore the previous runtime. Retry and provide the install log."
    ${EndIf}
  ${EndIf}
  System::Call 'kernel32::GetTickCount()i.r0'
  ${If} $JustDoCoreInstallStartedTick != 0
    IntOp $1 $0 - $JustDoCoreInstallStartedTick
    !insertmacro JustDoLogInstallEvent "phase=electron-builder-core-complete duration-ms=$1"
  ${Else}
    !insertmacro JustDoLogInstallEvent "phase=electron-builder-core-complete duration-ms=unavailable"
  ${EndIf}
  FileOpen $2 "$JustDoInstallLogPath" a

  ${GetTime} "" "L" $3 $4 $5 $6 $7 $8 $9
  FileWrite $2 "custom-install-start: $5-$4-$3 $7:$8:$9$\r$\n"
  ; NSIS has finished the application archive. The remaining runtime work mixes
  ; streaming extraction, validation and transactional filesystem operations,
  ; so no single percentage would be truthful. Keep the bar stationary until
  ; the extractor reports a measured value; status/activity text shows work.
  StrCpy $JustDoLastResourceProgress "0"
  ${If} $JustDoProgressBar != ""
    SendMessage $JustDoProgressBar ${JUSTDO_PBM_SETMARQUEE} 0 0
    ShowWindow $JustDoProgressBar 0
  ${EndIf}
  ShowWindow $JustDoNativeProgressBar 5
  SendMessage $JustDoNativeProgressBar ${JUSTDO_PBM_SETRANGE32} 0 100
  SendMessage $JustDoNativeProgressBar ${JUSTDO_PBM_SETPOS} $JustDoLastResourceProgress 0
  !insertmacro JustDoSetInstallStatus \
    "应用文件已就绪，正在配置运行环境（安装程序仍在运行）…" \
    "Application files are ready. Configuring the runtime; setup is still working…"
  !insertmacro JustDoAddInstallActivity \
    "应用文件写入完成" \
    "Application files written"
  !insertmacro JustDoAddInstallActivity \
    "正在配置本地运行环境" \
    "Configuring the local runtime"
  FileWrite $2 "install-mode: $installMode$\r$\n"
  FileWrite $2 "final-instdir: $INSTDIR$\r$\n"
  FileWrite $2 "app-exe-path: $INSTDIR\${APP_EXECUTABLE_FILENAME}$\r$\n"
  FileWrite $2 "resources-dir: $INSTDIR\resources$\r$\n"
  FileWrite $2 "launch-link: $launchLink$\r$\n"
  FileWrite $2 "resource-detail-log: $JustDoResourceLogPath$\r$\n"
  FileWrite $2 "extract-done: $5-$4-$3 $7:$8:$9$\r$\n"
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  FileWrite $2 "post-install-registry-hkcu-install-location: $0$\r$\n"
  ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  FileWrite $2 "post-install-registry-hklm-install-location: $0$\r$\n"
  ${If} ${FileExists} "$INSTDIR\*.*"
    FileWrite $2 "install-dir: exists$\r$\n"
  ${Else}
    FileWrite $2 "install-dir: missing$\r$\n"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\resources\*.*"
    FileWrite $2 "resources-dir: exists$\r$\n"
  ${Else}
    FileWrite $2 "resources-dir: missing$\r$\n"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\resources\app.asar"
    FileWrite $2 "app-asar: exists$\r$\n"
  ${Else}
    FileWrite $2 "app-asar: missing $INSTDIR\resources\app.asar$\r$\n"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\resources\cfmind\*.*"
    FileWrite $2 "pre-existing-cfmind-dir: exists$\r$\n"
  ${Else}
    FileWrite $2 "pre-existing-cfmind-dir: missing$\r$\n"
  ${EndIf}

  ; ─── Extract combined resource archive (win-resources.tar.zst) ───
  ; All large resource directories (cfmind/, skills/, python-win/) are packed
  ; into one pre-compressed file. NSIS writes it without a second compression
  ; pass; Electron/Node decodes zstd into a Windows native tar input stream.

  SetDetailsPrint none

  FileWrite $2 "set-details-print: none$\r$\n"
  FileWrite $2 "set-electron-run-as-node: start$\r$\n"
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")i'
  Pop $0
  System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_INSTALLER_PYTHON_IMPORT_CHECK", t "1")i'
  Pop $0
  FileWrite $2 "set-electron-run-as-node: result=$0$\r$\n"

  ${GetTime} "" "L" $3 $4 $5 $6 $7 $8 $9
  FileWrite $2 "tar-extract-start: $5-$4-$3 $7:$8:$9$\r$\n"
  !insertmacro JustDoSetInstallStatus \
    "正在展开核心资源；此阶段无法精确计算百分比，请稍候…" \
    "Expanding core resources; an exact percentage is unavailable. Please wait…"
  !insertmacro JustDoAddInstallActivity \
    "正在整理核心资源" \
    "Preparing core resources"
  FileWrite $2 "tar-extract-command: $INSTDIR\${APP_EXECUTABLE_FILENAME} $INSTDIR\resources\unpack-cfmind.cjs $INSTDIR\resources\win-resources.tar.zst $INSTDIR\resources $APPDATA\${PRODUCT_NAME} $INSTDIR\resources\win-resources-metadata.json <progress-file> $JustDoResourceLogPath$\r$\n"
  FileWrite $2 "tar-extract-detail-log: $JustDoResourceLogPath$\r$\n"
  ${If} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    FileWrite $2 "app-exe: exists$\r$\n"
  ${Else}
    FileWrite $2 "app-exe: missing $INSTDIR\${APP_EXECUTABLE_FILENAME}$\r$\n"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\resources\unpack-cfmind.cjs"
    FileWrite $2 "unpack-script: exists$\r$\n"
  ${Else}
    FileWrite $2 "unpack-script: missing $INSTDIR\resources\unpack-cfmind.cjs$\r$\n"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\resources\win-resources.tar.zst"
    FileWrite $2 "resource-tar: exists$\r$\n"
  ${Else}
    FileWrite $2 "resource-tar: missing $INSTDIR\resources\win-resources.tar.zst$\r$\n"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\resources\win-resources-metadata.json"
    FileWrite $2 "resource-metadata: exists$\r$\n"
  ${Else}
    FileWrite $2 "resource-metadata: missing $INSTDIR\resources\win-resources-metadata.json$\r$\n"
  ${EndIf}

  ; Launch the extractor asynchronously. Interactive installs poll the encoded
  ; process handle and atomic progress file without blocking the NSIS window;
  ; silent deployments use StdUtils' blocking wait because no UI is present.
  StrCpy $JustDoResourceProgressFile "$PLUGINSDIR\justdo-resource-progress.txt"
  StrCpy $JustDoLastResourceActivity ""
  Delete "$JustDoResourceProgressFile"
  ${If} $JustDoProgressBar != ""
    SendMessage $JustDoProgressBar ${JUSTDO_PBM_SETMARQUEE} 0 0
    ShowWindow $JustDoProgressBar 0
  ${EndIf}
  ${StdUtils.ExecShellWaitEx} $R7 $R8 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "open" '"$INSTDIR\resources\unpack-cfmind.cjs" "$INSTDIR\resources\win-resources.tar.zst" "$INSTDIR\resources" "$APPDATA\${PRODUCT_NAME}" "$INSTDIR\resources\win-resources-metadata.json" "$JustDoResourceProgressFile" "$JustDoResourceLogPath"'
  ${If} $R7 != "ok"
    FileWrite $2 "tar-extract-launch-error: result=$R7 detail=$R8$\r$\n"
    StrCpy $0 "launch-$R7-$R8"
    Goto TarExtractFailed
  ${EndIf}

  ${If} ${Silent}
    ${StdUtils.WaitForProcEx} $0 $R8
  ${Else}
    ; StdUtils serializes the native handle as hProc:XXXXXXXX. Parse the
    ; plug-in token for non-blocking WaitForSingleObject polling,
    ; then return the original token to WaitForProcEx once signaled so it owns
    ; final exit-code retrieval and handle cleanup.
    StrCpy $R9 $R8 6
    ${If} $R9 == "hProc:"
      StrCpy $R9 $R8 "" 6
      StrCpy $R9 "0x$R9"
      JustDoResourceWait:
        Sleep 150
        Call JustDoPollResourceProgress
        System::Call 'kernel32::WaitForSingleObject(p $R9, i 0)i.r0'
        ${If} $0 == 258
          Goto JustDoResourceWait
        ${ElseIf} $0 != 0
          System::Call 'kernel32::GetLastError()i.r1'
          FileWrite $2 "tar-extract-poll-error: wait=$0 win32=$1; using blocking fallback$\r$\n"
        ${EndIf}
    ${Else}
      FileWrite $2 "tar-extract-handle-format: unexpected $R8; using blocking fallback$\r$\n"
    ${EndIf}
    ${StdUtils.WaitForProcEx} $0 $R8
  ${EndIf}
  Call JustDoPollResourceProgress

  Delete "$JustDoResourceProgressFile"
  StrCpy $JustDoResourceProgressFile ""
  FileWrite $2 "tar-extract-process-exit: $0$\r$\n"

  StrCmp $0 "0" TarExtractOK
    TarExtractFailed:
    ${If} $JustDoProgressBar != ""
      SendMessage $JustDoProgressBar ${JUSTDO_PBM_SETMARQUEE} 0 0
    ${EndIf}
    Delete "$JustDoResourceProgressFile"
    StrCpy $JustDoResourceProgressFile ""
    FileWrite $2 "tar-extract-error: exit=$0$\r$\n"
    ${If} $LANGUAGE == ${JUSTDO_LANG_SIMPCHINESE}
    ${OrIf} $LANGUAGE == ${JUSTDO_LANG_TRADCHINESE}
      StrCpy $1 "核心资源展开失败（退出码 $0）。诊断日志可能包含本机文件路径，请确认后提供给技术支持。"
    ${Else}
      StrCpy $1 "Core resource extraction failed (exit code $0). Diagnostic logs can contain local file paths; review them before sharing with support."
    ${EndIf}
    ${If} $JustDoInstallLogPath != ""
    ${AndIf} ${FileExists} "$JustDoInstallLogPath"
      StrCpy $1 "$1$\r$\n$JustDoInstallLogPath"
    ${EndIf}
    ${If} $JustDoResourceLogPath != ""
    ${AndIf} ${FileExists} "$JustDoResourceLogPath"
      StrCpy $1 "$1$\r$\n$JustDoResourceLogPath"
    ${EndIf}
    MessageBox MB_OK|MB_ICONEXCLAMATION "$1"
    System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "")i'
    System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_INSTALLER_PYTHON_IMPORT_CHECK", t "")i'
    SetDetailsPrint both
    FileClose $2
    Abort "Resource extraction failed."
  TarExtractOK:

  ${GetTime} "" "L" $3 $4 $5 $6 $7 $8 $9
  FileWrite $2 "tar-extract-done: $5-$4-$3 $7:$8:$9 exit=$0$\r$\n"
  !insertmacro JustDoSetInstallStatus \
    "核心资源已就绪，正在完成配置（安装程序仍在运行）…" \
    "Core resources are ready. Finishing setup; setup is still working…"
  !insertmacro JustDoAddInstallActivity \
    "核心资源准备完成" \
    "Core resources prepared"
  ${If} ${FileExists} "$INSTDIR\resources\cfmind\*.*"
    FileWrite $2 "cfmind-dir-after-tar: exists$\r$\n"
  ${Else}
    FileWrite $2 "cfmind-dir-after-tar: missing$\r$\n"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\resources\skills\*.*"
    FileWrite $2 "skills-dir-after-tar: exists$\r$\n"
  ${Else}
    FileWrite $2 "skills-dir-after-tar: missing$\r$\n"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\resources\python-win\python.exe"
    FileWrite $2 "python-runtime-after-tar: exists$\r$\n"
  ${Else}
    FileWrite $2 "python-runtime-after-tar: missing$\r$\n"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\resources\mingit\cmd\git.exe"
    FileWrite $2 "mingit-after-tar: exists$\r$\n"
  ${Else}
    FileWrite $2 "mingit-after-tar: missing$\r$\n"
  ${EndIf}

  ; ─── Legacy dependency manager config cleanup ───
  ; Current builds use the packaged config directly. Remove only the two files
  ; managed by older installers, preserving any unrelated user files.
  !insertmacro JustDoSetInstallStatus \
    "正在写入本机配置（安装程序仍在运行）…" \
    "Writing local configuration; setup is still working…"
  !insertmacro JustDoAddInstallActivity \
    "正在保存本机配置" \
    "Saving local configuration"
  Delete "$APPDATA\${PRODUCT_NAME}\dependency-config\.npmrc"
  Delete "$APPDATA\${PRODUCT_NAME}\dependency-config\pip.ini"
  RMDir "$APPDATA\${PRODUCT_NAME}\dependency-config"
  FileWrite $2 "dependency-config-legacy: cleanup-complete$\r$\n"

  FileWrite $2 "delete-resource-tar: start$\r$\n"
  Delete "$INSTDIR\resources\win-resources.tar.zst"
  Delete "$INSTDIR\resources\win-resources-metadata.json"
  ${If} ${FileExists} "$INSTDIR\resources\win-resources.tar.zst"
    FileWrite $2 "delete-resource-tar: still-exists$\r$\n"
  ${Else}
    FileWrite $2 "delete-resource-tar: removed$\r$\n"
  ${EndIf}

  FileWrite $2 "clear-electron-run-as-node: start$\r$\n"
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "")i'
  Pop $0
  System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_INSTALLER_PYTHON_IMPORT_CHECK", t "")i'
  Pop $0
  FileWrite $2 "clear-electron-run-as-node: result=$0$\r$\n"

  ; Marks installations completed by NSIS. Packaged-but-uninstalled win-unpacked
  ; directories do not contain this file and must not enable auto-update.
  FileOpen $0 "$INSTDIR\resources\.justdo-nsis-installed" w
  FileWrite $0 "${VERSION}$\r$\n"
  FileClose $0
  FileWrite $2 "nsis-install-marker: written$\r$\n"
  !insertmacro JustDoSetInstallStatus \
    "正在进行最后检查（安装程序仍在运行）…" \
    "Running final checks; setup is still working…"
  !insertmacro JustDoAddInstallActivity \
    "本机配置已保存" \
    "Local configuration saved"

  ; Clean up the unpack script — no longer needed after installation
  FileWrite $2 "delete-unpack-script: start$\r$\n"
  Delete "$INSTDIR\resources\unpack-cfmind.cjs"
  ${If} ${FileExists} "$INSTDIR\resources\unpack-cfmind.cjs"
    FileWrite $2 "delete-unpack-script: still-exists$\r$\n"
  ${Else}
    FileWrite $2 "delete-unpack-script: removed$\r$\n"
  ${EndIf}

  ${GetTime} "" "L" $3 $4 $5 $6 $7 $8 $9
  FileWrite $2 "install-done: $5-$4-$3 $7:$8:$9$\r$\n"
  ${If} $JustDoProgressBar != ""
    SendMessage $JustDoProgressBar ${JUSTDO_PBM_SETMARQUEE} 0 0
    ShowWindow $JustDoProgressBar 0
  ${EndIf}
  ShowWindow $JustDoNativeProgressBar 5
  SendMessage $JustDoNativeProgressBar ${JUSTDO_PBM_SETPOS} 100 0
  !insertmacro JustDoSetInstallStatus \
    "安装完成，即将进入下一步。" \
    "Installation complete. Continuing…"
  !insertmacro JustDoAddInstallActivity \
    "安装完成" \
    "Installation complete"
  FileClose $2

  SetDetailsPrint both
!macroend

!macro customUnInit
  ; In interactive mode, ask the user to close the app instead of silently
  ; killing it. Closing the main app also gives its gateway and child processes
  ; a chance to shut down cleanly. Silent uninstall keeps the non-interactive
  ; cleanup behavior expected by managed deployment tools.
  InitPluginsDir
  File /oname=$PLUGINSDIR\justdo-process-helper.ps1 "${PROJECT_DIR}\scripts\nsis-process-helper.ps1"
  ${If} ${Silent}
    !insertmacro StopJustDoProcesses $0
  ${Else}
    JustDoUninstallProcessCheck:
      !insertmacro FindJustDoProcesses $0
      ${If} $0 == "0"
        ${If} $LANGUAGE == ${LANG_SIMPCHINESE}
        ${OrIf} $LANGUAGE == ${LANG_TRADCHINESE}
          StrCpy $1 "${PRODUCT_NAME} 正在运行。请先关闭应用，然后点击“重试”继续卸载；点击“取消”退出卸载程序。"
        ${Else}
          StrCpy $1 "${PRODUCT_NAME} is currently running. Close the app, then click Retry to continue uninstalling, or click Cancel to exit."
        ${EndIf}
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$1" IDRETRY JustDoUninstallProcessRetry
        Quit

        JustDoUninstallProcessRetry:
          Sleep 500
          Goto JustDoUninstallProcessCheck
      ${EndIf}
  ${EndIf}
!macroend
