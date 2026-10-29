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
  StrCpy $InstallerShellExecutable "$R4"
  StrCpy $InstallerShellArchive "\${FILE}"
  StrCpy $InstallerShellLog "$R3"
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
  const assisted = read('assistedInstaller.nsh');
  // The same mode macro also appears in the uninstaller. Bind only its install
  // site before the directory page and require both original sites to remain.
  const installModePage = /    !insertmacro PAGE_INSTALL_MODE(?=\r?\n  !endif\r?\n\r?\n  !ifdef allowToChangeInstallationDirectory)/g;
  if (Array.from(assisted.matchAll(installModePage)).length !== 1
      || (assisted.match(/^    !insertmacro PAGE_INSTALL_MODE\r?$/gm) || []).length !== 2) {
    throw new Error('The upstream NSIS install-mode page seam changed; review the template.');
  }
  const assistedWithModePresentation = assisted.replace(installModePage, [
    '    !define MUI_PAGE_CUSTOMFUNCTION_SHOW InstallerSetupModeShow',
    '    !define MUI_PAGE_CUSTOMFUNCTION_LEAVE InstallerSetupLeave',
    '    !insertmacro PAGE_INSTALL_MODE',
    '    !ifdef MUI_PAGE_CUSTOMFUNCTION_SHOW',
    '      !error "The upstream NSIS install-mode page did not consume its SHOW callback."',
    '    !endif',
    '    !ifdef MUI_PAGE_CUSTOMFUNCTION_LEAVE',
    '      !error "The upstream NSIS install-mode page did not consume its LEAVE callback."',
    '    !endif',
  ].join('\n'));
  const directoryPage = /    !insertmacro skipPageIfUpdated\r?\n    !insertmacro MUI_PAGE_DIRECTORY/g;
  if (Array.from(assisted.matchAll(directoryPage)).length !== 1) {
    throw new Error('The upstream NSIS directory-page seam changed; review the template.');
  }
  const assistedWithDirectoryLock = assistedWithModePresentation.replace(directoryPage, [
    '    !define MUI_PAGE_CUSTOMFUNCTION_PRE InstallerDirectoryPre',
    '    !define MUI_PAGE_CUSTOMFUNCTION_SHOW InstallerDirectoryShow',
    '    !define MUI_PAGE_CUSTOMFUNCTION_LEAVE InstallerSetupLeave',
    '    !insertmacro MUI_PAGE_DIRECTORY',
  ].join('\n'));
  const installer = read('installer.nsi');
  const assistedInclude = '!include "assistedInstaller.nsh"';
  if (installer.split(assistedInclude).length !== 2) {
    throw new Error('The upstream NSIS assisted-installer seam changed; review the template.');
  }
  return installer
    .replace(assistedInclude, () => assistedWithDirectoryLock)
    .replace('!include "installSection.nsh"', section);
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
    // electron-builder prepends this header to both compiler passes. Custom
    // includes already consume animation constants here, before the final body.
    const { prepareInstallerAnimationScript } = require('./installer-animation-script.cjs');
    const { prepareInstallerClockAssets } = require('./installer-clock-assets.cjs');
    const definitions = this.isPortable ? '' : prepareInstallerAnimationScript(projectDir)
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
};
