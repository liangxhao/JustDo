'use strict';

const fs = require('fs');
const path = require('path');

// Compose upstream templates at build time. Keep the upstream upgrade, shortcut,
// registry and uninstall behavior; change payload staging and cache ownership.
function createWindowsInstallerScript(templatesDir) {
  const read = name => fs.readFileSync(path.join(templatesDir, name), 'utf8');
  const installerFiles = read('include/installer.nsh');
  const cacheCopy = '!insertmacro copyFile "$EXEPATH" "$LOCALAPPDATA\\${APP_INSTALLER_STORE_FILE}"';
  if (installerFiles.split(cacheCopy).length !== 2) {
    throw new Error('The upstream NSIS installer cache seam changed; review the template.');
  }
  let extraction = read('include/extractAppPackage.nsh');
  // The old version has already been removed by this point. Expand the shell
  // directly into INSTDIR instead of making a second full copy in user TEMP.
  extraction = extraction.replaceAll(
    '$PLUGINSDIR\\app-',
    '$INSTDIR\\.justdo-app-$JustDoInstallerSessionId-',
  );
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
  System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_SHELL_7ZA", t "$R4")i.r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_SHELL_ARCHIVE", t "\${FILE}")i.r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_SHELL_OUT", t "$INSTDIR")i.r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_SHELL_LOG", t "$R3")i.r0'
  ; Delayed expansion inserts paths after cmd parses metacharacters. It keeps
  ; spaces, Chinese, %, &, and ! in user-selected directories literal.
  !insertmacro JustDoLogInstallEvent "phase=shell-extraction-start archive=\${FILE} destination=$INSTDIR detail-log=$R3"
  nsExec::ExecToStack '\"$SYSDIR\\cmd.exe\" /D /V:ON /S /C \"$\\\"!JUSTDO_SHELL_7ZA!$\\\" x -y -aoa -bsp0 -sccUTF-8 $\\\"-o!JUSTDO_SHELL_OUT!$\\\" $\\\"!JUSTDO_SHELL_ARCHIVE!$\\\" 1>$\\\"!JUSTDO_SHELL_LOG!$\\\" 2>&1\"'
  Pop $R0
  Pop $R1
  StrCpy $R2 $R0
  !insertmacro JustDoLogInstallEvent "phase=shell-extraction-complete exit=$R2 detail=$R1 detail-log=$R3"
  StrCpy $R5 "unavailable"
  \${If} $JustDoResourceLogPath != ""
    System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_SHELL_RESOURCE_LOG", t "$JustDoResourceLogPath")i.r0'
    nsExec::ExecToStack '\"$SYSDIR\\cmd.exe\" /D /V:ON /S /C \"type $\\\"!JUSTDO_SHELL_LOG!$\\\" >>$\\\"!JUSTDO_SHELL_RESOURCE_LOG!$\\\" 2>nul\"'
    Pop $R5
    Pop $R1
  \${EndIf}
  System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_SHELL_7ZA", t "")i.r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_SHELL_ARCHIVE", t "")i.r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_SHELL_OUT", t "")i.r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_SHELL_LOG", t "")i.r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t "JUSTDO_SHELL_RESOURCE_LOG", t "")i.r0'
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
    .replace('!include "extractAppPackage.nsh"', extraction);
  const section = read('installSection.nsh').replace('!include installer.nsh', files);
  return read('installer.nsi').replace('!include "installSection.nsh"', section);
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
  NsisTarget.prototype.computeFinalScript = function (source, ...args) {
    if (ownsTarget(this) && !this.isPortable) {
      source = createWindowsInstallerScript(templatesDir);
    }
    return original.call(this, source, ...args);
  };
  NsisTarget.prototype.computeCommonInstallerScriptHeader = async function () {
    const header = await originalHeader.call(this);
    if (!ownsTarget(this)) return header;
    // Upstream assembles the header concurrently. Plugin downloads can finish
    // after the custom include, whose uninstaller functions already use UAC.
    // Make plugin registration precede every include regardless of cache timing.
    return orderNsisPluginDirectories(header);
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
};
