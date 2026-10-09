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
  expect(script).toContain('nsExec::ExecToStack');
  expect(script).toContain('shell-extraction-complete exit=$R2');
  expect(script).toContain('win/ia32/7za.exe'.replaceAll('/', path.sep));
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

test('the real config activates both build seams while keeping native uninstaller generation', async () => {
  require('app-builder-lib');
  const { NsisTarget } = require('app-builder-lib/out/targets/nsis/NsisTarget');
  const originalScript = NsisTarget.prototype.computeFinalScript;
  const originalHeader = NsisTarget.prototype.computeCommonInstallerScriptHeader;
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
    const header = await NsisTarget.prototype.computeCommonInstallerScriptHeader.call(target);
    expect(header.startsWith('!addplugindir')).toBe(true);
    const unrelated = { packager: { projectDir: path.resolve(__dirname, '../../../unrelated') }, isPortable: false };
    expect(await NsisTarget.prototype.computeFinalScript.call(unrelated, 'upstream', true, new Map())).toBe('upstream');
  } finally {
    NsisTarget.prototype.computeFinalScript = originalScript;
    NsisTarget.prototype.computeCommonInstallerScriptHeader = originalHeader;
  }
});
