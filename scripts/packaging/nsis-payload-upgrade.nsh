!define INSTALLER_UPGRADE_FOLDER ".upgrade"
Var InstallerPayloadLock

!macro InstallerLockPayloadUpgrade
  ${If} $InstallerPayloadLock == ""
    System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Local\${APP_GUID}.payload-upgrade")p.r1 ?e'
    Pop $2
    ${If} $1 == 0
    ${OrIf} $2 == 183
      ${If} $1 != 0
        System::Call 'kernel32::CloseHandle(p r1)i'
      ${EndIf}
      MessageBox MB_OK|MB_ICONINFORMATION "安装或卸载正在进行，请等待完成后重试。$\r$\nAnother installation or removal is in progress. Wait for it to finish and retry." /SD IDOK
      SetErrorLevel 2
      Abort "The upgrade files are in use by another installer or uninstaller."
    ${EndIf}
    StrCpy $InstallerPayloadLock $1
  ${EndIf}
!macroend

!macro InstallerUnlockPayloadUpgrade
  ${If} $InstallerPayloadLock != ""
    System::Call 'kernel32::CloseHandle(p $InstallerPayloadLock)i'
    StrCpy $InstallerPayloadLock ""
  ${EndIf}
!macroend

!macro InstallerRunPayloadHelper _ACTION _ROOT _VERSION
  InitPluginsDir
  File /oname=$PLUGINSDIR\payload-upgrade.ps1 "${PROJECT_DIR}\scripts\packaging\nsis-payload-upgrade.ps1"
  File /oname=$PLUGINSDIR\nsis-payload-files.cs "${PROJECT_DIR}\scripts\packaging\nsis-payload-files.cs"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\payload-upgrade.ps1" -Action ${_ACTION} -InstallRoot "${_ROOT}" -Application "${PRODUCT_FILENAME}.exe" -Uninstaller "Uninstall ${PRODUCT_FILENAME}.exe" -Authentication "name:${BROWSER_AUTHENTICATION_EXECUTABLE}" -RegisteredVersion "v${_VERSION}" -InstallKey "${INSTALL_REGISTRY_KEY}" -UninstallKey "${UNINSTALL_REGISTRY_KEY}"'
!macroend

!macro InstallerCheckPendingPayloadUpgrade _ROOT _VERSION
  System::Call 'kernel32::GetFileAttributesW(w "${_ROOT}\${INSTALLER_UPGRADE_FOLDER}")i.r1 ?e'
  Pop $2
  ${If} $1 != -1
    ${If} ${UAC_IsAdmin}
      StrCpy $1 2
    ${Else}
      !insertmacro InstallerRunPayloadHelper "Recover" "${_ROOT}" "${_VERSION}"
      Pop $1
      Pop $2
    ${EndIf}
    ${If} $1 != 0
      MessageBox MB_OK|MB_ICONSTOP "旧版安装文件仍保存在安装目录的 ${INSTALLER_UPGRADE_FOLDER} 中。请用原安装账户重试。$\r$\nThe previous installation files are still in ${INSTALLER_UPGRADE_FOLDER}. Retry under the original installation account." /SD IDOK
      SetErrorLevel 2
      Abort "The interrupted upgrade could not be recovered."
    ${EndIf}
  ${ElseIf} $2 != 2
  ${AndIf} $2 != 3
    SetErrorLevel 2
    Abort "The upgrade staging directory could not be checked."
  ${EndIf}
  ClearErrors
!macroend

!ifndef BUILD_UNINSTALLER
Var InstallerPayloadLegacyGuard

!macro InstallerReleaseLegacyGuard
  ${If} $InstallerPayloadLegacyGuard != ""
    System::Call 'kernel32::CloseHandle(p $InstallerPayloadLegacyGuard)i'
    StrCpy $InstallerPayloadLegacyGuard ""
  ${EndIf}
!macroend

!macro InstallerRecoverPayloadUpgrade
  Push $0
  Push $1
  Push $2
  Push $3
  ${IfNot} ${UAC_IsAdmin}
    ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $0 != ""
      ReadRegStr $3 HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
      ${If} $3 == '$\"$0\Uninstall ${PRODUCT_FILENAME}.exe$\" /currentuser'
      System::Call 'kernel32::GetFileAttributesW(w "$0\${INSTALLER_UPGRADE_FOLDER}")i.r1 ?e'
      Pop $2
      ${If} $1 != -1
        !insertmacro InstallerLockPayloadUpgrade
        ReadRegStr $3 HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayVersion
        !insertmacro InstallerCheckPendingPayloadUpgrade "$0" "$3"
        !insertmacro InstallerUnlockPayloadUpgrade
      ${ElseIf} $2 != 2
      ${AndIf} $2 != 3
        SetErrorLevel 2
        Abort "The upgrade staging directory could not be checked."
      ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro InstallerPreparePayloadUpgrade
  !ifndef ONE_CLICK
  !ifmacrondef registerFileAssociations
    ${If} $installMode == "CurrentUser"
    ${AndIf} $oldDesktopLink == $newDesktopLink
    ${AndIf} $oldStartMenuLink == $newStartMenuLink
    ${AndIfNot} ${UAC_IsAdmin}
      StrCpy $InstallerLookupMode "$installMode"
      Call InstallerResolveRegisteredDirectory
      ${If} $InstallerLookupState == "confirmed"
      ${AndIf} $InstallerLookupUninstallDirectory != ""
        GetFullPathName $0 "$INSTDIR\."
        GetFullPathName $1 "$InstallerLookupDirectory\."
        GetFullPathName $2 "$InstallerLookupUninstallDirectory\."
        ReadRegStr $3 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
        ${If} $3 != ""
          GetFullPathName $3 "$3\."
        ${EndIf}
        ReadRegStr $4 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
        GetFullPathName $4 "$4\."
        ReadRegStr $5 HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
        ${If} $0 != ""
        ${AndIf} $0 == $1
        ${AndIf} $0 == $2
        ${AndIf} $0 != $3
        ${AndIf} $0 == $4
        ${AndIf} $5 == '$\"$0\Uninstall ${PRODUCT_FILENAME}.exe$\" /currentuser'
          StrCpy $InstallerPayloadRoot "$0"
          !insertmacro InstallerLockPayloadUpgrade
          ; A legacy launcher cannot honor our mutex. Allow moves of its image
          ; but prevent opening it for execution while the upgrade is in flight.
          System::Call 'kernel32::CreateFileW(w "$InstallerPayloadRoot\${UNINSTALL_FILENAME}", i 0x10000, i 4, p 0, i 3, i 0x200000, p 0)p.r1'
          ${If} $1 == -1
            StrCpy $InstallerPayloadRoot ""
            !insertmacro InstallerUnlockPayloadUpgrade
            SetErrorLevel 2
            Abort "The previous uninstaller is in use. Close it and retry setup."
          ${EndIf}
          StrCpy $InstallerPayloadLegacyGuard $1
          ReadRegStr $2 HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayVersion
          !insertmacro InstallerShowCorePhase "正在准备在安装盘暂存新版…" "Preparing to stage the new version on the installation drive…"
          !insertmacro JustDoLogInstallEvent "phase=payload-upgrade-prepare-start"
          !insertmacro InstallerRunPayloadHelper "Prepare" "$InstallerPayloadRoot" "$2"
          Pop $0
          Pop $1
          !insertmacro JustDoLogInstallEvent "phase=payload-upgrade-prepare result=$0"
          ${If} $0 == 10
            StrCpy $InstallerPayloadRoot ""
            !insertmacro InstallerReleaseLegacyGuard
            !insertmacro InstallerUnlockPayloadUpgrade
          ${ElseIf} $0 != 0
            SetErrorLevel 2
            Abort "The upgrade staging folder could not be prepared."
          ${Else}
            StrCpy $INSTDIR "$InstallerPayloadRoot\${INSTALLER_UPGRADE_FOLDER}\new"
            StrCpy $keepShortcuts "true"
          ${EndIf}
        ${EndIf}
      ${EndIf}
    ${EndIf}
  !endif
  !endif
!macroend

!macro InstallerPublishPayloadUpgrade
  ${If} $InstallerPayloadRoot != ""
    StrCpy $INSTDIR "$InstallerPayloadRoot"
    SetOutPath "$INSTDIR"
    !insertmacro InstallerShowCorePhase "正在复查旧版是否已退出…" "Confirming the previous version is closed…"
    !insertmacro FindJustDoProcesses $0
    ${If} $0 == "0"
      SetErrorLevel 2
      Abort "The previous application is still running. Close it and retry setup."
    ${EndIf}
    !insertmacro InstallerShowCorePhase "正在切换新旧程序文件…" "Switching to the new application files…"
    !insertmacro JustDoLogInstallEvent "phase=payload-upgrade-publish-start"
    !insertmacro InstallerRunPayloadHelper "Publish" "$InstallerPayloadRoot" ""
    Pop $0
    Pop $1
    !insertmacro JustDoLogInstallEvent "phase=payload-upgrade-publish result=$0"
    ${If} $0 != 0
      SetErrorLevel 2
      Abort "The staged application files could not be switched."
    ${EndIf}
  ${EndIf}
!macroend

!macro InstallerFinishPayloadUpgrade
  ${If} $InstallerPayloadRoot != ""
    ReadRegStr $2 HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayVersion
    ${If} $2 != "${VERSION}"
      !insertmacro InstallerRollbackPayloadUpgrade
      SetErrorLevel 2
      Abort "Windows could not register the updated application."
    ${EndIf}
    !insertmacro InstallerShowCorePhase "新版已就位，正在清理旧版暂存文件…" "New version ready. Removing the previous application files…"
    !insertmacro InstallerReleaseLegacyGuard
    !insertmacro JustDoLogInstallEvent "phase=payload-upgrade-clean-start"
    !insertmacro InstallerRunPayloadHelper "Clean" "$InstallerPayloadRoot" "$2"
    Pop $0
    Pop $1
    !insertmacro JustDoLogInstallEvent "phase=payload-upgrade-clean result=$0"
    ${If} $0 != 0
    ${AndIf} $0 != 13
      !insertmacro InstallerRollbackPayloadUpgrade
      SetErrorLevel 2
      Abort "The installed files do not match the registered upgrade."
    ${EndIf}
    ${If} $0 == 13
      !insertmacro JustDoAddInstallActivity "部分旧版暂存文件仍被占用，下次安装时将重试清理" "Some old files could not be removed. Setup will retry on the next run."
    ${EndIf}
    StrCpy $InstallerPayloadRoot ""
    !insertmacro InstallerUnlockPayloadUpgrade
  ${EndIf}
!macroend

!macro InstallerCheckPayloadRegistration
  ${If} $InstallerPayloadRoot != ""
  ${AndIf} ${Errors}
    !insertmacro InstallerRollbackPayloadUpgrade
    SetErrorLevel 2
    Abort "Windows could not register the updated application."
  ${EndIf}
!macroend

!macro InstallerRollbackPayloadUpgrade
  ${If} $InstallerPayloadRoot != ""
    StrCpy $INSTDIR "$InstallerPayloadRoot"
    SetOutPath "$INSTDIR"
    !insertmacro InstallerReleaseLegacyGuard
    !insertmacro InstallerShowCorePhase "正在检查并恢复旧版程序文件…" "Checking and restoring the previous application files…"
    ReadRegStr $2 HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayVersion
    !insertmacro InstallerRunPayloadHelper "Recover" "$InstallerPayloadRoot" "$2"
    Pop $0
    Pop $1
    !insertmacro JustDoLogInstallEvent "phase=payload-upgrade-recovery result=$0"
    ${If} $0 != 0
      !insertmacro JustDoAddInstallActivity "未能完成恢复，暂存文件保留在安装目录的 ${INSTALLER_UPGRADE_FOLDER}" "Recovery is incomplete. Staged files remain in the installation directory under ${INSTALLER_UPGRADE_FOLDER}."
    ${EndIf}
    StrCpy $InstallerPayloadRoot ""
    !insertmacro InstallerUnlockPayloadUpgrade
  ${EndIf}
!macroend
!endif
