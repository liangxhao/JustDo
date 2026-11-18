import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const build = path.resolve(__dirname, '../../build');
const helper = path.resolve(__dirname, '../../scripts/packaging/nsis-payload-upgrade.ps1');
const oldVersion = '2026.11.5';
const newVersion = '2026.11.19';
const executable = 'Fixture.exe';
const uninstaller = 'Uninstall Fixture.exe';
const marker = 'resources/.justdo-nsis-installed';
const entries = [executable, uninstaller, 'resources'];
const project = path.resolve(__dirname, '../..');
const nsisCache = path.join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache', 'nsis');
const makensis = path.join(nsisCache, 'nsis-3.0.4.1', 'makensis.exe');

describe.runIf(process.platform === 'win32')('same-volume upgrade staging', () => {
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows',
    'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let fixture: string;
  let root: string;
  let work: string;
  let incoming: string;
  let backup: string;

  function makePayload(directory: string, version: string) {
    mkdirSync(path.join(directory, 'resources'), { recursive: true });
    writeFileSync(path.join(directory, executable), version);
    writeFileSync(path.join(directory, uninstaller), version);
    writeFileSync(path.join(directory, marker), version);
  }

  function invoke(action: string, expected = 0, registeredVersion = oldVersion) {
    const result = spawnSync(powershell, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
      '-Action', action, '-InstallRoot', root, '-Application', executable,
      '-Uninstaller', uninstaller, '-Authentication', 'name:', '-RegisteredVersion', 'v' + registeredVersion,
    ], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
    expect(result.status, result.error?.message ?? result.stdout + result.stderr).toBe(expected);
  }

  beforeEach(() => {
    mkdirSync(build, { recursive: true });
    fixture = mkdtempSync(path.join(build, 'payload-upgrade-'));
    root = path.join(fixture, '安装目录 [空格]');
    work = path.join(root, '.upgrade');
    incoming = path.join(work, 'new');
    backup = path.join(work, 'old');
    makePayload(root, oldVersion);
  });

  afterEach(() => {
    expect(path.dirname(realpathSync(fixture))).toBe(realpathSync(build));
    rmSync(fixture, { recursive: true, force: true });
  });

  it('promotes the staged directories by rename and removes the backup without following a junction', () => {
    const external = path.join(fixture, 'external');
    mkdirSync(external);
    const sentinel = path.join(external, 'keep.txt');
    writeFileSync(sentinel, 'keep');
    const oldJunction = path.join(root, 'resources', 'junction');
    symlinkSync(external, oldJunction, 'junction');
    // Exercise the extended-length path used when cleanup walks runtimes.
    const deep = path.join(root, 'resources', 'nested'.repeat(20), 'module'.repeat(20));
    mkdirSync(deep, { recursive: true });
    writeFileSync(path.join(deep, 'module.js'), 'old runtime');
    const oldIdentity = statSync(path.join(root, 'resources'), { bigint: true }).ino;
    mkdirSync(path.join(root, 'logs'));
    writeFileSync(path.join(root, 'logs', 'keep.log'), 'logs');

    invoke('Prepare');
    makePayload(incoming, newVersion);
    expect(readFileSync(path.join(root, executable), 'utf8')).toBe(oldVersion);
    const newIdentity = statSync(path.join(incoming, 'resources'), { bigint: true }).ino;
    expect(newIdentity).not.toBe(oldIdentity);
    invoke('Publish');

    expect(statSync(path.join(root, 'resources'), { bigint: true }).ino).toBe(newIdentity);
    expect(statSync(path.join(backup, 'resources'), { bigint: true }).ino).toBe(oldIdentity);
    expect(readFileSync(path.join(root, executable), 'utf8')).toBe(newVersion);
    expect(readFileSync(path.join(backup, executable), 'utf8')).toBe(oldVersion);
    invoke('Clean', 0, newVersion);
    expect(existsSync(work)).toBe(false);
    expect(readFileSync(sentinel, 'utf8')).toBe('keep');
    expect(readFileSync(path.join(root, 'logs', 'keep.log'), 'utf8')).toBe('logs');
  }, 30_000);

  it('recovers both an incomplete extraction and an interrupted file switch', () => {
    invoke('Prepare');
    writeFileSync(path.join(incoming, executable), 'partial');
    invoke('Recover');
    expect(readFileSync(path.join(root, executable), 'utf8')).toBe(oldVersion);
    expect(existsSync(work)).toBe(false);

    invoke('Prepare');
    makePayload(incoming, newVersion);
    invoke('Publish');
    invoke('Clean', 11);
    expect(readFileSync(path.join(backup, executable), 'utf8')).toBe(oldVersion);
    invoke('Recover');
    expect(readFileSync(path.join(root, marker), 'utf8')).toBe(oldVersion);
    expect(existsSync(work)).toBe(false);

    invoke('Prepare');
    makePayload(incoming, newVersion);
    for (const item of entries) renameSync(path.join(root, item), path.join(backup, item));
    writeFileSync(path.join(work, 'plan'), JSON.stringify(entries.map(name => ({
      name, id: String(statSync(path.join(incoming, name), { bigint: true }).ino),
    }))));
    writeFileSync(path.join(work, 'switching'), '');
    // Interrupted after promoting resources but before the executable.
    renameSync(path.join(incoming, 'resources'), path.join(root, 'resources'));
    invoke('Recover');
    expect(readFileSync(path.join(root, marker), 'utf8')).toBe(oldVersion);
    expect(readFileSync(path.join(root, executable), 'utf8')).toBe(oldVersion);
    expect(existsSync(work)).toBe(false);
  }, 30_000);

  it('leaves unknown files alone and preserves an interrupted backup when restoration would overwrite a file', () => {
    const unknown = path.join(root, 'notes.txt');
    writeFileSync(unknown, 'notes');
    invoke('Prepare', 2);
    expect(readFileSync(unknown, 'utf8')).toBe('notes');
    expect(existsSync(work)).toBe(false);

    rmSync(unknown);
    invoke('Prepare');
    renameSync(path.join(root, executable), path.join(backup, executable));
    writeFileSync(path.join(root, executable), 'collision');
    invoke('Recover', 2);
    expect(readFileSync(path.join(root, executable), 'utf8')).toBe('collision');
    expect(readFileSync(path.join(backup, executable), 'utf8')).toBe(oldVersion);
  }, 30_000);

  it.runIf(existsSync(makensis))('stages and switches through the compiled NSIS bridge', () => {
    const guid = path.basename(fixture);
    const key = 'Software\\InstallerPayloadFixture\\' + guid;
    const setup = path.join(fixture, 'fixture.exe');
    const script = path.join(fixture, 'fixture.nsi');
    const payload = path.join(fixture, 'fixture-new');
    makePayload(payload, newVersion);
    const source = [
      'Unicode true', 'RequestExecutionLevel user', 'SilentInstall silent',
      'Name "Payload fixture"', 'OutFile "' + setup + '"',
      '!include "LogicLib.nsh"',
      ...Object.entries({
        PROJECT_DIR: project, APP_GUID: guid, VERSION: newVersion,
        PRODUCT_FILENAME: 'Fixture', UNINSTALL_FILENAME: uninstaller,
        INSTALL_REGISTRY_KEY: key + '\\Install', UNINSTALL_REGISTRY_KEY: key + '\\Uninstall',
        BROWSER_AUTHENTICATION_EXECUTABLE: '',
      }).map(([name, value]) => '!define ' + name + ' "' + value + '"'),
      "!define UAC_IsAdmin '0 == 1'",
      ...['installMode', 'InstallerPayloadRoot', 'keepShortcuts', 'oldDesktopLink', 'newDesktopLink',
        'oldStartMenuLink', 'newStartMenuLink', 'InstallerLookupMode', 'InstallerLookupState',
        'InstallerLookupDirectory', 'InstallerLookupUninstallDirectory'].map(name => 'Var ' + name),
      '!include "' + path.join(project, 'scripts/packaging/nsis-payload-upgrade.nsh') + '"',
      '!macro InstallerShowCorePhase ZH EN', '!macroend',
      '!macro JustDoLogInstallEvent TEXT', '!macroend',
      '!macro JustDoAddInstallActivity ZH EN', '!macroend',
      '!macro FindJustDoProcesses TARGET', 'StrCpy ${TARGET} 1', '!macroend',
      'Function InstallerResolveRegisteredDirectory',
      'StrCpy $InstallerLookupState confirmed',
      'StrCpy $InstallerLookupDirectory "$INSTDIR"',
      'StrCpy $InstallerLookupUninstallDirectory "$INSTDIR"',
      'FunctionEnd',
      'Section',
      'SetRegView 64',
      'StrCpy $installMode CurrentUser',
      'StrCpy $INSTDIR "' + root + '"',
      'WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"',
      'WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayVersion "' + oldVersion + '"',
      'WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString \'$\\"$INSTDIR\\' + uninstaller + '$\\" /currentuser\'',
      '!insertmacro InstallerPreparePayloadUpgrade',
      'StrCmp $INSTDIR "$InstallerPayloadRoot\\.upgrade\\new" +2',
      'Abort "The files were not staged."',
      'SetOutPath "$INSTDIR"',
      'File /r "' + payload + '\\*"',
      '!insertmacro InstallerPublishPayloadUpgrade',
      'ClearErrors',
      'WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"',
      'WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayVersion "${VERSION}"',
      '!insertmacro InstallerCheckPayloadRegistration',
      '!insertmacro InstallerFinishPayloadUpgrade',
      'ReadRegStr $0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation',
      'StrCmp $0 "' + root + '" +2',
      'Abort "The registered installation path changed."',
      'SectionEnd',
    ].join('\n');
    writeFileSync(script, source);
    try {
      const compilation = spawnSync(makensis, ['/V2', '/INPUTCHARSET', 'UTF8', script], {
        encoding: 'utf8', timeout: 20_000, windowsHide: true,
      });
      expect(compilation.status, compilation.stdout + compilation.stderr).toBe(0);
      const installed = spawnSync(setup, [], { encoding: 'utf8', timeout: 25_000, windowsHide: true });
      expect(installed.status, installed.error?.message).toBe(0);
      expect(existsSync(work)).toBe(false);
      expect(readFileSync(path.join(root, executable), 'utf8')).toBe(newVersion);
    } finally {
      spawnSync('reg.exe', ['delete', 'HKCU\\' + key, '/f', '/reg:64'], { windowsHide: true, stdio: 'ignore' });
    }
  }, 35_000);
});
