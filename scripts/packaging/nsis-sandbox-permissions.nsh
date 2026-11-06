!ifndef INSTALLER_SANDBOX_PERMISSIONS_INCLUDED
!define INSTALLER_SANDBOX_PERMISSIONS_INCLUDED

!include "FileFunc.nsh"
!include "LogicLib.nsh"

!define INSTALLER_SANDBOX_PACKAGE_SID "S-1-15-2-2"
Var InstallerSandboxAccessResult
Var InstallerSandboxUserAppData
Var InstallerSandboxUserLocalAppData

!macro InstallerNormalizeSandboxPath _PATH _OUTPUT_REGISTER
  ; NSIS GetFullPathName requires an existing path. The Win32 API also admits
  ; a new installation directory without creating it during preflight.
  System::Call 'kernel32::GetFullPathNameW(w "${_PATH}\.", i ${NSIS_MAX_STRLEN}, w .${_OUTPUT_REGISTER}, p 0)i.r3'
  ${If} $3 == 0
  ${OrIf} $3 >= ${NSIS_MAX_STRLEN}
    StrCpy $InstallerSandboxAccessResult "invalid-install-directory"
    Goto InstallerSandboxAccessDone
  ${EndIf}
!macroend

!macro InstallerRejectSandboxRoot _PATH
  ${If} "${_PATH}" != ""
    !insertmacro InstallerNormalizeSandboxPath "${_PATH}" r2
    ${If} $0 == $2
      Goto InstallerSandboxAccessDone
    ${EndIf}
  ${EndIf}
!macroend

; Read-only admission runs before old-version removal as well as before the
; grant. A fresh target may not exist yet; every existing ancestor must be an
; ordinary directory. Preserve the old installation when a path is rejected.
Function InstallerValidateSandboxTarget
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $InstallerSandboxAccessResult "invalid-install-directory"
  ${GetRoot} "$INSTDIR" $1
  ${If} $1 == ""
    Goto InstallerSandboxAccessDone
  ${EndIf}
  !insertmacro InstallerNormalizeSandboxPath "$INSTDIR" r0
  !insertmacro InstallerNormalizeSandboxPath "$1" r1
  ${If} $0 == ""
  ${OrIf} $0 == $1
    Goto InstallerSandboxAccessDone
  ${EndIf}
  !insertmacro InstallerRejectSandboxRoot "$PROFILE"
  !insertmacro InstallerRejectSandboxRoot "$APPDATA"
  !insertmacro InstallerRejectSandboxRoot "$LOCALAPPDATA"
  !insertmacro InstallerRejectSandboxRoot "$InstallerSandboxUserAppData"
  !insertmacro InstallerRejectSandboxRoot "$InstallerSandboxUserLocalAppData"

  ; A junction in the selected path must not redirect an elevated ACL change.
  StrCpy $2 "$0"
  ${Do}
    System::Call 'kernel32::GetFileAttributesW(w r2)i.r3 ?e'
    Pop $InstallerSandboxAccessResult
    ${If} $3 == -1
      ${If} $InstallerSandboxAccessResult != "2"
      ${AndIf} $InstallerSandboxAccessResult != "3"
        StrCpy $InstallerSandboxAccessResult "invalid-install-directory"
        Goto InstallerSandboxAccessDone
      ${EndIf}
    ${Else}
      IntOp $3 $3 & 0x410
      ${If} $3 != 16
        StrCpy $InstallerSandboxAccessResult "invalid-install-directory"
        Goto InstallerSandboxAccessDone
      ${EndIf}
    ${EndIf}
    ${GetParent} "$2" $3
    ${If} $3 == ""
    ${OrIf} $3 == $2
      ${ExitDo}
    ${EndIf}
    !insertmacro InstallerNormalizeSandboxPath "$3" r2
    ${If} $2 == $1
      ${ExitDo}
    ${EndIf}
  ${Loop}
  StrCpy $InstallerSandboxAccessResult "0"
  InstallerSandboxAccessDone:
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; Chromium's restricted application containers need RX on the installed shell.
; Add one inheritable grant, preserving all other ACEs and the existing owner.
; New resources then inherit it without a second tree walk.
Function InstallerGrantSandboxReadAccess
  Call InstallerValidateSandboxTarget
  ${If} $InstallerSandboxAccessResult != "0"
    Return
  ${EndIf}
  Push $0
  Push $1
  ; Grant only to an existing canonical directory. A historical trailing
  ; backslash must not escape the closing quote in the process command line.
  GetFullPathName $0 "$INSTDIR\."
  System::Call 'kernel32::GetFileAttributesW(w r0)i.r1'
  ${If} $0 == ""
  ${OrIf} $1 == -1
    StrCpy $InstallerSandboxAccessResult "invalid-install-directory"
  ${Else}
    ; No shell, recursive /T, ACL reset, ownership change or sandbox bypass.
    ; /L addresses the link itself if the final component changes into a link.
    nsExec::ExecToStack /TIMEOUT=30000 '"$SYSDIR\icacls.exe" "$0" /grant "*${INSTALLER_SANDBOX_PACKAGE_SID}:(OI)(CI)(RX)" /L'
    Pop $InstallerSandboxAccessResult
    Pop $1
  ${EndIf}
  Pop $1
  Pop $0
FunctionEnd

!macro InstallerCheckSandboxAccessResult
  ${If} $InstallerSandboxAccessResult != "0"
    !insertmacro JustDoLogInstallEvent "phase=installer-abort reason=sandbox-permissions-failed result=$InstallerSandboxAccessResult"
    ${If} $LANGUAGE == ${JUSTDO_LANG_SIMPCHINESE}
    ${OrIf} $LANGUAGE == ${JUSTDO_LANG_TRADCHINESE}
      MessageBox MB_OK|MB_ICONSTOP "无法配置应用启动所需的读取和执行权限（$InstallerSandboxAccessResult）。请检查安装目录权限后重试。" /SD IDOK
    ${Else}
      MessageBox MB_OK|MB_ICONSTOP "Unable to configure the read and execute permissions required to start the application ($InstallerSandboxAccessResult). Check the installation directory permissions and retry." /SD IDOK
    ${EndIf}
    SetErrorLevel 2
    Abort "Application sandbox permissions could not be configured."
  ${EndIf}
!macroend

!macro InstallerRequireSandboxTarget _USER_APPDATA _USER_LOCALAPPDATA
  ; Keep the initiating user's roots even after all-users shell context/UAC.
  StrCpy $InstallerSandboxUserAppData "${_USER_APPDATA}"
  StrCpy $InstallerSandboxUserLocalAppData "${_USER_LOCALAPPDATA}"
  Call InstallerValidateSandboxTarget
  !insertmacro JustDoLogInstallEvent "phase=sandbox-target-validation result=$InstallerSandboxAccessResult"
  !insertmacro InstallerCheckSandboxAccessResult
!macroend

!macro InstallerRequireSandboxReadAccess
  !insertmacro JustDoLogInstallEvent "phase=sandbox-permissions-start"
  Call InstallerGrantSandboxReadAccess
  !insertmacro JustDoLogInstallEvent "phase=sandbox-permissions-result result=$InstallerSandboxAccessResult"
  !insertmacro InstallerCheckSandboxAccessResult
!macroend

!endif
