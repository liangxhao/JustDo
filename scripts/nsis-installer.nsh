!include "FileFunc.nsh"

!define JUSTDO_POWERSHELL "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"

!macro StopJustDoProcesses
  ; Only stop processes whose executable is inside the current installation.
  ; Matching by process name or a loose "*JustDo*" path can terminate unrelated
  ; applications and development servers.
  retryStopJustDoProcesses:
  nsExec::ExecToLog '"${JUSTDO_POWERSHELL}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "\
    $$installRoot = [IO.Path]::GetFullPath($\"$INSTDIR$\").TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar;\
    $$isInstalledProcess = {\
      param($$process)\
      try {\
        $$processPath = [IO.Path]::GetFullPath($$process.Path);\
        return $$processPath.StartsWith($$installRoot, [StringComparison]::OrdinalIgnoreCase);\
      } catch { return $$false }\
    };\
    $$findProcesses = {\
      @(Get-Process -Name JustDo,node -ErrorAction SilentlyContinue | Where-Object { & $$isInstalledProcess $$_ })\
    };\
    & $$findProcesses | Stop-Process -Force -ErrorAction SilentlyContinue;\
    for ($$i = 0; $$i -lt 15; $$i++) {\
      if ((& $$findProcesses).Count -eq 0) { exit 0 };\
      Start-Sleep -Milliseconds 500;\
    };\
    exit 1"'
  Pop $0
  ${If} $0 != "0"
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
      "JustDo processes are still running. Close them and retry." \
      IDRETRY retryStopJustDoProcesses
    Abort "Installation cancelled because JustDo is still running."
  ${EndIf}
!macroend

!macro customHeader
  ; Request admin privileges for script execution (tar extract, etc.)
  ; This does NOT change the default install path — just ensures UAC elevation.
  RequestExecutionLevel admin

  ; Hide the (empty) details list — electron-builder uses 7z solid extraction
  ; which produces no per-file output, so the box would just be blank.
  ShowInstDetails nevershow
!macroend

!macro customInit
  !insertmacro StopJustDoProcesses
!macroend

!macro customInstall
  ; ─── Install Timing Log ───
  ; Write timestamps to help diagnose slow installation phases.
  ; Log file: %APPDATA%\JustDo\install-timing.log

  CreateDirectory "$APPDATA\JustDo"
  FileOpen $2 "$APPDATA\JustDo\install-timing.log" w

  ${GetTime} "" "L" $3 $4 $5 $6 $7 $8 $9
  FileWrite $2 "extract-done: $5-$4-$3 $6:$7:$8$\r$\n"

  ; ─── Extract combined resource archive (win-resources.tar) ───
  ; All large resource directories (cfmind/, skills/, python-win/) are packed
  ; into a single tar file. NSIS 7z extracts one large file almost instantly;
  ; we then unpack the tar here using Electron's Node runtime.

  SetDetailsPrint none

  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "1")i'

  ${GetTime} "" "L" $3 $4 $5 $6 $7 $8 $9
  FileWrite $2 "tar-extract-start: $5-$4-$3 $6:$7:$8$\r$\n"

  nsExec::ExecToStack '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "$INSTDIR\resources\unpack-cfmind.cjs" "$INSTDIR\resources\win-resources.tar" "$INSTDIR\resources"'
  Pop $0
  Pop $1

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
  Delete "$INSTDIR\resources\win-resources.tar"

  System::Call 'Kernel32::SetEnvironmentVariable(t "ELECTRON_RUN_AS_NODE", t "")i'

  ; ─── Windows Defender Exclusion (optional, best-effort) ───
  ; Add the OpenClaw runtime directory to Windows Defender exclusions to avoid
  ; real-time scanning of ~3000 JS/native files during gateway startup.
  ; This can reduce first-launch time from ~120s to ~10s on Windows.
  ;
  ; This is a best-effort optimization:
  ; - Requires admin privileges (already elevated for installation)
  ; - Silently skipped if Defender is not running or policy disallows it
  ; - Only excludes the bundled runtime, not the entire application
  ; - Common practice for developer tools (VS Code, Docker Desktop, etc.)

  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Allow JustDo to exclude its bundled OpenClaw runtime from Microsoft Defender scanning? This can improve startup performance and can be reversed during uninstall." \
    IDNO DefenderExclusionSkipped
  nsExec::ExecToStack '"${JUSTDO_POWERSHELL}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "try { Add-MpPreference -ExclusionPath $\"$INSTDIR\resources\cfmind$\" -ErrorAction Stop; if ((Get-MpPreference).ExclusionPath -contains $\"$INSTDIR\resources\cfmind$\") { exit 0 } else { exit 1 } } catch { exit 1 }"'
  Pop $0
  Pop $1
  StrCmp $0 "0" 0 DefenderExclusionFailed
    FileOpen $1 "$INSTDIR\resources\.justdo-defender-exclusion" w
    FileWrite $1 "managed-by-justdo-installer"
    FileClose $1
    FileWrite $2 "defender-exclusion: added$\r$\n"
    Goto DefenderExclusionDone
  DefenderExclusionFailed:
    FileWrite $2 "defender-exclusion: failed exit=$0 output=$1$\r$\n"
    Goto DefenderExclusionDone
  DefenderExclusionSkipped:
    FileWrite $2 "defender-exclusion: declined$\r$\n"
  DefenderExclusionDone:

  ; Clean up the unpack script — no longer needed after installation
  Delete "$INSTDIR\resources\unpack-cfmind.cjs"

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

!macro customUnInstall
  ; ─── Remove Windows Defender Exclusion on uninstall ───
  ; Clean up the exclusion we added during installation.
  ${If} ${FileExists} "$INSTDIR\resources\.justdo-defender-exclusion"
    nsExec::ExecToStack '"${JUSTDO_POWERSHELL}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "try { Remove-MpPreference -ExclusionPath $\"$INSTDIR\resources\cfmind$\" -ErrorAction Stop; exit 0 } catch { exit 1 }"'
    Pop $0
    Pop $1
    ${If} $0 == "0"
      Delete "$INSTDIR\resources\.justdo-defender-exclusion"
    ${EndIf}
  ${EndIf}
!macroend
