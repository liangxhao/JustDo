!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "StdUtils.nsh"
!include "TextFunc.nsh"
!include "x64.nsh"
!include "UAC.nsh"

!define JUSTDO_INSTALLER_QUIT_SWITCH "--justdo-request-quit-for-update"

; NSIS FileOpen ... a only seeks once when opening. Long-lived handles would
; overwrite records appended by callbacks or another installer process. Windows
; FILE_APPEND_DATA without FILE_WRITE_DATA appends each FileWrite atomically.
!macro JustDoOpenAppendLog _HANDLE _PATH
  ClearErrors
  System::Call 'kernel32::CreateFileW(t "${_PATH}", i 0x00000004, i 0x00000003, p 0, i 4, i 0x80, p 0) i.s'
  Pop ${_HANDLE}
  ${If} ${_HANDLE} == -1
    SetErrors
  ${EndIf}
!macroend

!macro JustDoResolveNativePowerShell _OUTPUT
  StrCpy ${_OUTPUT} "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ${If} ${RunningX64}
    ; The installer process is 32-bit. Sysnative bypasses WOW64 filesystem
    ; redirection so Get-Process can resolve paths for the 64-bit application.
    StrCpy ${_OUTPUT} "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${EndIf}
!macroend

!ifndef BUILD_UNINSTALLER
!define MUI_CUSTOMFUNCTION_ABORT JustDoInstallerUserAbort
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
Var JustDoPristineInstall
Var JustDoInstallTerminalState
Var JustDoInstallerPid
Var JustDoInstallerSessionId
Var JustDoInstallerSessionEnded
Var JustDoLastInstallEvent
Var JustDoInstallMode
Var JustDoInstallLogDirectory
Var JustDoCurrentUserAppData
Var JustDoCurrentUserLocalAppData
Var JustDoCurrentTemp
Var JustDoInstallerDirectory
Var JustDoExtractorTempDirectory
Var JustDoExtractorActive
Var JustDoExtractorEnvironmentConfigured
Var JustDoPreviousTemp
Var JustDoPreviousTmp

Function JustDoCleanupExtractorEnvironment
  Push $0
  Push $1
  ${If} $JustDoExtractorEnvironmentConfigured == "1"
    System::Call 'Kernel32::SetEnvironmentVariable(t "TEMP", t "$JustDoPreviousTemp")i.r0'
    System::Call 'Kernel32::SetEnvironmentVariable(t "TMP", t "$JustDoPreviousTmp")i.r0'
    System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_INSTALLER_TEMP_ROOT", t "")i.r0'
    System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_INSTALLER_ORIGINAL_TEMP_ROOT", t "")i.r0'
    StrCpy $JustDoExtractorEnvironmentConfigured "0"
  ${EndIf}
  ${If} $JustDoExtractorTempDirectory != ""
    System::Call 'Kernel32::GetFileAttributes(t "$JustDoExtractorTempDirectory")i.r0'
    ${If} $0 != -1
      IntOp $1 $0 & 0x400
      ${If} $1 != 0
        ; Never recursively follow a directory junction or other reparse point.
        RMDir "$JustDoExtractorTempDirectory"
      ${Else}
        ; The extractor owns recursive cleanup because it can validate the
        ; complete path tree before deletion. Setup only removes an empty root,
        ; avoiding a check/delete junction-replacement race in a user-writable
        ; installation directory.
        RMDir "$JustDoExtractorTempDirectory"
      ${EndIf}
    ${EndIf}
    System::Call 'Kernel32::GetFileAttributes(t "$JustDoExtractorTempDirectory")i.r0'
    ${If} $0 == -1
      StrCpy $JustDoExtractorTempDirectory ""
    ${EndIf}
  ${EndIf}
  StrCpy $JustDoExtractorActive "0"
  Pop $1
  Pop $0
FunctionEnd

!macro JustDoTryInstallLogDirectory _BASE _DIRECTORY_NAME
  ${If} $JustDoInstallLogDirectory == ""
  ${AndIf} ${_BASE} != ""
    StrCpy $1 "${_BASE}\${_DIRECTORY_NAME}"
    CreateDirectory "$1"
    StrCpy $JustDoInstallLogPath "$1\install-timing.log"
    StrCpy $JustDoResourceLogPath "$1\install-resource.log"
    ClearErrors
    !insertmacro JustDoOpenAppendLog $0 "$JustDoInstallLogPath"
    ${IfNot} ${Errors}
      FileClose $0
      ClearErrors
      !insertmacro JustDoOpenAppendLog $0 "$JustDoResourceLogPath"
      ${IfNot} ${Errors}
        FileClose $0
        StrCpy $JustDoInstallLogDirectory "$1"
      ${EndIf}
    ${EndIf}
    ${If} $JustDoInstallLogDirectory == ""
      StrCpy $JustDoInstallLogPath ""
      StrCpy $JustDoResourceLogPath ""
      ClearErrors
    ${EndIf}
  ${EndIf}
!macroend

Function JustDoSelectInstallLogDirectory
  Push $0
  Push $1
  StrCpy $JustDoInstallLogDirectory ""
  StrCpy $JustDoInstallLogPath ""
  StrCpy $JustDoResourceLogPath ""
  !insertmacro JustDoTryInstallLogDirectory "$JustDoCurrentUserAppData" "${PRODUCT_NAME}"
  !insertmacro JustDoTryInstallLogDirectory "$JustDoCurrentUserLocalAppData" "${PRODUCT_NAME}"
  !insertmacro JustDoTryInstallLogDirectory "$JustDoCurrentTemp" "${APP_FILENAME}-installer-logs"
  !insertmacro JustDoTryInstallLogDirectory "$JustDoInstallerDirectory" "${APP_FILENAME}-installer-logs"
  ClearErrors
  Pop $1
  Pop $0
FunctionEnd

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
  Push $R0

  StrCpy $JustDoLastInstallEvent "$0"
  System::Call 'kernel32::GetTickCount()i.r1'
  IntOp $1 $1 - $JustDoInstallStartedTick
  ${GetTime} "" "L" $2 $3 $4 $5 $6 $7 $8
  StrCpy $R0 "$JustDoInstallLogPath"
  ${If} $JustDoInstallLogPath != ""
    ClearErrors
    !insertmacro JustDoOpenAppendLog $9 "$JustDoInstallLogPath"
  ${Else}
    SetErrors
  ${EndIf}
  ${If} ${Errors}
    ; Re-select a directory where both lifecycle and resource logs are writable
    ; so diagnostics never silently split across unrelated locations.
    Call JustDoSelectInstallLogDirectory
    ClearErrors
    !insertmacro JustDoOpenAppendLog $9 "$JustDoInstallLogPath"
  ${EndIf}
  ${IfNot} ${Errors}
    ${If} $R0 != ""
    ${AndIf} $R0 != $JustDoInstallLogPath
      FileWrite $9 "$4-$3-$2 $6:$7:$8 elapsed-ms=$1 pid=$JustDoInstallerPid session=$JustDoInstallerSessionId phase=install-log-relocated previous=$R0 current=$JustDoInstallLogPath$\r$\n"
    ${EndIf}
    FileWrite $9 "$4-$3-$2 $6:$7:$8 elapsed-ms=$1 pid=$JustDoInstallerPid session=$JustDoInstallerSessionId $0$\r$\n"
    FileClose $9
  ${Else}
    StrCpy $JustDoInstallLogPath ""
  ${EndIf}
  ; Diagnostics are best-effort and must never leak their error flag into the
  ; installer flow, where later IfErrors checks control rollback behavior.
  ClearErrors

  Pop $R0
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

Function JustDoWriteInstallSessionEnd
  ${If} $JustDoInstallerSessionId == ""
  ${OrIf} $JustDoInstallerSessionEnded == "1"
    Return
  ${EndIf}
  StrCpy $JustDoInstallerSessionEnded "1"
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  ${GetTime} "" "L" $0 $1 $2 $3 $4 $5 $6
  ClearErrors
  !insertmacro JustDoOpenAppendLog $7 "$JustDoInstallLogPath"
  ${IfNot} ${Errors}
    FileWrite $7 "====================================================================================================$\r$\n"
    FileWrite $7 "INSTALL SESSION END | timestamp=$2-$1-$0 $4:$5:$6 | session=$JustDoInstallerSessionId | pid=$JustDoInstallerPid | version=${VERSION} | terminal-state=$JustDoInstallTerminalState$\r$\n"
    FileWrite $7 "====================================================================================================$\r$\n$\r$\n"
    FileClose $7
  ${EndIf}
  ClearErrors
  !insertmacro JustDoOpenAppendLog $7 "$JustDoResourceLogPath"
  ${IfNot} ${Errors}
    FileWrite $7 "====================================================================================================$\r$\n"
    FileWrite $7 "INSTALL SESSION END | timestamp=$2-$1-$0 $4:$5:$6 | session=$JustDoInstallerSessionId | pid=$JustDoInstallerPid | version=${VERSION} | terminal-state=$JustDoInstallTerminalState$\r$\n"
    FileWrite $7 "====================================================================================================$\r$\n$\r$\n"
    FileClose $7
  ${EndIf}
  ClearErrors
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

Function JustDoInstallerUserAbort
  ${If} $JustDoExtractorActive == "1"
    MessageBox MB_OK|MB_ICONINFORMATION "核心资源仍在安全写入和校验中，请等待此步骤完成后再关闭安装程序。 Core resources are still being written and verified; wait for this step to finish before closing setup." /SD IDOK
    Abort
  ${EndIf}
  StrCpy $JustDoInstallTerminalState "user-cancelled"
  !insertmacro JustDoLogInstallEvent "phase=installer-cancel reason=wizard-user-abort"
FunctionEnd

Function .onInstSuccess
  StrCpy $JustDoInstallTerminalState "success"
  !insertmacro JustDoLogInstallEvent "phase=installer-success status=completed version=${VERSION} install-mode=$JustDoInstallMode install-dir=$INSTDIR core-validation=passed"
  Call JustDoWriteInstallSessionEnd
FunctionEnd

Function .onInstFailed
  StrCpy $JustDoInstallTerminalState "failed"
  GetErrorLevel $1
  System::Call 'kernel32::GetLastError()i.r0'
  !insertmacro JustDoLogInstallEvent "phase=installer-failed status=terminated-before-success error-level=$1 win32-last-error=$0"
  Call JustDoRestoreManagedRuntimes
  Call JustDoCleanupExtractorEnvironment
  ${If} $JustDoExtractorTempDirectory != ""
    !insertmacro JustDoLogInstallEvent "phase=extractor-temp-cleanup-incomplete"
  ${EndIf}
  !insertmacro JustDoLogInstallEvent "phase=installer-failed-cleanup-complete runtime-restore-result=$0"
  Call JustDoWriteInstallSessionEnd
FunctionEnd

Function .onGUIEnd
  ${If} $JustDoInstallTerminalState == ""
    StrCpy $JustDoInstallTerminalState "ended-before-pre-init"
  ${ElseIf} $JustDoInstallTerminalState == "running"
    StrCpy $JustDoInstallTerminalState "closed-without-success-callback"
  ${EndIf}
  !insertmacro JustDoLogInstallEvent "phase=installer-session-end terminal-state=$JustDoInstallTerminalState last-event=$JustDoLastInstallEvent"
  ${If} $JustDoExtractorActive != "1"
    Call JustDoCleanupExtractorEnvironment
    ${If} $JustDoExtractorTempDirectory != ""
      !insertmacro JustDoLogInstallEvent "phase=extractor-temp-cleanup-incomplete"
    ${EndIf}
  ${EndIf}
  Call JustDoWriteInstallSessionEnd
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
  ; electron-builder defers the final all-users mode and custom directory until
  ; after customInit. Its elevated inner instance also skips the normal section
  ; process check, so run that check from the install-page PRE callback, after
  ; instFilesPre has normalized the user-selected directory.
  !undef MUI_PAGE_CUSTOMFUNCTION_PRE
  !define MUI_PAGE_CUSTOMFUNCTION_PRE JustDoInstFilesPre
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW JustDoInstFilesShow
  ; Define the callback when electron-builder expands this macro, after its
  ; multi-user template has declared $installMode.
  Function JustDoInstFilesPre
    Call instFilesPre
    StrCpy $JustDoInstallMode "$installMode"
    ${If} ${UAC_IsInnerInstance}
      !insertmacro JustDoLogInstallEvent "phase=inner-instance-process-check-start"
      Call JustDoCheckAppRunning
    ${EndIf}
  FunctionEnd
!macroend
!endif

!macro FindJustDoProcesses _RESULT
  ; Return 0 only when a process whose executable lives in this installation
  ; is running. Exclude the calling installer/uninstaller and this PowerShell
  ; helper so an installer launched from $INSTDIR cannot match itself.
  System::Call 'Kernel32::GetCurrentProcessId()i.r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("JUSTDO_INSTALL_ROOT", "$INSTDIR").r1'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("JUSTDO_CALLER_PID", "$0").r1'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("JUSTDO_APP_PROCESS_NAME", "${APP_FILENAME}").r1'
  !insertmacro JustDoResolveNativePowerShell $R8
  nsExec::ExecToStack /TIMEOUT=15000 '"$R8" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\justdo-process-helper.ps1" -Action Find'
  Pop ${_RESULT}
  Pop $R9
  System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_INSTALL_ROOT", t "")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_CALLER_PID", t "")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_APP_PROCESS_NAME", t "")i'
!macroend

!macro WaitForJustDoProcesses _RESULT _MAX_ATTEMPTS
  ; Poll inside one PowerShell process. Re-launching PowerShell for each 500 ms
  ; check would make graceful shutdown noticeably slower.
  System::Call 'Kernel32::GetCurrentProcessId()i.r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("JUSTDO_INSTALL_ROOT", "$INSTDIR").r1'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("JUSTDO_CALLER_PID", "$0").r1'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("JUSTDO_APP_PROCESS_NAME", "${APP_FILENAME}").r1'
  !insertmacro JustDoResolveNativePowerShell $R8
  nsExec::ExecToStack /TIMEOUT=90000 '"$R8" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\justdo-process-helper.ps1" -Action Wait -MaxAttempts ${_MAX_ATTEMPTS}'
  Pop ${_RESULT}
  Pop $R9
  System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_INSTALL_ROOT", t "")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_CALLER_PID", t "")i'
  System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_APP_PROCESS_NAME", t "")i'
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
      System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("JUSTDO_APP_PROCESS_NAME", "${APP_FILENAME}").r1'
      !insertmacro JustDoResolveNativePowerShell $R8
      nsExec::ExecToStack /TIMEOUT=15000 '"$R8" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\justdo-process-helper.ps1" -Action Stop'
      Pop ${_RESULT}
      Pop $R9
      System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_INSTALL_ROOT", t "")i'
      System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_CALLER_PID", t "")i'
      System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_APP_PROCESS_NAME", t "")i'
    ${EndIf}
  ${EndIf}
!macroend

!ifndef BUILD_UNINSTALLER
Function JustDoStageManagedRuntimes
  System::Call 'Kernel32::GetCurrentProcessId()i.r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("JUSTDO_INSTALL_ROOT", "$INSTDIR").r1'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("JUSTDO_CALLER_PID", "$0").r1'
  !insertmacro JustDoResolveNativePowerShell $R8
  nsExec::ExecToStack /TIMEOUT=30000 '"$R8" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\justdo-process-helper.ps1" -Action StageRuntimes'
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
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("JUSTDO_USER_DATA_ROOT", "$JustDoCurrentUserAppData\${PRODUCT_NAME}").r1'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("JUSTDO_CALLER_PID", "$0").r1'
  !insertmacro JustDoResolveNativePowerShell $R8
  nsExec::ExecToStack /TIMEOUT=15000 '"$R8" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\justdo-process-helper.ps1" -Action StopLegacyPython'
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
    !insertmacro JustDoLogInstallEvent "phase=runtime-restore result=$0 detail=process-helper-not-extracted"
    Return
  ${EndIf}
  System::Call 'Kernel32::GetCurrentProcessId()i.r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("JUSTDO_INSTALL_ROOT", "$INSTDIR").r1'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("JUSTDO_CALLER_PID", "$0").r1'
  !insertmacro JustDoResolveNativePowerShell $R8
  nsExec::ExecToStack /TIMEOUT=30000 '"$R8" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\justdo-process-helper.ps1" -Action RestoreRuntimes'
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
  File /oname=$PLUGINSDIR\justdo-process-helper.ps1 "${PROJECT_DIR}\scripts\packaging\nsis-process-helper.ps1"
  ; A pristine installation has no process tree to close. Do not make it
  ; depend on a machine-wide process inventory. This literal is the default
  ; electron-builder multi-user key; INSTALL_REGISTRY_KEY is defined only
  ; after the custom include has been parsed.
  StrCpy $JustDoPristineInstall "0"
  ReadRegStr $R8 HKCU "Software\${APP_GUID}" InstallLocation
  ReadRegStr $R7 HKLM "Software\${APP_GUID}" InstallLocation
  ${If} $R8 == ""
  ${AndIf} $R7 == ""
  ${AndIfNot} ${FileExists} "$INSTDIR\*.*"
    StrCpy $JustDoPristineInstall "1"
    !insertmacro JustDoLogInstallEvent "phase=process-check-skipped reason=pristine-install"
    Goto JustDoInstallProcessReady
  ${EndIf}
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
        ; Process enumeration is advisory. The old-version removal and atomic
        ; copy below are the authority on whether installed files are actually
        ; busy, so an inspection failure alone must not block an upgrade.
        !insertmacro JustDoLogInstallEvent "phase=process-check-degraded reason=process-inspection-failed action=continue-to-filesystem-replacement"
      ${EndIf}
    ${ElseIf} $0 != "1"
      !insertmacro JustDoLogInstallEvent "phase=process-check-degraded reason=initial-process-inspection-failed action=continue-to-filesystem-replacement"
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
        StrCpy $JustDoInstallTerminalState "user-cancelled"
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
          ; Do not trap users in a retry loop merely because process metadata
          ; is unavailable. A real file lock will be detected by removal/copy.
          !insertmacro JustDoLogInstallEvent "phase=process-check-degraded reason=process-inspection-failed action=continue-to-filesystem-replacement"
      ${EndIf}
  ${EndIf}
  JustDoInstallProcessReady:
  !insertmacro JustDoLogInstallEvent "phase=process-check-complete result=ready"
  ${If} $JustDoPristineInstall != "1"
    Call JustDoStopLegacyPythonProcesses
    Call JustDoStageManagedRuntimes
    ${If} $0 != "0"
      ; Staging only shortens old-version cleanup. If historical or unexpected
      ; data makes it unavailable, let the normal uninstaller remove the old
      ; tree instead of rejecting an otherwise installable upgrade.
      !insertmacro JustDoLogInstallEvent "phase=runtime-staging-degraded result=$0 action=continue-with-normal-old-version-removal"
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

Function JustDoReadDesktopUserPaths
  StrCpy $0 "$JustDoCurrentUserAppData"
  StrCpy $1 "$JustDoCurrentUserLocalAppData"
  StrCpy $3 "$JustDoCurrentTemp"
FunctionEnd

!macro customCheckAppRunning
  Call JustDoCheckAppRunning
!macroend
!endif

!ifndef BUILD_UNINSTALLER
!macro preInit
  ; An interactive installer can be started with credentials from another local
  ; account (for example by "Run as administrator"). Per-user shell constants
  ; would then point at that credentialed account. Re-enter once through the
  ; current desktop shell before reading APPDATA/LOCALAPPDATA. A later explicit
  ; "all users" selection still follows electron-builder's normal UAC flow.
  ${If} ${UAC_IsAdmin}
  ${AndIfNot} ${UAC_IsInnerInstance}
    ${GetParameters} $0
    ClearErrors
    StrCpy $2 "0"
    ${GetOptions} $0 "/currentuser" $1
    ${IfNot} ${Errors}
      StrCpy $2 "1"
    ${EndIf}
    ClearErrors
    ${GetOptions} $0 "/allusers" $1
    ${IfNot} ${Errors}
    ${AndIf} $2 != "1"
      Goto JustDoAccountBootstrapComplete
    ${EndIf}
    ClearErrors
    ${GetOptions} $0 "--justdo-current-user-bootstrap" $1
    ${If} ${Errors}
      ${If} ${Silent}
        ; Unattended installs run as the invoking account. Let electron-builder
        ; honor /currentuser, /allusers and its normal registry-based selection.
        ; A desktop shell is not required for deployment or update automation.
        Goto JustDoAccountBootstrapComplete
      ${EndIf}
      ${StdUtils.ExecShellAsUser} $1 "$EXEPATH" "open" '--justdo-current-user-bootstrap $0'
      ${If} $1 == "ok"
        Quit
      ${EndIf}
      ${If} $2 != "1"
      ${AndIfNot} ${Silent}
        MessageBox MB_YESNO|MB_ICONEXCLAMATION "无法访问当前桌面账户。点击“是”将改为所有用户安装；点击“否”退出。 The current desktop account is unavailable. Click Yes to install for all users, or No to exit." IDYES JustDoBootstrapAllUsers IDNO JustDoBootstrapFailed
        JustDoBootstrapAllUsers:
          Exec '"$EXEPATH" --justdo-current-user-bootstrap /allusers $0'
          Quit
      ${EndIf}
      JustDoBootstrapFailed:
      MessageBox MB_OK|MB_ICONSTOP "无法以当前桌面账户启动安装程序。请关闭此窗口，然后直接双击安装包；不要使用“以管理员身份运行”。$\r$\n$\r$\nSetup could not restart under the current desktop account. Close this window and double-click the installer instead of using Run as administrator." /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
    JustDoAccountBootstrapComplete:
  ${EndIf}

  ; Capture per-user shell paths before initMultiUser can switch all-users
  ; installs to the machine shell context. All later log relocation uses these
  ; fixed values, keeping outer and elevated-inner sessions discoverable.
  StrCpy $JustDoCurrentUserAppData "$APPDATA"
  StrCpy $JustDoCurrentUserLocalAppData "$LOCALAPPDATA"
  StrCpy $JustDoCurrentTemp "$TEMP"
  StrCpy $JustDoInstallerDirectory "$EXEDIR"
  System::Call 'kernel32::GetTickCount()i.r0'
  StrCpy $JustDoInstallStartedTick $0
  StrCpy $JustDoCoreInstallStartedTick 0
  StrCpy $JustDoProcessCheckComplete "0"
  StrCpy $JustDoInstallTerminalState "running"
  System::Call 'kernel32::GetCurrentProcessId()i.r0'
  StrCpy $JustDoInstallerPid $0
  StrCpy $JustDoInstallerSessionId "$JustDoInstallerPid-$JustDoInstallStartedTick"
  StrCpy $JustDoLastInstallEvent "pre-init-not-yet-logged"

  ; Keep prior sessions in append-only files: retries and normal same-account
  ; UAC outer/inner instances must not erase the evidence from one another.
  ; Start diagnostics before architecture, mutex and multi-user checks because
  ; each of those electron-builder template paths can terminate setup early.
  Call JustDoSelectInstallLogDirectory
  ClearErrors
  !insertmacro JustDoOpenAppendLog $2 "$JustDoInstallLogPath"
  ${If} ${Errors}
    ; Logging must never prevent an otherwise valid installation.
    FileOpen $2 "NUL" w
    ClearErrors
  ${EndIf}
  ${GetTime} "" "L" $3 $4 $5 $6 $7 $8 $9
  FileWrite $2 "$\r$\n====================================================================================================$\r$\n"
  FileWrite $2 "INSTALL SESSION START | timestamp=$5-$4-$3 $7:$8:$9 | session=$JustDoInstallerSessionId | pid=$JustDoInstallerPid | version=${VERSION} | installer=$EXEPATH$\r$\n"
  FileWrite $2 "====================================================================================================$\r$\n"
  FileWrite $2 "pre-init-start: $5-$4-$3 $7:$8:$9$\r$\n"
  FileWrite $2 "log-format-version: 4$\r$\n"
  FileWrite $2 "installer-pid: $JustDoInstallerPid$\r$\n"
  FileWrite $2 "installer-session-id: $JustDoInstallerSessionId$\r$\n"
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
  FileWrite $2 "captured-current-user-appdata: $JustDoCurrentUserAppData$\r$\n"
  FileWrite $2 "captured-current-user-localappdata: $JustDoCurrentUserLocalAppData$\r$\n"
  FileWrite $2 "captured-temp: $JustDoCurrentTemp$\r$\n"
  FileWrite $2 "install-log-directory: $JustDoInstallLogDirectory$\r$\n"
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
  ${If} ${UAC_IsInnerInstance}
    FileWrite $2 "uac-inner-instance: yes$\r$\n"
  ${Else}
    FileWrite $2 "uac-inner-instance: no$\r$\n"
  ${EndIf}
  FileWrite $2 "resource-detail-log: $JustDoResourceLogPath$\r$\n"
  FileClose $2
  ClearErrors
  !insertmacro JustDoOpenAppendLog $2 "$JustDoResourceLogPath"
  ${IfNot} ${Errors}
    FileWrite $2 "$\r$\n====================================================================================================$\r$\n"
    FileWrite $2 "INSTALL SESSION START | timestamp=$5-$4-$3 $7:$8:$9 | session=$JustDoInstallerSessionId | pid=$JustDoInstallerPid | version=${VERSION} | installer=$EXEPATH$\r$\n"
    FileWrite $2 "====================================================================================================$\r$\n"
    FileClose $2
  ${EndIf}
  ClearErrors
  !insertmacro JustDoLogInstallEvent "phase=installer-pre-init-complete"
!macroend
!endif

!macro customInit
  ; Synchronize before opening handles: UAC_SYNCREGISTERS replaces all general
  ; registers, including $2, with values from the outer process.
  ${If} ${UAC_IsInnerInstance}
    !insertmacro UAC_AsUser_Call Function JustDoReadDesktopUserPaths ${UAC_SYNCREGISTERS}
    StrCpy $JustDoCurrentUserAppData $0
    StrCpy $JustDoCurrentUserLocalAppData $1
    StrCpy $JustDoCurrentTemp $3
  ${EndIf}
  ; Multi-user state is only valid after electron-builder's initMultiUser macro.
  ; Append it to the session started by preInit instead of truncating early logs.
  ClearErrors
  !insertmacro JustDoOpenAppendLog $2 "$JustDoInstallLogPath"
  ${If} ${Errors}
    !insertmacro JustDoLogInstallEvent "phase=install-log-recovery trigger=custom-init-reopen"
    ClearErrors
    !insertmacro JustDoOpenAppendLog $2 "$JustDoInstallLogPath"
  ${EndIf}
  ${If} ${Errors}
    FileOpen $2 "NUL" w
    ClearErrors
  ${EndIf}
  FileWrite $2 "detected-per-user-installation: $hasPerUserInstallation$\r$\n"
  FileWrite $2 "detected-per-machine-installation: $hasPerMachineInstallation$\r$\n"
  FileWrite $2 "installer-language-id: $LANGUAGE$\r$\n"
  FileWrite $2 "post-multiuser-instdir: $INSTDIR$\r$\n"
  ; The assisted install-mode and directory pages have not run yet. Capture the
  ; final mode in JustDoInstFilesPre instead of caching this initial default.
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  FileWrite $2 "registry-hkcu-install-location: $0$\r$\n"
  ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  FileWrite $2 "registry-hklm-install-location: $0$\r$\n"
  FileClose $2
  ClearErrors
  !insertmacro JustDoLogInstallEvent "phase=installer-init-complete"
  ${If} ${Silent}
    ; Silent installs do not visit the install page, so its PRE callback cannot
    ; capture the final mode or prepare an elevated inner upgrade. initMultiUser
    ; has already resolved command-line/registry mode and $INSTDIR here.
    StrCpy $JustDoInstallMode "$installMode"
    ${If} ${UAC_IsInnerInstance}
      !insertmacro JustDoLogInstallEvent "phase=inner-instance-process-check-start mode=silent"
      Call JustDoCheckAppRunning
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstall
  ; ─── Install Timing Log ───
  ; Write timestamps to help diagnose slow installation phases.
  ; Log directory was selected and verified by preInit.

  CreateDirectory "$JustDoCurrentUserAppData\${PRODUCT_NAME}"
  ; The old uninstaller has now removed the previous app shell. Restore the
  ; same-volume, directory-level runtime staging so unpack-cfmind can replace it
  ; transactionally and roll it back if the new archive is invalid.
  Call JustDoRestoreManagedRuntimes
  ${If} $0 != "0"
    ; The new package installs a complete runtime. A stale runtime staging
    ; directory is diagnostic residue, not a reason to reject the new app.
    !insertmacro JustDoLogInstallEvent "phase=runtime-restore-degraded result=$0 action=continue-with-new-runtime"
  ${EndIf}
  System::Call 'kernel32::GetTickCount()i.r0'
  ${If} $JustDoCoreInstallStartedTick != 0
    IntOp $1 $0 - $JustDoCoreInstallStartedTick
    !insertmacro JustDoLogInstallEvent "phase=electron-builder-core-returned duration-ms=$1"
  ${Else}
    !insertmacro JustDoLogInstallEvent "phase=electron-builder-core-returned duration-ms=unavailable"
  ${EndIf}

  ; Nsis7z historically reports success even when it cannot decode a filter in
  ; the embedded application archive. Verify critical Electron payloads before
  ; the runtime extractor turns selective omissions into unrelated errors. This
  ; also catches endpoint security quarantining files during installation.
  StrCpy $R6 ""
  StrCpy $R7 ""
  ${IfNot} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    StrCpy $R6 "main-executable"
    StrCpy $R7 "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  ${ElseIfNot} ${FileExists} "$INSTDIR\resources\app.asar"
    StrCpy $R6 "app-asar"
    StrCpy $R7 "$INSTDIR\resources\app.asar"
  ${ElseIfNot} ${FileExists} "$INSTDIR\resources\unpack-cfmind.cjs"
    StrCpy $R6 "resource-unpack-script"
    StrCpy $R7 "$INSTDIR\resources\unpack-cfmind.cjs"
  ${ElseIfNot} ${FileExists} "$INSTDIR\resources\win-resources.tar.zst"
    StrCpy $R6 "resource-archive"
    StrCpy $R7 "$INSTDIR\resources\win-resources.tar.zst"
  ${ElseIfNot} ${FileExists} "$INSTDIR\resources\win-resources-metadata.json"
    StrCpy $R6 "resource-metadata"
    StrCpy $R7 "$INSTDIR\resources\win-resources-metadata.json"
  ${ElseIfNot} ${FileExists} "$INSTDIR\resources\app.asar.unpacked\node_modules\better-sqlite3\build\Release\better_sqlite3.node"
    StrCpy $R6 "better-sqlite3-native-module"
    StrCpy $R7 "$INSTDIR\resources\app.asar.unpacked\node_modules\better-sqlite3\build\Release\better_sqlite3.node"
  ${EndIf}
  ${If} $R6 != ""
    !insertmacro JustDoLogInstallEvent "phase=installer-abort reason=core-payload-missing component=$R6 path=$R7"
    ${If} $LANGUAGE == ${JUSTDO_LANG_SIMPCHINESE}
    ${OrIf} $LANGUAGE == ${JUSTDO_LANG_TRADCHINESE}
      StrCpy $1 "必需的应用文件未能写入安装目录（$R6）。安装包可能损坏，或文件被安全软件拦截。请重新下载安装包并重试。诊断日志可能包含本机文件路径，请确认后再提供给技术支持。"
    ${Else}
      StrCpy $1 "A required application file could not be written ($R6). The installer may be damaged, or security software may have blocked the file. Download setup again and retry. Diagnostic logs can contain local file paths; review them before sharing with support."
    ${EndIf}
    ${If} $JustDoInstallLogPath != ""
    ${AndIf} ${FileExists} "$JustDoInstallLogPath"
      StrCpy $1 "$1$\r$\n$\r$\n$JustDoInstallLogPath"
    ${EndIf}
    MessageBox MB_OK|MB_ICONSTOP "$1" /SD IDOK
    Abort "Core application extraction failed: required payload missing."
  ${EndIf}
  !insertmacro JustDoLogInstallEvent "phase=electron-builder-core-validation-complete result=passed"

  ; Re-probe both logs together before the long resource phase. If either path
  ; became unavailable, try relocating the pair. Diagnostics remain best-effort.
  StrCpy $R5 "0"
  StrCpy $R4 "$JustDoInstallLogPath"
  ClearErrors
  !insertmacro JustDoOpenAppendLog $0 "$JustDoInstallLogPath"
  ${If} ${Errors}
    StrCpy $R5 "1"
  ${Else}
    FileClose $0
  ${EndIf}
  ClearErrors
  !insertmacro JustDoOpenAppendLog $0 "$JustDoResourceLogPath"
  ${If} ${Errors}
    StrCpy $R5 "1"
  ${Else}
    FileClose $0
  ${EndIf}
  ${If} $R5 == "1"
    Call JustDoSelectInstallLogDirectory
  ${EndIf}
  ${If} $R5 == "1"
    !insertmacro JustDoLogInstallEvent "phase=install-log-relocated trigger=custom-install-probe previous=$R4 current=$JustDoInstallLogPath"
  ${EndIf}
  ClearErrors
  !insertmacro JustDoOpenAppendLog $2 "$JustDoInstallLogPath"
  ${If} ${Errors}
    FileOpen $2 "NUL" w
    ClearErrors
  ${EndIf}

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

  ; Keep temporary artifacts created by the extractor and its direct children
  ; inside the selected install root. Independent endpoint-security processes
  ; do not inherit this environment and are monitored only by free-space loss.
  ReadEnvStr $JustDoPreviousTemp "TEMP"
  ReadEnvStr $JustDoPreviousTmp "TMP"
  StrCpy $JustDoExtractorEnvironmentConfigured "1"
  StrCpy $JustDoExtractorTempDirectory "$INSTDIR\.justdo-installer-temp-$JustDoInstallerSessionId"
  System::Call 'Kernel32::GetFileAttributes(t "$JustDoExtractorTempDirectory")i.r0'
  ${If} $0 != -1
    !insertmacro JustDoLogInstallEvent "phase=installer-abort reason=extractor-temp-collision"
    StrCpy $JustDoExtractorTempDirectory ""
    Abort "Setup cannot create its protected temporary directory. Retry the installation."
  ${EndIf}
  ClearErrors
  CreateDirectory "$JustDoExtractorTempDirectory"
  ${If} ${Errors}
    StrCpy $JustDoExtractorTempDirectory ""
    !insertmacro JustDoLogInstallEvent "phase=installer-abort reason=extractor-temp-create-failed"
    Abort "Setup cannot create its protected temporary directory. Check the installation path and retry."
  ${EndIf}
  System::Call 'Kernel32::SetEnvironmentVariable(t "TEMP", t "$JustDoExtractorTempDirectory")i.r0'
  ${If} $0 == 0
    Call JustDoCleanupExtractorEnvironment
    Abort "Setup cannot isolate its temporary files. Retry the installation."
  ${EndIf}
  System::Call 'Kernel32::SetEnvironmentVariable(t "TMP", t "$JustDoExtractorTempDirectory")i.r0'
  ${If} $0 == 0
    Call JustDoCleanupExtractorEnvironment
    Abort "Setup cannot isolate its temporary files. Retry the installation."
  ${EndIf}
  System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_INSTALLER_TEMP_ROOT", t "$JustDoExtractorTempDirectory")i.r0'
  ${If} $0 == 0
    Call JustDoCleanupExtractorEnvironment
    Abort "Setup cannot isolate its temporary files. Retry the installation."
  ${EndIf}
  System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_INSTALLER_ORIGINAL_TEMP_ROOT", t "$JustDoPreviousTemp")i.r0'
  ${If} $0 == 0
    Call JustDoCleanupExtractorEnvironment
    Abort "Setup cannot isolate its temporary files. Retry the installation."
  ${EndIf}
  FileWrite $2 "extractor-temp-root: $JustDoExtractorTempDirectory$\r$\n"

  ${GetTime} "" "L" $3 $4 $5 $6 $7 $8 $9
  FileWrite $2 "tar-extract-start: $5-$4-$3 $7:$8:$9$\r$\n"
  !insertmacro JustDoSetInstallStatus \
    "正在展开核心资源；此阶段无法精确计算百分比，请稍候…" \
    "Expanding core resources; an exact percentage is unavailable. Please wait…"
  !insertmacro JustDoAddInstallActivity \
    "正在整理核心资源" \
    "Preparing core resources"
  FileWrite $2 "tar-extract-command: $INSTDIR\${APP_EXECUTABLE_FILENAME} $INSTDIR\resources\unpack-cfmind.cjs $INSTDIR\resources\win-resources.tar.zst $INSTDIR\resources $JustDoCurrentUserAppData\${PRODUCT_NAME} $INSTDIR\resources\win-resources-metadata.json <progress-file> $JustDoResourceLogPath <session-id> ${VERSION}$\r$\n"
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
  ${StdUtils.ExecShellWaitEx} $R7 $R8 "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "open" '"$INSTDIR\resources\unpack-cfmind.cjs" "$INSTDIR\resources\win-resources.tar.zst" "$INSTDIR\resources" "$JustDoCurrentUserAppData\${PRODUCT_NAME}" "$INSTDIR\resources\win-resources-metadata.json" "$JustDoResourceProgressFile" "$JustDoResourceLogPath" "$JustDoInstallerSessionId" "${VERSION}"'
  ${If} $R7 != "ok"
    FileWrite $2 "tar-extract-launch-error: result=$R7 detail=$R8$\r$\n"
    StrCpy $0 "launch-$R7-$R8"
    Goto TarExtractFailed
  ${EndIf}
  StrCpy $JustDoExtractorActive "1"

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
  StrCpy $JustDoExtractorActive "0"

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
    MessageBox MB_OK|MB_ICONEXCLAMATION "$1" /SD IDOK
    System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "")i'
    System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_INSTALLER_PYTHON_IMPORT_CHECK", t "")i'
    Call JustDoCleanupExtractorEnvironment
    ${If} $JustDoExtractorTempDirectory != ""
      FileWrite $2 "extractor-temp-cleanup: incomplete path=$JustDoExtractorTempDirectory$\r$\n"
    ${EndIf}
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
  Delete "$JustDoCurrentUserAppData\${PRODUCT_NAME}\dependency-config\.npmrc"
  Delete "$JustDoCurrentUserAppData\${PRODUCT_NAME}\dependency-config\pip.ini"
  RMDir "$JustDoCurrentUserAppData\${PRODUCT_NAME}\dependency-config"
  ${If} ${FileExists} "$JustDoCurrentUserAppData\${PRODUCT_NAME}\dependency-config\.npmrc"
  ${OrIf} ${FileExists} "$JustDoCurrentUserAppData\${PRODUCT_NAME}\dependency-config\pip.ini"
    FileWrite $2 "dependency-config-legacy: cleanup-incomplete$\r$\n"
  ${Else}
    FileWrite $2 "dependency-config-legacy: cleanup-complete$\r$\n"
  ${EndIf}

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
  Call JustDoCleanupExtractorEnvironment
  ${If} $JustDoExtractorTempDirectory != ""
    FileWrite $2 "extractor-temp-cleanup: incomplete path=$JustDoExtractorTempDirectory$\r$\n"
  ${EndIf}
  FileWrite $2 "clear-electron-run-as-node: result=$0$\r$\n"

  ; Marks installations completed by NSIS. Packaged-but-uninstalled win-unpacked
  ; directories do not contain this file and must not enable auto-update.
  StrCpy $R5 "0"
  ClearErrors
  FileOpen $0 "$INSTDIR\resources\.justdo-nsis-installed" w
  ${IfNot} ${Errors}
    StrCpy $R5 "1"
    FileWrite $0 "${VERSION}$\r$\n"
  ${EndIf}
  ${If} ${Errors}
    ${If} $R5 == "1"
      FileClose $0
    ${EndIf}
    FileWrite $2 "nsis-install-marker: write-failed path=$INSTDIR\resources\.justdo-nsis-installed$\r$\n"
  ${Else}
    FileClose $0
    FileWrite $2 "nsis-install-marker: written$\r$\n"
  ${EndIf}
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
  ; The upstream legacy switch bypasses the safe optional cleanup section and
  ; can delete an elevated credential account's data. Keep deletion in the
  ; explicit interactive option, with normal and upgrade uninstalls unchanged.
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "--delete-app-data" $1
  ${IfNot} ${Errors}
    DetailPrint "The legacy --delete-app-data option is unsupported. Use the uninstall data checkbox."
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONINFORMATION "To delete ${PRODUCT_NAME} data, run the uninstaller without --delete-app-data and select the user-data deletion option.$\r$\n$\r$\n若要删除 ${PRODUCT_NAME} 数据，请去掉 --delete-app-data 参数重新运行卸载程序，并勾选删除用户数据选项。"
    ${EndIf}
    SetErrorLevel 2
    Quit
  ${EndIf}
  ClearErrors
  ; In interactive mode, ask the user to close the app instead of silently
  ; killing it. Closing the main app also gives its gateway and child processes
  ; a chance to shut down cleanly. Silent uninstall keeps the non-interactive
  ; cleanup behavior expected by managed deployment tools.
  InitPluginsDir
  File /oname=$PLUGINSDIR\justdo-process-helper.ps1 "${PROJECT_DIR}\scripts\packaging\nsis-process-helper.ps1"
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

!ifdef BUILD_UNINSTALLER
Function un.JustDoDeleteCurrentUserData
  ; Dispatching this function to the non-elevated UAC outer process keeps the
  ; shell environment bound to the desktop user even when another account's
  ; administrator credentials were entered for an all-users uninstall.
  InitPluginsDir
  File /oname=$PLUGINSDIR\justdo-user-data-helper.ps1 "${PROJECT_DIR}\scripts\packaging\nsis-user-data-helper.ps1"
  StrCpy $2 ""
  ${If} ${UAC_IsAdmin}
    StrCpy $2 "-RequireDesktopUser"
  ${EndIf}
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\justdo-user-data-helper.ps1" -Names "${PRODUCT_NAME}|${APP_FILENAME}|${APP_PACKAGE_NAME}|${APP_PACKAGE_NAME}-updater" $2'
  Pop $0
  Pop $1
FunctionEnd
!endif

; Assisted uninstall shows the standard components page when this macro is
; present. Keep data deletion optional and unchecked: uninstalling the app is
; reversible, while deleting local state, transcripts and credentials is not.
; Silent upgrade uninstallers do not select this section, and electron-builder
; also passes --updated, so upgrades always preserve user data.
!macro customUnInstallSection
  LangString JustDoDeleteUserData 1033 "Delete all local user data (settings, chat history, browser data, and downloaded models)"
  LangString JustDoDeleteUserData 1031 "Delete all local user data (settings, chat history, browser data, and downloaded models)"
  LangString JustDoDeleteUserData 1036 "Delete all local user data (settings, chat history, browser data, and downloaded models)"
  LangString JustDoDeleteUserData 3082 "Delete all local user data (settings, chat history, browser data, and downloaded models)"
  LangString JustDoDeleteUserData 2052 "删除所有本机用户数据（设置、聊天记录、浏览器数据和已下载模型）"
  LangString JustDoDeleteUserData 1028 "刪除所有本機使用者資料（設定、聊天記錄、瀏覽器資料和已下載模型）"
  LangString JustDoDeleteUserData 1041 "Delete all local user data (settings, chat history, browser data, and downloaded models)"
  LangString JustDoDeleteUserData 1042 "Delete all local user data (settings, chat history, browser data, and downloaded models)"
  LangString JustDoDeleteUserData 1040 "Delete all local user data (settings, chat history, browser data, and downloaded models)"
  LangString JustDoDeleteUserData 1043 "Delete all local user data (settings, chat history, browser data, and downloaded models)"
  LangString JustDoDeleteUserData 1030 "Delete all local user data (settings, chat history, browser data, and downloaded models)"
  LangString JustDoDeleteUserData 1053 "Delete all local user data (settings, chat history, browser data, and downloaded models)"
  LangString JustDoDeleteUserData 1044 "Delete all local user data (settings, chat history, browser data, and downloaded models)"
  LangString JustDoDeleteUserData 1035 "Delete all local user data (settings, chat history, browser data, and downloaded models)"
  LangString JustDoDeleteUserData 1049 "Delete all local user data (settings, chat history, browser data, and downloaded models)"
  LangString JustDoDeleteUserData 2070 "Delete all local user data (settings, chat history, browser data, and downloaded models)"
  LangString JustDoDeleteUserData 1046 "Delete all local user data (settings, chat history, browser data, and downloaded models)"
  LangString JustDoDeleteUserData 1045 "Delete all local user data (settings, chat history, browser data, and downloaded models)"
  LangString JustDoDeleteUserData 1058 "Delete all local user data (settings, chat history, browser data, and downloaded models)"
  LangString JustDoDeleteUserData 1029 "Delete all local user data (settings, chat history, browser data, and downloaded models)"
  LangString JustDoDeleteUserData 1051 "Delete all local user data (settings, chat history, browser data, and downloaded models)"
  LangString JustDoDeleteUserData 1038 "Delete all local user data (settings, chat history, browser data, and downloaded models)"
  LangString JustDoDeleteUserData 1025 "Delete all local user data (settings, chat history, browser data, and downloaded models)"
  LangString JustDoDeleteUserData 1055 "Delete all local user data (settings, chat history, browser data, and downloaded models)"
  LangString JustDoDeleteUserData 1054 "Delete all local user data (settings, chat history, browser data, and downloaded models)"
  LangString JustDoDeleteUserData 1066 "Delete all local user data (settings, chat history, browser data, and downloaded models)"

  Section /o "un.$(JustDoDeleteUserData)" un.JustDoDeleteUserData
    ; Deliberately never touch ~/${APP_FILENAME}/project, session cwd values,
    ; downloads, or any other user-selected workspace. The helper only removes
    ; exact children of the current desktop user's Roaming/Local bases and
    ; never traverses a junction or symbolic link.
    ${If} ${isUpdated}
      Goto JustDoDeleteUserDataDone
    ${EndIf}

    JustDoDeleteUserDataRetry:
    DetailPrint "Deleting local ${PRODUCT_NAME} user data..."
    ${If} $installMode == "all"
    ${AndIf} ${UAC_IsInnerInstance}
      !insertmacro UAC_AsUser_Call Function un.JustDoDeleteCurrentUserData ${UAC_SYNCREGISTERS}
    ${Else}
      Call un.JustDoDeleteCurrentUserData
    ${EndIf}
    ${If} $0 == "3"
      DetailPrint "User data preserved: desktop account could not be confirmed."
      ${IfNot} ${Silent}
        MessageBox MB_OK|MB_ICONINFORMATION "${PRODUCT_NAME} was uninstalled. User data was kept because this elevated account could not be confirmed as the desktop user.$\r$\n$\r$\n${PRODUCT_NAME} 已卸载。无法确认管理员账户是否为当前桌面用户，已保留用户数据。"
      ${EndIf}
    ${ElseIf} $0 != "0"
      ${If} ${Silent}
        SetErrorLevel 3
      ${Else}
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Some ${PRODUCT_NAME} data could not be deleted. Close programs using the data and click Retry, or click Cancel to keep the remaining files and finish uninstalling.$\r$\n$\r$\n部分 ${PRODUCT_NAME} 数据无法删除。请关闭正在使用这些数据的程序后点击“重试”，或点击“取消”保留剩余文件并完成卸载。" IDRETRY JustDoDeleteUserDataRetry
      ${EndIf}
    ${EndIf}
    JustDoDeleteUserDataDone:
  SectionEnd
!macroend
