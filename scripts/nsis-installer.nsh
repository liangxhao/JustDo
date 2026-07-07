!include "FileFunc.nsh"

!define JUSTDO_POWERSHELL "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"

!macro StopJustDoProcesses
  ; Only stop processes whose executable is inside the current installation.
  ; Matching by process name or a loose "*JustDo*" path can terminate unrelated
  ; applications and development servers.
  ${If} "$INSTDIR" == ""
    Return
  ${EndIf}
  ${IfNot} ${FileExists} "$INSTDIR\*.*"
    Return
  ${EndIf}

  nsExec::ExecToLog '"${JUSTDO_POWERSHELL}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "\
    $$ErrorActionPreference = $\"SilentlyContinue$\";\
    $$installRoot = [IO.Path]::GetFullPath($\"$INSTDIR$\").TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar;\
    $$currentPid = $$PID;\
    $$isInstalledProcess = { param($$process)\
      try {\
        if ($$process.ProcessId -eq $$currentPid) { return $$false };\
        if ([string]::IsNullOrWhiteSpace($$process.ExecutablePath)) { return $$false };\
        $$processPath = [IO.Path]::GetFullPath($$process.ExecutablePath);\
        return $$processPath.StartsWith($$installRoot, [StringComparison]::OrdinalIgnoreCase);\
      } catch { return $$false }\
    };\
    $$findProcesses = {\
      @(Get-CimInstance Win32_Process | Where-Object { & $$isInstalledProcess $$_ })\
    };\
    & $$findProcesses | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue };\
    for ($$i = 0; $$i -lt 15; $$i++) {\
      if ((& $$findProcesses).Count -eq 0) { exit 0 };\
      Start-Sleep -Milliseconds 500;\
    };\
    exit 1"'
  Pop $0
  ${If} $0 != "0"
    DetailPrint "Some JustDo processes could not be closed automatically; continuing installation flow."
  ${EndIf}
!macroend

!macro customHeader
  ; Hide the (empty) details list — electron-builder uses 7z solid extraction
  ; which produces no per-file output, so the box would just be blank.
  ShowInstDetails nevershow
!macroend

!macro customCheckAppRunning
  ; Keep the assisted installer path free of PowerShell/CIM process scans.
  ; Some locked-down Windows environments terminate the installer as soon as
  ; those checks run after the user clicks Install.
!macroend

!macro customInit
  CreateDirectory "$APPDATA\JustDo"
  FileOpen $2 "$APPDATA\JustDo\install-timing.log" w
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
  ; Log file: %APPDATA%\JustDo\install-timing.log

  CreateDirectory "$APPDATA\JustDo"
  FileOpen $2 "$APPDATA\JustDo\install-timing.log" a

  ${GetTime} "" "L" $3 $4 $5 $6 $7 $8 $9
  FileWrite $2 "custom-install-start: $5-$4-$3 $6:$7:$8$\r$\n"
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

  nsExec::ExecToStack '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\unpack-cfmind.cjs" "$INSTDIR\resources\win-resources.tar" "$INSTDIR\resources"'
  Pop $0
  Pop $1
  FileWrite $2 "tar-extract-process-exit: $0$\r$\n"
  FileWrite $2 "tar-extract-process-output: $1$\r$\n"

  StrCmp $0 "0" TarExtractOK
    FileWrite $2 "tar-extract-error: exit=$0 output=$1$\r$\n"
    MessageBox MB_OK|MB_ICONEXCLAMATION "Resource extraction failed (exit code $0):$\r$\n$\r$\n$1"
    System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "")i'
    SetDetailsPrint both
    FileClose $2
    Abort "Resource extraction failed."
  TarExtractOK:

  ${GetTime} "" "L" $3 $4 $5 $6 $7 $8 $9
  FileWrite $2 "tar-extract-done: $5-$4-$3 $6:$7:$8 exit=$0$\r$\n"
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
  ${If} ${FileExists} "$INSTDIR\resources\mingit\bin\bash.exe"
    FileWrite $2 "mingit-after-tar: exists$\r$\n"
  ${Else}
    FileWrite $2 "mingit-after-tar: missing$\r$\n"
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
  FileClose $2

  SetDetailsPrint both
!macroend

!macro customUnInit
  ; Kill all running app instances (main app + OpenClaw gateway + detached
  ; node.exe services) before the uninstaller's built-in process check.
  ; Without this, the uninstaller detects the OpenClaw gateway process
  ; (also named JustDo.exe) and shows an "app cannot be closed" dialog
  ; where even "Retry" never succeeds — because the gateway has no UI window
  ; for the user to close.
  !insertmacro StopJustDoProcesses
!macroend

