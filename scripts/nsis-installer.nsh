!include "FileFunc.nsh"
!include "LogicLib.nsh"

!define JUSTDO_POWERSHELL "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
!define JUSTDO_INSTALLER_QUIT_SWITCH "--justdo-request-quit-for-update"

!ifndef BUILD_UNINSTALLER
!define JUSTDO_PROGRESS_STYLE 0x50000001
!define JUSTDO_PBM_SETPOS 0x0402
!define JUSTDO_PBM_SETRANGE32 0x0406
!define JUSTDO_PBM_SETBARCOLOR 0x0409
!define JUSTDO_PBM_SETBKCOLOR 0x2001
!define JUSTDO_WM_SETTEXT 0x000C
!define JUSTDO_LANG_TRADCHINESE 1028
!define JUSTDO_LANG_SIMPCHINESE 2052

Var JustDoProgressBar
Var JustDoInstFilesPage
Var JustDoStatusText
Var JustDoNativeProgressBar
Var JustDoInstallLog
Var JustDoShowLogButton

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

!macro JustDoSetInstallProgress _POSITION _ZH_TEXT _EN_TEXT
  ${If} $JustDoProgressBar != ""
    SendMessage $JustDoProgressBar ${JUSTDO_PBM_SETPOS} ${_POSITION} 0
  ${EndIf}
  ${If} $LANGUAGE == ${JUSTDO_LANG_SIMPCHINESE}
  ${OrIf} $LANGUAGE == ${JUSTDO_LANG_TRADCHINESE}
    SendMessage $JustDoStatusText ${JUSTDO_WM_SETTEXT} 0 "STR:${_ZH_TEXT}"
  ${Else}
    SendMessage $JustDoStatusText ${JUSTDO_WM_SETTEXT} 0 "STR:${_EN_TEXT}"
  ${EndIf}
!macroend

; Keep the stock NSIS progress control visible while the large application
; archive is extracted so users see real byte-level progress. A separate,
; stage-based control takes over in customInstall for the resource/configuration
; work that NSIS cannot measure itself.
Function JustDoInstFilesShow
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
    ShowWindow $JustDoProgressBar 0
    System::Call 'uxtheme::SetWindowTheme(p $JustDoProgressBar, w " ", w " ")'
    SendMessage $JustDoProgressBar ${JUSTDO_PBM_SETRANGE32} 0 100
    ; COLORREF values are BGR: indigo foreground on a cool-gray track.
    SendMessage $JustDoProgressBar ${JUSTDO_PBM_SETBARCOLOR} 0 0xE54F46
    SendMessage $JustDoProgressBar ${JUSTDO_PBM_SETBKCOLOR} 0 0xF0EAE7
  ${EndIf}
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

  !insertmacro JustDoSetInstallProgress 8 \
    "正在准备应用组件，请耐心等待…" \
    "Preparing application components. Please wait…"
  !insertmacro JustDoAddInstallActivity \
    "已确认安装位置" \
    "Installation location confirmed"
  !insertmacro JustDoAddInstallActivity \
    "正在准备应用组件" \
    "Preparing application components"
  !insertmacro JustDoAddInstallActivity \
    "安装程序正在正常运行，此步骤需要一些时间" \
    "Setup is working normally. This step may take a little while."
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

!macro customHeader
  ; Hide the (empty) details list — electron-builder uses 7z solid extraction
  ; which produces no per-file output, so the box would just be blank.
  ShowInstDetails nevershow
!macroend

!macro customCheckAppRunning
  ; Check before the large application archive is extracted. Waiting until the
  ; later atomic copy would make users sit through extraction before learning
  ; that the running app must be closed. Match only executables located under
  ; this installation root so another installation or portable copy is safe.
  InitPluginsDir
  File /oname=$PLUGINSDIR\justdo-process-helper.ps1 "${PROJECT_DIR}\scripts\nsis-process-helper.ps1"
  ${If} ${Silent}
    !insertmacro FindJustDoProcesses $0
    ${If} $0 == "0"
      ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" ${JUSTDO_INSTALLER_QUIT_SWITCH}'
      !insertmacro WaitForJustDoProcesses $0 120
      ${If} $0 == "1"
        Abort "${PRODUCT_NAME} is still running after a graceful shutdown request."
      ${ElseIf} $0 == "2"
        Abort "Setup could not verify whether ${PRODUCT_NAME} has closed."
      ${EndIf}
    ${ElseIf} $0 == "2"
      Abort "Setup could not inspect processes in the installation directory."
    ${EndIf}
  ${Else}
    JustDoInstallProcessCheck:
      !insertmacro FindJustDoProcesses $0
      ${If} $0 == "0"
        ${If} $LANGUAGE == ${LANG_SIMPCHINESE}
        ${OrIf} $LANGUAGE == ${LANG_TRADCHINESE}
          StrCpy $1 "${PRODUCT_NAME} 正在运行。$\r$\n$\r$\n点击“是”：自动关闭旧版并继续安装。未保存的操作可能会丢失。$\r$\n点击“否”：我已从系统托盘手动退出，重新检测。$\r$\n点击“取消”：退出安装程序。"
        ${Else}
          StrCpy $1 "${PRODUCT_NAME} is running.$\r$\n$\r$\nYes: close the old version automatically and continue. Unsaved work may be lost.$\r$\nNo: I quit it manually from the system tray; check again.$\r$\nCancel: exit setup."
        ${EndIf}
        MessageBox MB_YESNOCANCEL|MB_ICONEXCLAMATION "$1" IDYES JustDoInstallAutoClose IDNO JustDoInstallProcessRetry
        Quit

        JustDoInstallProcessRetry:
          Sleep 500
          Goto JustDoInstallProcessCheck

        JustDoInstallAutoClose:
          ; Newer releases understand this second-instance switch and run the
          ; normal Gateway/SQLite cleanup path before exiting. Older releases
          ; simply discard the second instance, so a bounded force-close below
          ; remains necessary for backward-compatible upgrades.
          ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" ${JUSTDO_INSTALLER_QUIT_SWITCH}'
          !insertmacro WaitForJustDoProcesses $0 20
          ${If} $0 == "0"
            Goto JustDoInstallProcessClosed
          ${EndIf}

          ${If} $0 == "1"
            !insertmacro StopJustDoProcesses $0
          ${EndIf}
          ${If} $0 == "0"
            Goto JustDoInstallProcessClosed
          ${EndIf}

          Goto JustDoInstallInspectionFailed

        JustDoInstallProcessClosed:
      ${ElseIf} $0 == "2"
        JustDoInstallInspectionFailed:
          ${If} $LANGUAGE == ${LANG_SIMPCHINESE}
          ${OrIf} $LANGUAGE == ${LANG_TRADCHINESE}
            StrCpy $1 "安装程序无法确认 ${PRODUCT_NAME} 是否已关闭。请点击“重试”重新检测，或点击“取消”退出安装程序。"
          ${Else}
            StrCpy $1 "Setup could not verify whether ${PRODUCT_NAME} has closed. Click Retry to check again, or Cancel to exit setup."
          ${EndIf}
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$1" IDRETRY JustDoInstallProcessRetry
          Quit
      ${EndIf}
  ${EndIf}
!macroend

!macro customInit
  CreateDirectory "$APPDATA\${PRODUCT_NAME}"
  FileOpen $2 "$APPDATA\${PRODUCT_NAME}\install-timing.log" w
  ${GetTime} "" "L" $3 $4 $5 $6 $7 $8 $9
  FileWrite $2 "init-start: $5-$4-$3 $6:$7:$8$\r$\n"
  FileWrite $2 "product: ${PRODUCT_NAME} ${VERSION}$\r$\n"
  FileWrite $2 "app-filename: ${APP_FILENAME}$\r$\n"
  FileWrite $2 "app-executable: ${APP_EXECUTABLE_FILENAME}$\r$\n"
  FileWrite $2 "installer-exe: $EXEPATH$\r$\n"
  FileWrite $2 "cmdline: $CMDLINE$\r$\n"
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
  ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  FileWrite $2 "registry-hkcu-install-location: $0$\r$\n"
  ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  FileWrite $2 "registry-hklm-install-location: $0$\r$\n"
  FileClose $2
!macroend

!macro customInstall
  ; ─── Install Timing Log ───
  ; Write timestamps to help diagnose slow installation phases.
  ; Log file: %APPDATA%\${PRODUCT_NAME}\install-timing.log

  CreateDirectory "$APPDATA\${PRODUCT_NAME}"
  FileOpen $2 "$APPDATA\${PRODUCT_NAME}\install-timing.log" a

  ${GetTime} "" "L" $3 $4 $5 $6 $7 $8 $9
  FileWrite $2 "custom-install-start: $5-$4-$3 $6:$7:$8$\r$\n"
  ; NSIS has finished extracting its measured application archive. Switch to
  ; the stage-based bar for the custom resource expansion below.
  ShowWindow $JustDoNativeProgressBar 0
  ${If} $JustDoProgressBar != ""
    ShowWindow $JustDoProgressBar 5
  ${EndIf}
  !insertmacro JustDoSetInstallProgress 72 \
    "应用文件已就绪，正在配置运行环境…" \
    "Application files are ready. Configuring the runtime…"
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
  FileWrite $2 "extract-done: $5-$4-$3 $6:$7:$8$\r$\n"
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

  ; ─── Extract combined resource archive (win-resources.tar) ───
  ; All large resource directories (cfmind/, skills/, python-win/) are packed
  ; into a single tar file. NSIS 7z extracts one large file almost instantly;
  ; we then unpack the tar here using Electron's Node runtime.

  SetDetailsPrint none

  FileWrite $2 "set-details-print: none$\r$\n"
  FileWrite $2 "set-electron-run-as-node: start$\r$\n"
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")i'
  Pop $0
  FileWrite $2 "set-electron-run-as-node: result=$0$\r$\n"

  ${GetTime} "" "L" $3 $4 $5 $6 $7 $8 $9
  FileWrite $2 "tar-extract-start: $5-$4-$3 $6:$7:$8$\r$\n"
  !insertmacro JustDoSetInstallProgress 78 \
    "正在展开核心资源，这可能需要一点时间…" \
    "Expanding core resources. This may take a moment…"
  !insertmacro JustDoAddInstallActivity \
    "正在整理核心资源" \
    "Preparing core resources"
  FileWrite $2 "tar-extract-command: $INSTDIR\${APP_EXECUTABLE_FILENAME} $INSTDIR\resources\unpack-cfmind.cjs $INSTDIR\resources\win-resources.tar $INSTDIR\resources$\r$\n"
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
  ${If} ${FileExists} "$INSTDIR\resources\win-resources.tar"
    FileWrite $2 "resource-tar: exists$\r$\n"
  ${Else}
    FileWrite $2 "resource-tar: missing $INSTDIR\resources\win-resources.tar$\r$\n"
  ${EndIf}

  SetDetailsPrint listonly
  nsExec::ExecToLog '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\unpack-cfmind.cjs" "$INSTDIR\resources\win-resources.tar" "$INSTDIR\resources"'
  Pop $0
  SetDetailsPrint none
  FileWrite $2 "tar-extract-process-exit: $0$\r$\n"

  StrCmp $0 "0" TarExtractOK
    FileWrite $2 "tar-extract-error: exit=$0$\r$\n"
    ${If} $LANGUAGE == ${JUSTDO_LANG_SIMPCHINESE}
    ${OrIf} $LANGUAGE == ${JUSTDO_LANG_TRADCHINESE}
      StrCpy $1 "核心资源展开失败（退出码 $0），请查看安装动态了解详情。"
    ${Else}
      StrCpy $1 "Core resource extraction failed (exit code $0). See the installation activity for details."
    ${EndIf}
    MessageBox MB_OK|MB_ICONEXCLAMATION "$1"
    System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "")i'
    SetDetailsPrint both
    FileClose $2
    Abort "Resource extraction failed."
  TarExtractOK:

  ${GetTime} "" "L" $3 $4 $5 $6 $7 $8 $9
  FileWrite $2 "tar-extract-done: $5-$4-$3 $6:$7:$8 exit=$0$\r$\n"
  !insertmacro JustDoSetInstallProgress 92 \
    "核心资源已就绪，正在完成配置…" \
    "Core resources are ready. Finishing setup…"
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

  ; ─── Dependency manager config ───
  ; Copy optional npm/pip config templates into the branded app-data directory during install.
  ; Each file is independent: if a resource file is absent, that manager is left
  ; unconfigured and the app will not inject the corresponding env var.
  CreateDirectory "$APPDATA\${PRODUCT_NAME}\dependency-config"
  !insertmacro JustDoSetInstallProgress 95 \
    "正在写入本机配置…" \
    "Writing local configuration…"
  !insertmacro JustDoAddInstallActivity \
    "正在保存本机配置" \
    "Saving local configuration"
  ${If} ${FileExists} "$INSTDIR\resources\dependency-config\.npmrc"
    CopyFiles /SILENT "$INSTDIR\resources\dependency-config\.npmrc" "$APPDATA\${PRODUCT_NAME}\dependency-config\.npmrc"
    FileWrite $2 "dependency-config-npmrc: copied$\r$\n"
  ${Else}
    FileWrite $2 "dependency-config-npmrc: missing$\r$\n"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\resources\dependency-config\pip.ini"
    CopyFiles /SILENT "$INSTDIR\resources\dependency-config\pip.ini" "$APPDATA\${PRODUCT_NAME}\dependency-config\pip.ini"
    FileWrite $2 "dependency-config-pip-ini: copied$\r$\n"
  ${Else}
    FileWrite $2 "dependency-config-pip-ini: missing$\r$\n"
  ${EndIf}

  FileWrite $2 "delete-resource-tar: start$\r$\n"
  Delete "$INSTDIR\resources\win-resources.tar"
  ${If} ${FileExists} "$INSTDIR\resources\win-resources.tar"
    FileWrite $2 "delete-resource-tar: still-exists$\r$\n"
  ${Else}
    FileWrite $2 "delete-resource-tar: removed$\r$\n"
  ${EndIf}

  FileWrite $2 "clear-electron-run-as-node: start$\r$\n"
  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "")i'
  Pop $0
  FileWrite $2 "clear-electron-run-as-node: result=$0$\r$\n"

  ; Marks installations completed by NSIS. Packaged-but-uninstalled win-unpacked
  ; directories do not contain this file and must not enable auto-update.
  FileOpen $0 "$INSTDIR\resources\.justdo-nsis-installed" w
  FileWrite $0 "${VERSION}$\r$\n"
  FileClose $0
  FileWrite $2 "nsis-install-marker: written$\r$\n"
  !insertmacro JustDoSetInstallProgress 98 \
    "正在进行最后检查…" \
    "Running final checks…"
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
  FileWrite $2 "install-done: $5-$4-$3 $6:$7:$8$\r$\n"
  !insertmacro JustDoSetInstallProgress 100 \
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

