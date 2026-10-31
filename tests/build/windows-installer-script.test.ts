import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';

const { createWindowsInstallerScript, orderNsisPluginDirectories } = require('../../scripts/packaging/windows-installer-script.cjs');
const templates = path.join(path.dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis');

test('stages the shell archive in INSTDIR and removes the default AppData installer copy', () => {
  const script = createWindowsInstallerScript(templates);
  expect(script).not.toContain('copyFile "$EXEPATH" "$LOCALAPPDATA');
  expect(script).not.toContain('$PLUGINSDIR\\app-');
  expect(script).not.toContain('$PLUGINSDIR\\7z-out');
  expect(script).toContain('$INSTDIR\\.justdo-app-$JustDoInstallerSessionId-64.');
  expect(script).not.toContain('Nsis7z::Extract "${FILE}"');
  expect(script).toContain('shell-extraction-complete exit=$R2');
  expect(script).toContain('win/ia32/7za.exe'.replaceAll('/', path.sep));
  expect(script).toContain('Call InstallerExtractShell');
  expect(script).toContain('StrCpy $R2 "$InstallerShellExitCode"');
  expect(script).not.toContain('JUSTDO_SHELL_7ZA');
  expect(script).not.toContain('JUSTDO_SHELL_RESOURCE_LOG');
  expect(script).not.toContain('-bsp0');
  expect(script).not.toContain('/TIMEOUT=');
  expect(script).toContain('Delete "${FILE}"');
  expect(script).toContain('uninstallOldVersion SHELL_CONTEXT');
  expect(script).toContain('addStartMenuLink $keepShortcuts');
  expect(script).toContain('registerFileAssociations');
});

test('registers downloaded NSIS plugins before includes that expand UAC functions', () => {
  const ordered = orderNsisPluginDirectories('!include "custom.nsh"\n!addplugindir /x86-unicode "plugins"\n!include "messages.nsh"');
  expect(ordered.split('\n')).toEqual([
    '!addplugindir /x86-unicode "plugins"',
    '!include "custom.nsh"',
    '!include "messages.nsh"',
  ]);
});

test('logs each previous-version removal before invoking the uninstaller', () => {
  const script = createWindowsInstallerScript(templates);
  for (const root of ['SHELL_CONTEXT', 'HKEY_CURRENT_USER']) {
    expect(script).toContain([
      `!insertmacro JustDoLogInstallEvent "phase=previous-installation-removal-start root=${root}"`,
      `!insertmacro uninstallOldVersion ${root}`,
    ].join('\n'));
  }
});

test('rejects an upstream previous-version removal seam change', () => {
  const originalRead = fs.readFileSync;
  const reader = vi.spyOn(fs, 'readFileSync').mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
    const contents = originalRead(...args);
    if (String(args[0]) !== path.join(templates, 'installSection.nsh')) return contents;
    return String(contents).replace('!insertmacro uninstallOldVersion SHELL_CONTEXT', '; changed upstream removal');
  });
  try {
    expect(() => createWindowsInstallerScript(templates)).toThrow('NSIS previous-version removal seam changed');
  } finally {
    reader.mockRestore();
  }
});

test('combines the assisted scope and directory pages while retaining path normalization', () => {
  const script = createWindowsInstallerScript(templates);
  expect(script).not.toContain('!include "assistedInstaller.nsh"');
  expect(script).not.toContain('!insertmacro MUI_PAGE_DIRECTORY');
  expect(script).not.toContain('InstallerDirectoryShow');
  expect(script).toContain('Function instFilesPre');
  expect(script).toContain('StrCpy $INSTDIR "$INSTDIR\\${APP_FILENAME}"');
  expect(script).toContain('!insertmacro InstallerSetupPage');
});

test('keeps the uninstaller mode page and registers setup for either assisted install mode', () => {
  const script = createWindowsInstallerScript(templates).replaceAll('\r\n', '\n');
  expect(script.match(/^    !insertmacro PAGE_INSTALL_MODE$/gm)).toHaveLength(1);
  expect(script.match(/!insertmacro InstallerSetupPage/g)).toHaveLength(1);
  expect(script).toContain('!ifdef BUILD_UNINSTALLER\n    !include multiUserUi.nsh\n  !endif');
  expect(script).toContain([
    '  !include "${PROJECT_DIR}\\scripts\\packaging\\nsis-setup-presentation.nsh"',
    '  !insertmacro InstallerSetupPage',
  ].join('\n'));
  const uninstaller = script.slice(script.indexOf('!else\n  !ifndef removeDefaultUninstallWelcomePage'));
  expect(uninstaller).toContain('!insertmacro PAGE_INSTALL_MODE');
  expect(uninstaller).not.toContain('InstallerSetupPage');
  expect(script).toContain('!insertmacro customPageAfterChangeDir');
});

test.each(['missing', 'duplicate'] as const)('rejects a %s installer mode-page seam without binding the uninstaller', change => {
  const originalRead = fs.readFileSync;
  const nativeModePage = /    !insertmacro PAGE_INSTALL_MODE(?=\r?\n  !endif\r?\n\r?\n  !ifdef allowToChangeInstallationDirectory)/;
  const reader = vi.spyOn(fs, 'readFileSync').mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
    const contents = originalRead(...args);
    const [filename] = args;
    if (String(filename) !== path.join(templates, 'assistedInstaller.nsh')) return contents;
    return String(contents).replace(nativeModePage, match => change === 'missing' ? '' : `${match}\n${match}`);
  });
  try {
    expect(() => createWindowsInstallerScript(templates)).toThrow('NSIS install-mode page seam changed');
  } finally {
    reader.mockRestore();
  }
});

test.each(['missing', 'duplicate'] as const)('rejects a %s upstream directory-page seam', change => {
  const originalRead = fs.readFileSync;
  const nativeDirectoryPage = /    !insertmacro skipPageIfUpdated\r?\n    !insertmacro MUI_PAGE_DIRECTORY/;
  const reader = vi.spyOn(fs, 'readFileSync').mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
    const contents = originalRead(...args);
    const [filename] = args;
    if (String(filename) !== path.join(templates, 'assistedInstaller.nsh')) return contents;
    return String(contents).replace(nativeDirectoryPage, match => change === 'missing' ? '' : `${match}\n${match}`);
  });
  try {
    expect(() => createWindowsInstallerScript(templates)).toThrow('NSIS directory-page seam changed');
  } finally {
    reader.mockRestore();
  }
});

// A cold header preparation renders all offline animation assets before reuse.
test('the real config activates both build seams while keeping native uninstaller generation', async () => {
  require('app-builder-lib');
  const { NsisTarget } = require('app-builder-lib/out/targets/nsis/NsisTarget');
  const originalScript = NsisTarget.prototype.computeFinalScript;
  const originalHeader = NsisTarget.prototype.computeCommonInstallerScriptHeader;
  const clockAssets = require('../../scripts/packaging/installer-clock-assets.cjs');
  const clockPath = path.join(__dirname, '../../build/clock-$fixture.dll');
  const prepareClock = vi.spyOn(clockAssets, 'prepareInstallerClockAssets').mockReturnValue({ path: clockPath });
  try {
    NsisTarget.prototype.computeFinalScript = vi.fn(async (source: string) => source);
    NsisTarget.prototype.computeCommonInstallerScriptHeader = vi.fn(async () =>
      '!include "custom.nsh"\n!addplugindir /x86-unicode "plugins"',
    );
    const config = require('../../electron-builder.config.cjs');
    expect(config.nsis.script).toBeUndefined();
    const target = { packager: { projectDir: path.resolve(__dirname, '../..') }, isPortable: false };
    const source = await NsisTarget.prototype.computeFinalScript.call(target, 'upstream', false, new Map());
    expect(source).toContain('$INSTDIR\\.justdo-app-$JustDoInstallerSessionId-64.');
    expect(source).not.toContain('!define INSTALLER_ANIMATION_DIR');
    const header = await NsisTarget.prototype.computeCommonInstallerScriptHeader.call(target);
    expect(header.startsWith('!addplugindir')).toBe(true);
    expect(header.indexOf('!define INSTALLER_ANIMATION_DIR')).toBeLessThan(header.indexOf('!include "custom.nsh"'));
    expect(header.indexOf('!define INSTALLER_CLOCK_LIBRARY')).toBeLessThan(header.indexOf('!include "custom.nsh"'));
    expect(header).toContain('clock-$$fixture.dll');
    expect(prepareClock).toHaveBeenCalledExactlyOnceWith(target.packager.projectDir);
    const unrelated = { packager: { projectDir: path.resolve(__dirname, '../../../unrelated') }, isPortable: false };
    expect(await NsisTarget.prototype.computeFinalScript.call(unrelated, 'upstream', true, new Map())).toBe('upstream');
    const portable = { ...target, isPortable: true };
    expect(await NsisTarget.prototype.computeCommonInstallerScriptHeader.call(portable)).not.toContain('INSTALLER_CLOCK_LIBRARY');
    expect(prepareClock).toHaveBeenCalledTimes(1);
  } finally {
    NsisTarget.prototype.computeFinalScript = originalScript;
    NsisTarget.prototype.computeCommonInstallerScriptHeader = originalHeader;
    prepareClock.mockRestore();
  }
}, 60_000);
