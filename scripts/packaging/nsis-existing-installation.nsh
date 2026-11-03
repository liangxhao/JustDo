!ifndef INSTALLER_EXISTING_INSTALLATION_INCLUDED
!define INSTALLER_EXISTING_INSTALLATION_INCLUDED

!include "FileFunc.nsh"
!include "LogicLib.nsh"

; One read-only authority for the current product GUID and registry view.
; Mode is CurrentUser/all. Directory is populated only for a confirmed product
; executable; UninstallDirectory independently pairs an existing expected
; uninstaller with its own parent, including an incomplete installation repair.
Var InstallerLookupMode
Var InstallerLookupDirectory
Var InstallerLookupState
Var InstallerLookupUninstallDirectory

; Call only from the resolver: $8/$9 are private scratch registers there.
!macro InstallerLookupAbsolutePath _PATH _RESULT
  StrCpy ${_RESULT} "0"
  StrCpy $8 "${_PATH}" 1 1
  StrCpy $9 "${_PATH}" 1 2
  ${If} $8 == ":"
  ${AndIf} $9 == "\"
    StrCpy ${_RESULT} "1"
  ${Else}
    StrCpy $8 "${_PATH}" 2
    ${If} $8 == "\\"
      StrCpy ${_RESULT} "1"
    ${EndIf}
  ${EndIf}
!macroend

; Capture the error at the API boundary. An inaccessible path is not an absent product.
!macro InstallerLookupFileAttributes _PATH
  System::Call 'kernel32::GetFileAttributesW(w "${_PATH}")i.r5 ?e'
  Pop $9
  ${If} $5 == -1
  ${AndIf} $9 != 2
  ${AndIf} $9 != 3
    StrCpy $InstallerLookupState "unknown"
  ${EndIf}
!macroend

Function InstallerResolveRegisteredDirectory
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  StrCpy $9 "0"
  ${If} ${Errors}
    StrCpy $9 "1"
  ${EndIf}
  Push $9
  StrCpy $InstallerLookupDirectory ""
  StrCpy $InstallerLookupUninstallDirectory ""
  StrCpy $InstallerLookupState "missing"
  StrCpy $0 ""
  StrCpy $1 ""
  ${If} $InstallerLookupMode == "all"
    ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $1 HKLM "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${ElseIf} $InstallerLookupMode == "CurrentUser"
    ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $1 HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${EndIf}

  StrCpy $2 ""
  !insertmacro InstallerLookupAbsolutePath "$0" $7
  ${If} $7 == "1"
    !insertmacro InstallerLookupFileAttributes "$0\${APP_EXECUTABLE_FILENAME}"
    ${If} $5 != -1
      IntOp $5 $5 & 0x10
      ${If} $5 == 0
        GetFullPathName $2 "$0\."
        ${If} $2 == ""
          StrCpy $InstallerLookupState "unknown"
        ${Else}
          StrCpy $InstallerLookupDirectory "$0"
          StrCpy $InstallerLookupState "confirmed"
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ; Require the quoted executable at the start of the ARP command. Looking for
  ; an arbitrary quoted argument could mistake another file for the uninstaller.
  StrCpy $3 ""
  StrCpy $5 "$1" 1
  ${If} $5 == '$\"'
    StrCpy $5 1
    ${Do}
      StrCpy $6 "$1" 1 $5
      ${If} $6 == ""
        ${ExitDo}
      ${ElseIf} $6 == '$\"'
        IntOp $6 $5 - 1
        StrCpy $3 "$1" $6 1
        ${ExitDo}
      ${EndIf}
      IntOp $5 $5 + 1
    ${Loop}
  ${EndIf}
  !insertmacro InstallerLookupAbsolutePath "$3" $7
  ${If} $7 == "1"
    ${GetFileName} "$3" $6
    ${If} $6 == "${UNINSTALL_FILENAME}"
      !insertmacro InstallerLookupFileAttributes "$3"
      ${If} $5 != -1
        IntOp $5 $5 & 0x10
        ${If} $5 == 0
          ${GetParent} "$3" $4
          StrCpy $InstallerLookupUninstallDirectory "$4"
          GetFullPathName $6 "$4\."
          ${If} $6 == ""
            StrCpy $InstallerLookupState "unknown"
          ${ElseIf} $2 != ""
          ${AndIf} $2 != $6
            StrCpy $InstallerLookupState "conflict"
            StrCpy $InstallerLookupDirectory ""
            StrCpy $InstallerLookupUninstallDirectory ""
          ${Else}
            !insertmacro InstallerLookupFileAttributes "$4\${APP_EXECUTABLE_FILENAME}"
            ${If} $5 != -1
              IntOp $5 $5 & 0x10
              ${If} $5 == 0
              ${AndIf} $InstallerLookupState != "unknown"
                ${If} $InstallerLookupDirectory == ""
                  StrCpy $InstallerLookupDirectory "$4"
                ${EndIf}
                StrCpy $InstallerLookupState "confirmed"
              ${EndIf}
            ${EndIf}
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ${If} $InstallerLookupState == "unknown"
    StrCpy $InstallerLookupDirectory ""
    StrCpy $InstallerLookupUninstallDirectory ""
  ${EndIf}
  Pop $9
  ${If} $9 == "1"
    SetErrors
  ${Else}
    ClearErrors
  ${EndIf}
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

!endif
