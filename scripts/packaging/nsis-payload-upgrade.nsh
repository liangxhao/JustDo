!define INSTALLER_UPGRADE_FOLDER ".upgrade"
!define INSTALLER_UPGRADE_NEXT_FOLDER ".upgrade-next"
!define INSTALLER_PAYLOAD_SWITCH_RETRY 14
!define INSTALLER_PAYLOAD_SWITCH_RECOVERY_FAILED 15
Var InstallerPayloadLock
Var InstallerPayloadSlot

!macro InstallerLockPayloadUpgrade _REQUIRED
  ${If} $InstallerPayloadLock == ""
    System::Call 'kernel32::CreateMutexW(p 0, i 0, w "Local\${APP_GUID}.payload-upgrade")p.r1 ?e'
    Pop $2
    ${If} $1 == 0
    ${OrIf} $2 == 183
      ${If} $1 != 0
        System::Call 'kernel32::CloseHandle(p r1)i'
      ${EndIf}
      !if "${_REQUIRED}" == "1"
        ${If} $2 == 183
          StrCpy $1 "安装或卸载正在进行，请等待完成后重试。$\r$\nAnother installation or removal is in progress. Wait for it to finish and retry."
        ${Else}
          StrCpy $1 "无法锁定安装流程（Windows 错误 $2），请关闭其他安装程序后重试。$\r$\nCould not lock setup (Windows error $2). Close other installers and retry."
        ${EndIf}
        MessageBox MB_OK|MB_ICONINFORMATION "$1" /SD IDOK
        SetErrorLevel 2
        Abort "The upgrade files are in use by another installer or uninstaller."
      !endif
    ${Else}
      StrCpy $InstallerPayloadLock $1
    ${EndIf}
  ${EndIf}
!macroend

!macro InstallerUnlockPayloadUpgrade
  ${If} $InstallerPayloadLock != ""
    System::Call 'kernel32::CloseHandle(p $InstallerPayloadLock)i'
    StrCpy $InstallerPayloadLock ""
  ${EndIf}
!macroend

!macro InstallerRunPayloadHelper _ACTION _ROOT _VERSION
  ClearErrors
  InitPluginsDir
  File /oname=$PLUGINSDIR\payload-upgrade.ps1 "${PROJECT_DIR}\scripts\packaging\nsis-payload-upgrade.ps1"
  File /oname=$PLUGINSDIR\nsis-payload-files.cs "${PROJECT_DIR}\scripts\packaging\nsis-payload-files.cs"
  ${If} ${Errors}
    Push "reason=helper-files-unavailable"
    Push "error"
  ${Else}
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\payload-upgrade.ps1" -Action ${_ACTION} -InstallRoot "${_ROOT}" -Application "${PRODUCT_FILENAME}.exe" -Uninstaller "Uninstall ${PRODUCT_FILENAME}.exe" -AgentCli "${AGENT_CLI_EXECUTABLE}" -Authentication "name:${BROWSER_AUTHENTICATION_EXECUTABLE}" -RegisteredVersion "v${_VERSION}" -InstallKey "${INSTALL_REGISTRY_KEY}" -UninstallKey "${UNINSTALL_REGISTRY_KEY}" -StagingSlot "slot:$InstallerPayloadSlot"'
    ${If} ${Errors}
      Pop $1
      Push "reason=helper-plugin-unavailable"
      Push "error"
    ${EndIf}
  ${EndIf}
  ClearErrors
!macroend

!macro InstallerCheckPayloadSlot _ROOT _MODE _SLOT _FOLDER
  StrCpy $InstallerPayloadSlot ${_SLOT}
  System::Call 'kernel32::GetFileAttributesW(w "${_ROOT}\${_FOLDER}")i.r1 ?e'
  Pop $2
  ${If} $1 != -1
    !if "${_MODE}" == "optional"
      !insertmacro InstallerLockPayloadUpgrade "0"
    !else if "${_MODE}" == "required"
      !insertmacro InstallerLockPayloadUpgrade "1"
    !endif
    ${If} $InstallerPayloadLock == ""
      StrCpy $1 2
      StrCpy $2 "reason=upgrade-lock-unavailable win32-error=$2"
    ${Else}
      !ifndef BUILD_UNINSTALLER
        !insertmacro JustDoLogInstallEvent "phase=payload-upgrade-pending-recovery-start path=${_ROOT}\${_FOLDER}"
      !endif
      !if "${_MODE}" == "required"
        !insertmacro InstallerRunPayloadHelper "DiscardStaging" "${_ROOT}" ""
      !else
        ${If} ${UAC_IsAdmin}
          !insertmacro InstallerRunPayloadHelper "DiscardStaging" "${_ROOT}" ""
        ${Else}
          !insertmacro InstallerRunPayloadHelper "Recover" "${_ROOT}" ""
        ${EndIf}
      !endif
      Pop $1
      Pop $2
    ${EndIf}
    !ifndef BUILD_UNINSTALLER
      !insertmacro InstallerReportPayloadHelper "pending-recovery" $1 $2
    !endif
    !if "${_MODE}" != "optional"
    ${If} $1 != 0
    !if "${_MODE}" == "upgrade"
    ${AndIf} $1 != 13
    !endif
      ${If} $1 == 13
        StrCpy $1 "上次升级已成功，但旧版备份尚未清理。请关闭占用文件的程序或重启电脑后重试。$\r$\nThe previous upgrade finished, but its backup could not be removed. Close programs using the files or restart Windows and try again."
      ${Else}
        StrCpy $1 "无法恢复上次升级。请勿删除暂存目录；若重试仍失败，请将以下信息发给技术支持。$\r$\nCould not recover the previous upgrade. Do not delete the staging directory. If retrying fails, send these details to support."
      ${EndIf}
      MessageBox MB_OK|MB_ICONSTOP "$1$\r$\n$\r$\n${_ROOT}\${_FOLDER}$\r$\n$\r$\n$2" /SD IDOK
      SetErrorLevel 2
      Abort "The interrupted upgrade could not be recovered."
    ${EndIf}
    !endif
    !if "${_MODE}" == "upgrade"
    ${If} $1 == 13
      !insertmacro JustDoAddInstallActivity "旧版备份仍在使用，将尝试另一处暂存位置。" "The old backup is still in use. Setup will try the other staging location."
    ${EndIf}
    !endif
    !if "${_MODE}" == "optional"
      !insertmacro InstallerUnlockPayloadUpgrade
    !else if "${_MODE}" == "required"
      !insertmacro InstallerUnlockPayloadUpgrade
    !endif
  ${ElseIf} $2 != 2
  ${AndIf} $2 != 3
    !ifndef BUILD_UNINSTALLER
      !insertmacro JustDoLogInstallEvent "phase=payload-upgrade-pending-recovery result=attribute-error detail=win32-error=$2 path=${_ROOT}\${_FOLDER}"
    !endif
    !if "${_MODE}" != "optional"
      MessageBox MB_OK|MB_ICONSTOP "无法访问升级暂存目录，请检查权限后重试。$\r$\nCannot access the upgrade staging path. Check its permissions and retry.$\r$\n$\r$\n${_ROOT}\${_FOLDER} (Windows $2)" /SD IDOK
      SetErrorLevel 2
      Abort "The upgrade staging directory could not be checked."
    !endif
  ${Else}
    StrCpy $1 0
  ${EndIf}
  ClearErrors
!macroend

!macro InstallerCheckPendingPayloadUpgrade _ROOT _MODE
  !insertmacro InstallerCheckPayloadSlot "${_ROOT}" "${_MODE}" 0 "${INSTALLER_UPGRADE_FOLDER}"
  !if "${_MODE}" == "upgrade"
    Push $1
  !endif
  !insertmacro InstallerCheckPayloadSlot "${_ROOT}" "${_MODE}" 1 "${INSTALLER_UPGRADE_NEXT_FOLDER}"
  !if "${_MODE}" == "upgrade"
    Pop $2
    ${If} $2 == 13
    ${AndIf} $1 == 13
      MessageBox MB_OK|MB_ICONSTOP "两处升级备份均暂时无法清理。请关闭占用安装文件的程序或重启后重试。$\r$\nBoth upgrade backups are still in use. Close programs using the installation files or restart Windows and retry." /SD IDOK
      SetErrorLevel 2
      Abort "No upgrade staging directory is available."
    ${EndIf}
    ${If} $2 != 13
      StrCpy $InstallerPayloadSlot 0
    ${EndIf}
  !else
    StrCpy $InstallerPayloadSlot 0
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
!include "StrFunc.nsh"
!ifndef StrRep_INCLUDED
  ${StrRep}
!endif
Var InstallerPayloadLegacyGuard
Var InstallerPayloadSwitchRetried
Var InstallerPayloadFallbackRoot
Var InstallerPayloadFallbackDirectoryId
Var InstallerPayloadFallbackUninstallerId

!macro InstallerClearStagingBeforeWrite _ROOT
  Push $1
  Push $2
  !insertmacro InstallerCheckPendingPayloadUpgrade "${_ROOT}" "required"
  Pop $2
  Pop $1
!macroend

!macro InstallerCheckLegacyPayloadRemoval _ROOT
  Push $1
  Push $2
  !insertmacro InstallerShowCorePhase "正在确认常规升级不会误删其他文件…" "Checking files before conventional upgrade…"
  !insertmacro InstallerRunPayloadHelper "CheckLegacyRemoval" "${_ROOT}" ""
  Pop $1
  Pop $2
  !insertmacro InstallerReportPayloadHelper "legacy-removal-check" $1 $2
  ${If} $1 != 0
    !insertmacro JustDoAddInstallActivity "无法安全卸载旧版（代码 $1）：$2" "The previous installation could not be safely removed (code $1): $2"
    MessageBox MB_OK|MB_ICONSTOP "无法确认旧版可以安全卸载，尚未启动卸载程序。请将以下信息发给技术支持。$\r$\nSetup did not start the previous uninstaller because it could not safely remove this installation. Send these details to support.$\r$\n$\r$\n${_ROOT}$\r$\n($1) $2" /SD IDOK
    SetErrorLevel 2
    Abort "Conventional upgrade could not safely remove the previous installation."
  ${EndIf}
  Pop $2
  Pop $1
!macroend

!macro InstallerReportPayloadHelper _PHASE _RESULT _DETAIL
  ${StrRep} ${_DETAIL} "${_DETAIL}" "$\r" " "
  ${StrRep} ${_DETAIL} "${_DETAIL}" "$\n" " "
  StrCpy ${_DETAIL} "${_DETAIL}" 600
  ${If} ${_DETAIL} == ""
    ${If} ${_RESULT} == "error"
      StrCpy ${_DETAIL} "reason=helper-launch-failed"
    ${ElseIf} ${_RESULT} != "0"
      StrCpy ${_DETAIL} "reason=helper-returned-no-detail"
    ${EndIf}
  ${EndIf}
  !insertmacro JustDoLogInstallEvent "phase=payload-upgrade-${_PHASE} result=${_RESULT} detail=${_DETAIL}"
!macroend

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
        !insertmacro InstallerCheckPendingPayloadUpgrade "$0" "optional"
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
          !insertmacro InstallerLockPayloadUpgrade "1"
          !insertmacro InstallerCheckPendingPayloadUpgrade "$InstallerPayloadRoot" "upgrade"
          ; A legacy launcher cannot honor our mutex. Allow moves of its image
          ; but prevent opening it for execution while the upgrade is in flight.
          System::Call 'kernel32::CreateFileW(w "$InstallerPayloadRoot\${UNINSTALL_FILENAME}", i 0x10000, i 4, p 0, i 3, i 0x200000, p 0)p.r1 ?e'
          Pop $2
          ${If} $1 == -1
            !insertmacro JustDoLogInstallEvent "phase=payload-upgrade-prepare result=uninstaller-open-failed detail=win32-error=$2 path=$InstallerPayloadRoot\${UNINSTALL_FILENAME}"
            !insertmacro JustDoAddInstallActivity "无法访问旧版卸载程序（Windows 错误 $2）：$InstallerPayloadRoot\${UNINSTALL_FILENAME}。请关闭占用该文件的程序，或检查文件权限后重试。" "Cannot open the previous uninstaller (Windows error $2): $InstallerPayloadRoot\${UNINSTALL_FILENAME}. Close programs using that file or check its permissions and retry."
            StrCpy $InstallerPayloadRoot ""
            !insertmacro InstallerUnlockPayloadUpgrade
            SetErrorLevel 2
            Abort "The previous uninstaller could not be opened."
          ${EndIf}
          StrCpy $InstallerPayloadLegacyGuard $1
          ReadRegStr $2 HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayVersion
          !insertmacro InstallerShowCorePhase "正在准备在安装盘暂存新版…" "Preparing to stage the new version on the installation drive…"
          !insertmacro JustDoLogInstallEvent "phase=payload-upgrade-prepare-start"
          !insertmacro InstallerRunPayloadHelper "Prepare" "$InstallerPayloadRoot" "$2"
          Pop $0
          Pop $1
          !insertmacro InstallerReportPayloadHelper "prepare" $0 $1
          ${If} $0 == 10
            !insertmacro JustDoAddInstallActivity "此安装不支持同盘暂存，将使用常规升级方式。" "Same-volume staging is unavailable for this installation. Continuing with a standard upgrade."
            StrCpy $InstallerPayloadRoot ""
            !insertmacro InstallerReleaseLegacyGuard
            !insertmacro InstallerUnlockPayloadUpgrade
          ${ElseIf} $0 != 0
            !insertmacro JustDoAddInstallActivity "无法准备升级暂存目录（代码 $0）：$1" "Could not prepare upgrade staging (code $0): $1"
            SetErrorLevel 2
            Abort "The upgrade staging folder could not be prepared."
          ${Else}
            ${If} $InstallerPayloadSlot == 1
              StrCpy $INSTDIR "$InstallerPayloadRoot\${INSTALLER_UPGRADE_NEXT_FOLDER}\new"
            ${Else}
              StrCpy $INSTDIR "$InstallerPayloadRoot\${INSTALLER_UPGRADE_FOLDER}\new"
            ${EndIf}
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
    StrCpy $InstallerPayloadSwitchRetried 0
    InstallerRetryPayloadSwitch:
    !insertmacro InstallerShowCorePhase "正在复查旧版是否已退出…" "Confirming the previous version is closed…"
    !insertmacro FindJustDoProcesses $0
    ${If} $0 == "0"
      !insertmacro InstallerShowCorePhase "正在关闭旧版应用…" "Closing the previous application…"
      !insertmacro RequestAndWaitForInstallerQuit $0
      ${If} $0 != "0"
        !insertmacro InstallerStopPayloadProcesses
      ${EndIf}
    ${EndIf}
    !insertmacro InstallerShowCorePhase "正在切换新旧程序文件…" "Switching to the new application files…"
    !insertmacro JustDoLogInstallEvent "phase=payload-upgrade-publish-start"
    ${If} $InstallerPayloadSwitchRetried == 0
      !insertmacro InstallerRunPayloadHelper "Publish" "$InstallerPayloadRoot" ""
    ${Else}
      !insertmacro InstallerRunPayloadHelper "RetryPublish" "$InstallerPayloadRoot" ""
    ${EndIf}
    Pop $0
    Pop $1
    !insertmacro InstallerReportPayloadHelper "publish" $0 $1
    ${If} $0 == ${INSTALLER_PAYLOAD_SWITCH_RETRY}
      ${If} $InstallerPayloadSwitchRetried == 0
        StrCpy $InstallerPayloadSwitchRetried 1
        !insertmacro InstallerStopPayloadProcesses
        Goto InstallerRetryPayloadSwitch
      ${EndIf}
      !insertmacro InstallerFallbackAfterPayloadSwitch
    ${EndIf}
    ${If} $0 == ${INSTALLER_PAYLOAD_SWITCH_RECOVERY_FAILED}
      !insertmacro JustDoAddInstallActivity "旧版未能完整恢复，请勿删除升级暂存目录。未启动旧版卸载器：$1" "The previous version was not fully restored. Do not delete the upgrade staging directory. The previous uninstaller was not started: $1"
    ${EndIf}
    ${If} $0 != 0
      !insertmacro JustDoAddInstallActivity "无法切换新旧程序文件（代码 $0）：$1" "Could not switch the application files (code $0): $1"
      SetErrorLevel 2
      Abort "The staged application files could not be switched."
    ${EndIf}
  ${EndIf}
!macroend

!macro InstallerStopPayloadProcesses
  !insertmacro InstallerShowCorePhase "正在关闭此安装目录中仍运行的进程…" "Closing processes running from this installation…"
  !insertmacro StopJustDoProcesses $0 "-VerifiedExecutablesOnly"
  !insertmacro JustDoLogInstallEvent "phase=payload-upgrade-forced-shutdown result=$0 detail=$R9"
  ${If} $0 == "1"
    !insertmacro JustDoAddInstallActivity "仍有进程在使用旧版，请退出应用后重试；尚未启动卸载器。" "Processes are still using the previous installation. Quit the app and retry; the uninstaller was not started."
    SetErrorLevel 2
    Abort "The previous application could not be closed."
  ${EndIf}
!macroend

!macro InstallerFallbackAfterPayloadSwitch
  StrCpy $InstallerLookupMode "CurrentUser"
  Call InstallerResolveRegisteredDirectory
  GetFullPathName $0 "$InstallerLookupDirectory\."
  GetFullPathName $1 "$InstallerLookupUninstallDirectory\."
  ReadRegStr $2 HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${If} $InstallerLookupState != "confirmed"
  ${OrIf} $0 != $InstallerPayloadRoot
  ${OrIf} $1 != $InstallerPayloadRoot
  ${OrIf} $2 != '$\"$InstallerPayloadRoot\${UNINSTALL_FILENAME}$\" /currentuser'
    !insertmacro JustDoLogInstallEvent "phase=payload-upgrade-fallback-blocked reason=previous-installation-changed path=$InstallerPayloadRoot"
    !insertmacro JustDoAddInstallActivity "旧版安装位置或卸载登记已变更，无法安全启动卸载器。" "The previous installation or its registration changed. Setup cannot safely run its uninstaller."
    SetErrorLevel 2
    Abort "The previous installation target could not be verified."
  ${EndIf}
  !insertmacro InstallerShowCorePhase "同盘切换未成功，正在准备改用旧版卸载程序…" "The file switch did not finish. Preparing to use the previous uninstaller…"
  !insertmacro JustDoLogInstallEvent "phase=payload-upgrade-fallback-start path=$InstallerPayloadRoot"
  !insertmacro InstallerRunPayloadHelper "DiscardStaging" "$InstallerPayloadRoot" ""
  Pop $0
  Pop $1
  !insertmacro InstallerReportPayloadHelper "fallback-discard" $0 $1
  ${If} $0 != 0
    !insertmacro JustDoAddInstallActivity "未能安全清理升级暂存，未启动旧版卸载器：$1" "The previous uninstaller was not started because staging could not be safely cleared: $1"
    SetErrorLevel 2
    Abort "Could not clear the staged files before running the previous uninstaller."
  ${EndIf}
  SetOutPath "$PLUGINSDIR"
  StrCpy $JustDoPayloadLogsAllowed "0"
  Call JustDoSelectInstallLogDirectory
  !insertmacro InstallerReleaseLegacyGuard
  StrCpy $InstallerOldIdentityKind 16
  StrCpy $InstallerOldIdentityPath "$InstallerPayloadRoot"
  Call InstallerReadPreviousIdentity
  StrCpy $InstallerPayloadFallbackDirectoryId "$InstallerOldIdentity"
  StrCpy $InstallerOldIdentityKind 0
  StrCpy $InstallerOldIdentityPath "$InstallerPayloadRoot\${UNINSTALL_FILENAME}"
  Call InstallerReadPreviousIdentity
  StrCpy $InstallerPayloadFallbackUninstallerId "$InstallerOldIdentity"
  ${If} $InstallerPayloadFallbackDirectoryId == ""
  ${OrIf} $InstallerPayloadFallbackUninstallerId == ""
    !insertmacro JustDoLogInstallEvent "phase=payload-upgrade-fallback-blocked reason=unreadable-identity path=$InstallerPayloadRoot"
    !insertmacro JustDoAddInstallActivity "无法确认旧版卸载程序，尚未卸载旧版。" "The identity of the previous uninstaller could not be confirmed. It was not started."
    SetErrorLevel 2
    Abort "The previous uninstaller identity could not be confirmed."
  ${EndIf}
  !insertmacro InstallerUnlockPayloadUpgrade
  StrCpy $InstallerPayloadFallbackRoot "$InstallerPayloadRoot"
  StrCpy $InstallerPayloadRoot ""
  StrCpy $keepShortcuts "false"
  !insertmacro setIsTryToKeepShortcuts
  ${If} $isTryToKeepShortcuts == "true"
    ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" KeepShortcuts
    ${If} $0 == "true"
      StrCpy $keepShortcuts "true"
    ${EndIf}
  ${EndIf}
  Goto InstallerRunConventionalUpgrade
!macroend

!macro InstallerFinishPayloadUpgrade
  ${If} $InstallerPayloadRoot != ""
    ReadRegStr $2 HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayVersion
    ${If} $2 != "${VERSION}"
      !insertmacro JustDoLogInstallEvent "phase=payload-upgrade-registration result=version-mismatch expected=${VERSION} actual=$2"
      !insertmacro JustDoAddInstallActivity "Windows 未记录新版安装信息（应为 ${VERSION}，实际为 $2），将恢复旧版。" "Windows did not record the new installation (expected ${VERSION}, found $2). Setup will restore the previous version."
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
    !insertmacro InstallerReportPayloadHelper "clean" $0 $1
    ${If} $0 != 0
    ${AndIf} $0 != 13
      !insertmacro JustDoAddInstallActivity "无法确认升级已完成（代码 $0）：$1" "Could not confirm the upgrade completed (code $0): $1"
      !insertmacro InstallerRollbackPayloadUpgrade
      SetErrorLevel 2
      Abort "The installed files do not match the registered upgrade."
    ${EndIf}
    ${If} $0 == 13
      !insertmacro JustDoAddInstallActivity "新版安装成功；旧版备份未清理，下次安装时将重试：$1" "The new version is installed. Setup will retry backup cleanup on the next run: $1"
    ${EndIf}
    StrCpy $InstallerPayloadRoot ""
    !insertmacro InstallerUnlockPayloadUpgrade
  ${EndIf}
!macroend

!macro InstallerCheckPayloadRegistration
  ${If} $InstallerPayloadRoot != ""
  ${AndIf} ${Errors}
    !insertmacro JustDoLogInstallEvent "phase=payload-upgrade-registration result=write-failed path=$InstallerPayloadRoot"
    !insertmacro JustDoAddInstallActivity "无法写入 Windows 安装信息，将恢复旧版。请检查当前账户的权限后重试。" "Could not write the Windows installation information. Setup will restore the previous version. Check the current account permissions and retry."
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
    !insertmacro InstallerRunPayloadHelper "Recover" "$InstallerPayloadRoot" ""
    Pop $0
    Pop $1
    !insertmacro InstallerReportPayloadHelper "recovery" $0 $1
    ${If} $0 != 0
      !insertmacro JustDoAddInstallActivity "未能完成恢复，暂存文件已保留（代码 $0）：$1" "Recovery is incomplete. Staged files were preserved (code $0): $1"
    ${EndIf}
    StrCpy $InstallerPayloadRoot ""
    !insertmacro InstallerUnlockPayloadUpgrade
  ${EndIf}
!macroend
!endif
