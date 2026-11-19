'use strict';

const fs = require('fs');
const path = require('path');
const shutdownPolicy = require('../../src/shared/app/shutdownPolicy.json');
const { getAgentCliCommandName } = require('../../src/shared/integrations/agentCli.ts');
const {
  BROWSER_AUTHENTICATION_EXECUTABLE,
  verifyPackagedBrowserAuthentication,
} = require('./browser-authentication-config.cjs');

function installerShutdownDefinitions() {
  // Cover Main cleanup, its emergency exit observation, and scheduling margin.
  const timeoutMs = shutdownPolicy.startupAbortMs + shutdownPolicy.otherAppCleanupMs
    + shutdownPolicy.nativeShutdownMs + shutdownPolicy.nativeExitMarginMs
    + 3 * shutdownPolicy.forceExitObservationMs + 2 * shutdownPolicy.outerSchedulingMarginMs;
  const attempts = Math.ceil(timeoutMs / 500);
  if (attempts > 1200) throw new Error('Installer process wait exceeds the helper limit.');
  return `!define INSTALLER_SHUTDOWN_ATTEMPTS ${attempts}\n`
    + `!define INSTALLER_PROCESS_WAIT_TIMEOUT ${attempts * 500 + 15000}\n`;
}

// Compose upstream templates at build time, retaining the registered removal
// path for upgrades that cannot switch a verified payload in place.
function createWindowsInstallerScript(templatesDir) {
  const read = name => fs.readFileSync(path.join(templatesDir, name), 'utf8');
  const installerFiles = read('include/installer.nsh');
  const cacheCopy = '!insertmacro copyFile "$EXEPATH" "$LOCALAPPDATA\\${APP_INSTALLER_STORE_FILE}"';
  if (installerFiles.split(cacheCopy).length !== 2) {
    throw new Error('The upstream NSIS installer cache seam changed; review the template.');
  }
  const writeUninstaller = 'File "/oname=${UNINSTALL_FILENAME}" "${UNINSTALLER_OUT_FILE}"';
  if (installerFiles.split(writeUninstaller).length !== 2) {
    throw new Error('The upstream NSIS installed-uninstaller seam changed; review the template.');
  }
  let extraction = read('include/extractAppPackage.nsh');
  // The old version has already been removed by this point. Expand the shell
  // directly into INSTDIR instead of making a second full copy in user TEMP.
  extraction = extraction.replaceAll(
    '$PLUGINSDIR\\app-',
    '$INSTDIR\\.justdo-app-$JustDoInstallerSessionId-',
  );
  const stageArchive = '!insertmacro compute_files_for_current_arch';
  const extractArchive = '!insertmacro decompress';
  const stageSidecars = '!insertmacro custom_files_post_decompression';
  if ([stageArchive, extractArchive, stageSidecars].some(seam => extraction.split(seam).length !== 2)) {
    throw new Error('The upstream NSIS archive staging seam changed; review the template.');
  }
  extraction = extraction
    .replace(stageArchive, [
      '!insertmacro InstallerShowCorePhase "正在向安装目录写入应用压缩包…" "Writing the application archive to the install folder…"',
      '!insertmacro JustDoLogInstallEvent "phase=shell-archive-stage-start arch=$packageArch destination=$INSTDIR"',
      stageArchive,
      '!insertmacro InstallerLogArchiveStageResult "shell-archive"',
    ].join('\n  '))
    .replace(extractArchive, [
      '!insertmacro InstallerShowCorePhase "正在准备应用解压工具…" "Preparing the application extractor…"',
      extractArchive,
    ].join('\n  '))
    .replace(stageSidecars, [
      '!insertmacro InstallerShowCorePhase "正在写入离线运行时压缩包…" "Writing the offline runtime archive…"',
      '!insertmacro JustDoLogInstallEvent "phase=runtime-archive-stage-start destination=$INSTDIR"',
      '!ifdef COMPRESS',
      '  SetCompress off',
      '!endif',
      stageSidecars,
      '!ifdef COMPRESS',
      '  SetCompress "${COMPRESS}"',
      '!endif',
      '!insertmacro InstallerLogArchiveStageResult "runtime-archive"',
    ].join('\n  '));
  const extractStart = extraction.indexOf('!macro extractUsing7za FILE');
  if (extractStart < 0) throw new Error('The upstream NSIS extraction seam changed.');
  const shellExtractorPath = path
    .join(path.dirname(require.resolve('7zip-bin/package.json')), 'win/ia32/7za.exe')
    .replaceAll('$', '$$');
  const licensePath = filename =>
    path.join(__dirname, '../../resources/licenses', filename).replaceAll('$', '$$');
  extraction =
    extraction.slice(0, extractStart) +
    `!macro extractUsing7za FILE
  ; Nsis7z does not report failed file writes through the NSIS error flag.
  ; Use the bundled CLI so actual extraction failures have an exit code and
  ; complete output, including errors before Electron can start.
  StrCpy $R3 "$INSTDIR\\.justdo-shell-$JustDoInstallerSessionId.log"
  StrCpy $R4 "$INSTDIR\\.justdo-shell-$JustDoInstallerSessionId-7za.exe"
  ClearErrors
  File /oname=$INSTDIR\\7zip-license.txt "${licensePath('7zip-21.07.txt')}"
  File /oname=$INSTDIR\\7zip-lgpl.txt "${licensePath('7zip-lgpl.txt')}"
  File /oname=$INSTDIR\\.justdo-shell-$JustDoInstallerSessionId-7za.exe "${shellExtractorPath}"
  \${If} \${Errors}
    !insertmacro JustDoLogInstallEvent "phase=shell-extractor-stage-failed path=$R4"
    SetErrorLevel 2
    Abort "Unable to write the application extractor to the installation directory."
  \${EndIf}
  StrCpy $InstallerShellExecutable "$R4"
  StrCpy $InstallerShellArchive "\${FILE}"
  StrCpy $InstallerShellLog "$R3"
  !insertmacro InstallerShowCorePhase "正在解压并写入应用文件…" "Extracting and writing application files…"
  ; The shared native launcher captures both streams and returns immediately.
  ; Poll measured 7-Zip progress while the installation UI remains responsive.
  !insertmacro JustDoLogInstallEvent "phase=shell-extraction-start archive=\${FILE} destination=$INSTDIR detail-log=$R3"
  Call InstallerExtractShell
  StrCpy $R1 "$JustDoExtractorStdioError"
  StrCpy $R2 "$InstallerShellExitCode"
  !insertmacro JustDoLogInstallEvent "phase=shell-extraction-complete exit=$R2 detail=$R1 detail-log=$R3"
  StrCpy $R5 "unavailable"
  \${If} $JustDoExtractorStdioCopied == "1"
    StrCpy $R5 "0"
  \${Else}
    StrCpy $R5 "$JustDoExtractorStdioCopyError"
  \${EndIf}
  !insertmacro InstallerShowCorePhase "正在清理应用解压临时文件…" "Removing temporary application extraction files…"
  Delete "$R4"
  \${If} $R2 != "0"
    !insertmacro JustDoLogInstallEvent "phase=installer-abort reason=shell-extraction-failed exit=$R2 detail-log=$R3"
    MessageBox MB_OK|MB_ICONSTOP "应用文件展开失败（退出码 $R2）。详细日志：$\\r$\\n$R3$\\r$\\n$\\r$\\nApplication extraction failed (exit code $R2). See the detailed log above." /SD IDOK
    SetErrorLevel 2
    Abort "Application extraction failed."
  \${EndIf}
  \${If} $R5 == "0"
    Delete "$R3"
  \${Else}
    !insertmacro JustDoLogInstallEvent "phase=shell-extraction-log-append-failed result=$R5 retained-detail-log=$R3"
  \${EndIf}
  Delete "\${FILE}"
!macroend
`;
  const files = installerFiles
    .replace(cacheCopy, '; Installer caching is deferred to the running updater.')
    .replace('!include "extractAppPackage.nsh"', extraction)
    .replace(writeUninstaller, () => [
      '!insertmacro InstallerShowCorePhase "正在写入卸载程序…" "Writing the uninstaller…"',
      writeUninstaller,
    ].join('\n  '));
  const installSection = read('installSection.nsh');
  if (installSection.split('InitPluginsDir').length !== 2) {
    throw new Error('The upstream NSIS install-section entry seam changed; review the template.');
  }
  let section = installSection.replace('!include installer.nsh', files)
    .replace('InitPluginsDir', [
      '; Silent elevation re-applies the upstream mode macro after customInit.',
      '; Restore verified registration before process checks or old-file removal.',
      'Call InstallerRestoreUpgradeDirectory',
      '',
      'InitPluginsDir',
    ].join('\n'));
  const skipInnerProcessCheck = '  ${ifNot} ${UAC_IsInnerInstance}\n    !insertmacro CHECK_APP_RUNNING\n  ${endif}';
  if (section.replaceAll('\r\n', '\n').split(skipInnerProcessCheck).length !== 2) {
    throw new Error('The upstream NSIS install-section process-check seam changed; review the template.');
  }
  section = section.replaceAll('\r\n', '\n').replace(skipInnerProcessCheck, '  !insertmacro CHECK_APP_RUNNING');
  for (const root of ['SHELL_CONTEXT', 'HKEY_CURRENT_USER']) {
    const removal = `!insertmacro uninstallOldVersion ${root}`;
    const result = `!insertmacro handleUninstallResult ${root}`;
    if (section.split(removal).length !== 2 || section.split(result).length !== 2) {
      throw new Error('The upstream NSIS previous-version removal seam changed; review the template.');
    }
    section = section.replace(removal, [
      ...(root === 'SHELL_CONTEXT' ? [
        '!insertmacro InstallerRequireSandboxTarget "$JustDoCurrentUserAppData" "$JustDoCurrentUserLocalAppData"',
      ] : []),
      '!insertmacro InstallerShowCorePhase "正在核对旧版安装位置…" "Checking the previous installation location…"',
      `!insertmacro JustDoLogInstallEvent "phase=previous-installation-removal-start root=${root}"`,
      removal,
    ].join('\n')).replace(result, [
      result,
      `!insertmacro JustDoLogInstallEvent "phase=previous-installation-removal-returned root=${root}"`,
    ].join('\n'));
  }
  const previousScopeStart = '!insertmacro InstallerShowCorePhase "正在核对旧版安装位置…" "Checking the previous installation location…"';
  const previousScopeEnd = '!insertmacro JustDoLogInstallEvent "phase=previous-installation-removal-returned root=SHELL_CONTEXT"';
  section = section.replace(previousScopeStart, [
    '!insertmacro InstallerPreparePayloadUpgrade',
    '\x24{if} $InstallerPayloadRoot == ""',
    '!insertmacro InstallerClearStagingBeforeWrite "$INSTDIR"',
    '\x24{if} $installMode == "all"',
    '  StrCpy $InstallerLookupMode "CurrentUser"',
    '  Call InstallerResolveRegisteredDirectory',
    '  \x24{if} $InstallerLookupUninstallDirectory != ""',
    '    !insertmacro InstallerClearStagingBeforeWrite "$InstallerLookupUninstallDirectory"',
    '    !insertmacro InstallerCheckLegacyPayloadRemoval "$InstallerLookupUninstallDirectory"',
    '  \x24{elseif} $InstallerLookupState == "unknown"',
    '  \x24{orif} $InstallerLookupState == "conflict"',
    '    !insertmacro JustDoLogInstallEvent "phase=previous-installation-target-unconfirmed root=HKEY_CURRENT_USER result=$InstallerLookupState"',
    '    !insertmacro JustDoAddInstallActivity "无法确认当前用户旧版的安装位置，尚未卸载旧版。" "Could not confirm the previous current-user installation. No uninstaller was started."',
    '    SetErrorLevel 2',
    '    Abort "The previous current-user installation could not be confirmed."',
    '  \x24{endif}',
    '\x24{endif}',
    previousScopeStart,
  ].join('\n')).replace(previousScopeEnd, [previousScopeEnd, '\x24{endif}'].join('\n'));
  const installFiles = '\n!insertmacro installApplicationFiles';
  const register = '!insertmacro registryAddInstallInfo';
  const customInstall = [
    '!ifmacrodef customInstall',
    '  !insertmacro customInstall',
    '!endif',
  ].join('\n');
  if ([installFiles, register, customInstall].some(seam => section.split(seam).length !== 2)) {
    throw new Error('The upstream NSIS application file or validation seam changed; review the template.');
  }
  section = section.replace(customInstall, [
    '!insertmacro InstallerFinishPayloadUpgrade',
    '!insertmacro InstallerCompleteInstall',
  ].join('\n')).replace(installFiles, [
    '',
    '!insertmacro installApplicationFiles',
    '!insertmacro InstallerWriteBrowserAuthenticationAlias',
    customInstall,
    '!insertmacro InstallerPublishPayloadUpgrade',
    '!insertmacro InstallerShowCorePhase "正在注册应用并创建快捷方式…" "Registering the application and creating shortcuts…"',
    '!insertmacro JustDoLogInstallEvent "phase=application-registration-start"',
  ].join('\n')).replace(register, [
    'ClearErrors',
    register,
    '!insertmacro InstallerCheckPayloadRegistration',
  ].join('\n'));
  const assistedSource = read('assistedInstaller.nsh');
  const nativeModeUi = '!include multiUserUi.nsh';
  if (assistedSource.split(nativeModeUi).length !== 2) {
    throw new Error('The upstream NSIS native mode UI include seam changed; review the template.');
  }
  const assisted = assistedSource.replace(nativeModeUi, [
    '!ifdef BUILD_UNINSTALLER',
    '    !include multiUserUi.nsh',
    '  !endif',
  ].join('\n'));
  // The assisted installer has one combined scope/location page. Keep the
  // uninstaller's independent mode page and require both upstream sites.
  const installModePage = /  !ifndef INSTALL_MODE_PER_ALL_USERS\r?\n    !insertmacro PAGE_INSTALL_MODE\r?\n  !endif(?=\r?\n\r?\n  !ifdef allowToChangeInstallationDirectory)/g;
  if (Array.from(assisted.matchAll(installModePage)).length !== 1
      || (assisted.match(/^    !insertmacro PAGE_INSTALL_MODE\r?$/gm) || []).length !== 2) {
    throw new Error('The upstream NSIS install-mode page seam changed; review the template.');
  }
  const assistedWithModePresentation = assisted.replace(installModePage, [
    '  !include "${PROJECT_DIR}\\scripts\\packaging\\nsis-setup-presentation.nsh"',
    '  !insertmacro InstallerSetupPage',
  ].join('\n'));
  const directoryPage = /    !insertmacro skipPageIfUpdated\r?\n    !insertmacro MUI_PAGE_DIRECTORY/g;
  if (Array.from(assisted.matchAll(directoryPage)).length !== 1) {
    throw new Error('The upstream NSIS directory-page seam changed; review the template.');
  }
  const assistedWithDirectoryLock = assistedWithModePresentation.replace(directoryPage, [
    '    ; Directory selection belongs to the combined setup page.',
  ].join('\n'));
  const installer = read('installer.nsi');
  const assistedInclude = '!include "assistedInstaller.nsh"';
  if (installer.split(assistedInclude).length !== 2) {
    throw new Error('The upstream NSIS assisted-installer seam changed; review the template.');
  }
  const installUtil = read('include/installUtil.nsh').replaceAll('\r\n', '\n');
  const previousDirectory = [
    '  !insertmacro readReg $installationDir "$rootKey" "${INSTALL_REGISTRY_KEY}" InstallLocation',
    '  ${if} $installationDir == ""',
    '  ${andIf} $uninstallerFileName != ""',
    '    # https://github.com/electron-userland/electron-builder/issues/735#issuecomment-246918567',
    '    Push $uninstallerFileName',
    '    Call GetFileParent',
    '    Pop $installationDir',
    '  ${endif}',
  ].join('\n');
  if (installUtil.split(previousDirectory).length !== 2 ||
      installer.split('!include "installUtil.nsh"').length !== 2) {
    throw new Error('The upstream NSIS previous-installation directory seam changed; review the template.');
  }
  const unusedParentFunction = /^Function GetFileParent\n[\s\S]*?^FunctionEnd$/gm;
  if (Array.from(installUtil.matchAll(unusedParentFunction)).length !== 1) {
    throw new Error('The upstream NSIS previous-installation path helper changed; review the template.');
  }
  const previousUninstallRetry = /^  StrCpy \$uninstallerFileNameTemp "\$PLUGINSDIR\\old-uninstaller\.exe"\n  !insertmacro copyFile "\$uninstallerFileName" "\$uninstallerFileNameTemp"\n\n  # Retry counter\n[\s\S]*?^  DoesNotExist:\n    SetErrors(?=\nFunctionEnd)/gm;
  if (Array.from(installUtil.matchAll(previousUninstallRetry)).length !== 1) {
    throw new Error('The upstream NSIS previous-uninstaller execution seam changed; review the template.');
  }
  const previousUninstallLookup = /^  Push 0\n  Pop \$R0\n\n(?=  !insertmacro readReg \$uninstallString)/gm;
  const missingUninstaller = /^    !endif\n    \x24\{if\} \$uninstallString == ""\n      ClearErrors\n      Return\n    \x24\{endif\}/gm;
  if ([previousUninstallLookup, missingUninstaller].some(seam => Array.from(installUtil.matchAll(seam)).length !== 1)) {
    throw new Error('The upstream NSIS previous-uninstaller lookup seam changed; review the template.');
  }
  const verifiedInstallUtil = installUtil.replace(missingUninstaller, match => match.replace('      ClearErrors', [
    '      ${if} $InstallerOldAttempt == 2',
    '        Goto InstallerPreviousUninstallTargetChanged',
    '      ${endif}',
    '      ClearErrors',
  ].join('\n'))).replace(previousDirectory, [
    '  ; Scope, upgrade target and the uninstaller share the same evidence.',
    '  StrCpy $InstallerLookupMode "$installMode"',
    '  ${if} $rootKey == "HKEY_CURRENT_USER"',
    '    StrCpy $InstallerLookupMode "CurrentUser"',
    '  ${elseif} $rootKey == "HKEY_LOCAL_MACHINE"',
    '    StrCpy $InstallerLookupMode "all"',
    '  ${endif}',
    '  Call InstallerResolveRegisteredDirectory',
    '  StrCpy $InstallerOldScope "HKEY_CURRENT_USER"',
    '  StrCpy $InstallerOldRetryAllowed "1"',
    '  ${if} $InstallerLookupMode == "all"',
    '    StrCpy $InstallerOldScope "HKEY_LOCAL_MACHINE"',
    '  ${elseif} $installMode == "all"',
    '    StrCpy $InstallerOldRetryAllowed "0"',
    '  ${endif}',
    '  StrCpy $installationDir "$InstallerLookupUninstallDirectory"',
    '  ${if} $InstallerOldAttempt == 2',
    '    ${if} $installationDir != $InstallerOldDirectory',
    '    ${orIf} $uninstallString != $InstallerOldRegistration',
    '      Goto InstallerPreviousUninstallTargetChanged',
    '    ${endif}',
    '  ${endif}',
    '  ${if} $installationDir == ""',
    '    ${if} $InstallerLookupState == "missing"',
    '      !insertmacro JustDoLogInstallEvent "phase=previous-installation-removal-skipped root=$rootKey reason=missing-product-files"',
    '      StrCpy $R0 0',
    '      ClearErrors',
    '      Return',
    '    ${endif}',
    '    !insertmacro JustDoLogInstallEvent "phase=previous-installation-target-unconfirmed root=$rootKey result=$InstallerLookupState"',
    '    SetErrors',
    '    Return',
    '  ${endif}',
    '  ; Never execute an unpaired path from the earlier registry read.',
    '  StrCpy $uninstallerFileName "$installationDir\\${UNINSTALL_FILENAME}"',
    '  !insertmacro InstallerClearStagingBeforeWrite "$installationDir"',
    '  ; Released uninstallers run initMultiUser and read InstallLocation again.',
    '  ; Keep that same scope registration consistent before starting old code.',
    '  ClearErrors',
    '  ${if} $InstallerLookupMode == "all"',
    '    ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation',
    '  ${else}',
    '    ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation',
    '  ${endif}',
    '  StrCpy $2 "1"',
    '  !insertmacro InstallerLookupAbsolutePath "$0" $1',
    '  ${if} $1 == "1"',
    '    GetFullPathName $0 "$0\\."',
    '    GetFullPathName $1 "$installationDir\\."',
    '    ${if} $0 != ""',
    '    ${andIf} $1 != ""',
    '    ${andIf} $0 == $1',
    '      StrCpy $2 "0"',
    '    ${endif}',
    '  ${endif}',
    '  ${if} $2 == "1"',
    '    ${if} $InstallerOldAttempt == 2',
    '      Goto InstallerPreviousUninstallTargetChanged',
    '    ${endif}',
    '    ClearErrors',
    '    ${if} $InstallerLookupMode == "all"',
    '      WriteRegStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "$installationDir"',
    '    ${else}',
    '      WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$installationDir"',
    '    ${endif}',
    '    IfErrors InstallerPreviousLocationCorrectionFailed',
    '    ${if} $InstallerLookupMode == "all"',
    '      ReadRegStr $0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation',
    '    ${else}',
    '      ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation',
    '    ${endif}',
    '    IfErrors InstallerPreviousLocationCorrectionFailed',
    '    ${if} $0 != $installationDir',
    '      Goto InstallerPreviousLocationCorrectionFailed',
    '    ${endif}',
    '    !insertmacro JustDoLogInstallEvent "phase=previous-installation-location-corrected root=$rootKey directory=$installationDir"',
    '    Goto InstallerPreviousLocationCorrectionDone',
    '    InstallerPreviousLocationCorrectionFailed:',
    '    !insertmacro JustDoLogInstallEvent "phase=previous-installation-target-unconfirmed root=$rootKey reason=registration-correction-failed"',
    '    SetErrors',
    '    Return',
    '    InstallerPreviousLocationCorrectionDone:',
    '  ${endif}',
    '  ClearErrors',
  ].join('\n')).replace(unusedParentFunction, '').replace(previousUninstallLookup, [
    '  StrCpy $InstallerOldAttempt "1"',
    '  StrCpy $InstallerOldKeepIdentityOpen "0"',
    '  InstallerPreviousUninstallResolve:',
    '  StrCpy $R0 0',
    '',
    '',
  ].join('\n')).replace(previousUninstallRetry, [
    '  StrCpy $InstallerOldIdentityKind 16',
    '  StrCpy $InstallerOldIdentityPath "$installationDir"',
    '  Call InstallerReadPreviousIdentity',
    '  ${if} $InstallerOldAttempt == 1',
    '    StrCpy $InstallerOldDirectory "$installationDir"',
    '    StrCpy $InstallerOldRegistration "$uninstallString"',
    '    StrCpy $InstallerOldDirectoryIdentity "$InstallerOldIdentity"',
    '  ${elseif} $InstallerOldIdentity != $InstallerOldDirectoryIdentity',
    '    Goto InstallerPreviousUninstallTargetChanged',
    '  ${endif}',
    '  StrCpy $InstallerOldIdentityKind 0',
    '  StrCpy $InstallerOldIdentityPath "$uninstallerFileName"',
    '  ${if} $InstallerOldAttempt == 2',
    '    StrCpy $InstallerOldKeepIdentityOpen "1"',
    '  ${endif}',
    '  Call InstallerReadPreviousIdentity',
    '  ${if} $InstallerOldAttempt == 1',
    '    StrCpy $InstallerOldFileIdentity "$InstallerOldIdentity"',
    '  ${elseif} $InstallerOldIdentity != $InstallerOldFileIdentity',
    '    Goto InstallerPreviousUninstallTargetChanged',
    '  ${endif}',
    '  !insertmacro InstallerCheckLegacyPayloadRemoval "$installationDir"',
    '  StrCpy $InstallerOldArguments "/S /KEEP_APP_DATA $0 _?=$installationDir"',
    '  !insertmacro InstallerShowCorePhase "正在准备并启动旧版卸载程序…" "Preparing and starting the previous uninstaller…"',
    '  StrCpy $uninstallerFileNameTemp "$PLUGINSDIR\\old-$InstallerLookupMode-$InstallerOldAttempt.exe"',
    '  System::Call \'kernel32::CopyFileW(w "$uninstallerFileName", w "$uninstallerFileNameTemp", i 1)i.r1 ?e\'',
    '  Pop $2',
    '  ${if} $InstallerOldIdentityHandle != -1',
    '    System::Call \'kernel32::CloseHandle(p $InstallerOldIdentityHandle)i\'',
    '    StrCpy $InstallerOldIdentityHandle "-1"',
    '  ${endif}',
    '  StrCmp $1 0 InstallerPreviousUninstallCopyFailed',
    '  StrCpy $InstallerOldExecutable "$uninstallerFileNameTemp"',
    '  StrCpy $InstallerOldLaunchMode "copied"',
    '  Call InstallerRunPreviousUninstaller',
    '  StrCmp $InstallerOldResult "not-started" 0 InstallerPreviousUninstallReturned',
    '  !insertmacro JustDoLogInstallEvent "phase=previous-uninstaller-launch-failed root=$rootKey attempt=$InstallerOldAttempt win32=$InstallerOldError fallback=in-place"',
    '  InstallerPreviousUninstallInPlace:',
    '    ${if} $InstallerOldAttempt == 2',
    '      Call InstallerReadPreviousIdentity',
    '      ${if} $InstallerOldIdentity != $InstallerOldFileIdentity',
    '        Goto InstallerPreviousUninstallTargetChanged',
    '      ${endif}',
    '    ${endif}',
    '    StrCpy $InstallerOldExecutable "$uninstallerFileName"',
    '    StrCpy $InstallerOldLaunchMode "in-place"',
    '    Call InstallerRunPreviousUninstaller',
    '  InstallerPreviousUninstallReturned:',
    '    ${if} $InstallerOldResult == "not-started"',
    '      !insertmacro JustDoLogInstallEvent "phase=previous-uninstaller-launch-failed root=$rootKey attempt=$InstallerOldAttempt win32=$InstallerOldError launch=in-place"',
    '    ${endif}',
    '    ${if} $InstallerOldResult == "exited"',
    '    ${andIf} $InstallerOldError == 0',
    '      StrCpy $R0 0',
    '      ClearErrors',
    '      Return',
    '    ${endif}',
    '    Call InstallerAskPreviousRetry',
    '    ${if} $InstallerOldRetry == 1',
    '      StrCpy $InstallerOldAttempt "2"',
    '      Goto InstallerPreviousUninstallResolve',
    '    ${endif}',
    '    ${if} $InstallerOldResult == "exited"',
    '      StrCpy $R0 "$InstallerOldError"',
    '      ClearErrors',
    '      Return',
    '    ${endif}',
    '    SetErrors',
    '    Return',
    '  InstallerPreviousUninstallCopyFailed:',
    '    !insertmacro JustDoLogInstallEvent "phase=previous-uninstaller-copy-failed root=$rootKey attempt=$InstallerOldAttempt win32=$2 fallback=in-place"',
    '    Goto InstallerPreviousUninstallInPlace',
    '  InstallerPreviousUninstallTargetChanged:',
    '    ${if} $InstallerOldIdentityHandle != -1',
    '      System::Call \'kernel32::CloseHandle(p $InstallerOldIdentityHandle)i\'',
    '      StrCpy $InstallerOldIdentityHandle "-1"',
    '    ${endif}',
    '    !insertmacro JustDoLogInstallEvent "phase=previous-uninstaller-retry-refused root=$rootKey reason=target-changed"',
    '    SetErrors',
  ].join('\n'));
  return installer
    .replace(assistedInclude, () => assistedWithDirectoryLock)
    .replace('!include "installSection.nsh"', section)
    .replace('!include "installUtil.nsh"', () => verifiedInstallUtil);
}

function configureWindowsInstallerScript(projectDir) {
  // Initialize the public entry first; deep-importing NsisTarget during a config
  // read otherwise enters app-builder-lib's circular PlatformPackager imports.
  require('app-builder-lib');
  const templatesDir = path.join(
    path.dirname(require.resolve('app-builder-lib/package.json')),
    'templates/nsis',
  );
  const { NsisTarget } = require('app-builder-lib/out/targets/nsis/NsisTarget');
  const original = NsisTarget.prototype.computeFinalScript;
  const originalHeader = NsisTarget.prototype.computeCommonInstallerScriptHeader;
  const normalizePath = value => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const ownsTarget = target =>
    normalizePath(target.packager.projectDir) === normalizePath(projectDir);
  // nsis.script bypasses electron-builder's signed-uninstaller generation.
  // Compose at the final-script seam instead, for this project only, so both
  // normal compiler passes and all upstream signing/update behavior are retained.
  NsisTarget.prototype.computeFinalScript = function (source, isInstaller, archs) {
    if (ownsTarget(this) && !this.isPortable) {
      if (isInstaller) {
        for (const directory of archs.values()) verifyPackagedBrowserAuthentication(directory);
      }
      source = createWindowsInstallerScript(templatesDir);
    }
    return original.call(this, source, isInstaller, archs);
  };
  NsisTarget.prototype.computeCommonInstallerScriptHeader = async function () {
    const header = await originalHeader.call(this);
    if (!ownsTarget(this)) return header;
    // Upstream assembles the header concurrently. Plugin downloads can finish
    // after the custom include, whose uninstaller functions already use UAC.
    // Make plugin registration precede every include regardless of cache timing.
    // electron-builder prepends this header to both compiler passes. Custom
    // includes already consume animation constants here, before the final body.
    const { prepareInstallerAnimationScript } = require('./installer-animation-script.cjs');
    const { prepareInstallerClockAssets } = require('./installer-clock-assets.cjs');
    const authenticationArgument = BROWSER_AUTHENTICATION_EXECUTABLE
      ? `-BrowserAuthenticationExecutable "${BROWSER_AUTHENTICATION_EXECUTABLE}"`
      : '';
    const definitions = this.isPortable ? '' : prepareInstallerAnimationScript(projectDir)
      + installerShutdownDefinitions()
      + `!define AGENT_CLI_EXECUTABLE "${getAgentCliCommandName(this.packager.appInfo.productName)}.exe"\n`
      + `!define BROWSER_AUTHENTICATION_EXECUTABLE "${BROWSER_AUTHENTICATION_EXECUTABLE}"\n`
      + `!define BROWSER_AUTHENTICATION_PROCESS_ARGUMENT '${authenticationArgument}'\n`
      + `!define INSTALLER_CLOCK_LIBRARY "${prepareInstallerClockAssets(projectDir).path.replaceAll('$', () => '$$')}"\n`;
    return orderNsisPluginDirectories(definitions + header);
  };
}

function orderNsisPluginDirectories(header) {
  const lines = header.split(/\r?\n/);
  const plugins = lines.filter(line => line.startsWith('!addplugindir '));
  return [...plugins, ...lines.filter(line => !line.startsWith('!addplugindir '))].join('\n');
}

module.exports = {
  createWindowsInstallerScript,
  configureWindowsInstallerScript,
  orderNsisPluginDirectories,
  installerShutdownDefinitions,
};
