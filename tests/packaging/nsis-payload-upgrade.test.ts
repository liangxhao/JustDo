import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAgentCliCommandName } from '../../src/shared/integrations/agentCli';

const build = path.resolve(__dirname, '../../build');
const helper = path.resolve(__dirname, '../../scripts/packaging/nsis-payload-upgrade.ps1');
const oldVersion = '1.4.2';
const newVersion = '2.0.0';
const productName = 'Wedax';
const executable = productName + '.exe';
const uninstaller = 'Uninstall ' + executable;
const agentCli = getAgentCliCommandName(productName) + '.exe';
const marker = 'resources/.justdo-nsis-installed';
const entries = [executable, uninstaller, 'resources'];
const collision = '扩展 [Extra].dat';
const oldCollision = '扩展 [EXTRA].dat';
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
    writeFileSync(path.join(directory, 'resources', 'app.asar'), version);
  }

  function recordSwitchPlan() {
    const identify = (directory: string, name: string) => ({
      name, id: String(statSync(path.join(directory, name), { bigint: true }).ino),
    });
    writeFileSync(path.join(work, 'plan'), JSON.stringify({
      old: [...entries, oldCollision].map(name => identify(root, name)),
      new: [...entries, collision].map(name => identify(incoming, name)),
    }));
  }

  function helperArguments(action: string, registeredVersion = oldVersion, registryKey?: string, slot = 0) {
    return [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
      '-Action', action, '-InstallRoot', root, '-Application', executable,
      '-Uninstaller', uninstaller, '-AgentCli', agentCli, '-Authentication', 'name:', '-RegisteredVersion', 'v' + registeredVersion,
      '-StagingSlot', String(slot),
      ...(registryKey ? ['-InstallKey', `${registryKey}\\Install`, '-UninstallKey', `${registryKey}\\Uninstall`] : []),
    ];
  }

  function invoke(action: string, expected = 0, registeredVersion = oldVersion, registryKey?: string, slot = 0) {
    const result = spawnSync(powershell, helperArguments(action, registeredVersion, registryKey, slot), {
      encoding: 'utf8', timeout: 20_000, windowsHide: true,
    });
    expect(result.status, result.error?.message ?? result.stdout + result.stderr).toBe(expected);
    return result.stderr;
  }

  async function lockFile(file: string, releaseSignal?: string) {
    const holder = spawn(powershell, ['-NoProfile', '-Command', [
      '$ErrorActionPreference = "Stop"',
      '$stream = [IO.File]::Open($env:FIXTURE_LOCKED_FILE, "Open", "Read", "Read")',
      '[Console]::WriteLine("ready")',
      'if ($env:FIXTURE_RELEASE_SIGNAL) {',
      'while (-not [IO.File]::Exists($env:FIXTURE_RELEASE_SIGNAL)) { Start-Sleep -Milliseconds 50 }',
      '} else { Start-Sleep -Seconds 60 }',
      '$stream.Dispose()',
    ].join('\n')], {
      windowsHide: true,
      env: { ...process.env, FIXTURE_LOCKED_FILE: file, FIXTURE_RELEASE_SIGNAL: releaseSignal ?? '' },
    });
    const exited = new Promise(resolve => holder.once('close', resolve));
    const release = async () => { holder.kill(); await exited; };
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => { clearTimeout(timeout); reject(error); };
        const timeout = setTimeout(() => reject(new Error('File lock was not acquired.')), 5000);
        holder.once('error', onError);
        holder.once('exit', () => onError(new Error('File lock helper exited before becoming ready.')));
        holder.stdout.once('data', () => { clearTimeout(timeout); resolve(); });
      });
      return release;
    } catch (error) {
      await release();
      throw error;
    }
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
    symlinkSync(external, path.join(root, 'logs'), 'junction');
    const unmanaged = path.join(root, 'ffm\u00adpeg.dll');
    writeFileSync(unmanaged, 'notes');
    writeFileSync(path.join(root, 'FFMPEG.DLL'), 'old binary');
    writeFileSync(path.join(root, oldCollision), 'old collision');
    writeFileSync(path.join(root, 'version'), 'obsolete managed file');
    const sharedFile = path.join(external, 'shared.txt');
    writeFileSync(sharedFile, 'shared contents');
    linkSync(sharedFile, path.join(root, 'extra-directory.txt'));
    chmodSync(sharedFile, 0o444);
    const unmanagedJunction = path.join(root, 'shared-files');
    symlinkSync(external, unmanagedJunction, 'junction');

    invoke('Prepare');
    makePayload(incoming, newVersion);
    writeFileSync(path.join(incoming, 'ffmpeg.dll'), 'new binary');
    writeFileSync(path.join(incoming, collision), 'new collision');
    mkdirSync(path.join(incoming, 'extra-directory.txt'));
    expect(readFileSync(path.join(root, executable), 'utf8')).toBe(oldVersion);
    const newIdentity = statSync(path.join(incoming, 'resources'), { bigint: true }).ino;
    expect(newIdentity).not.toBe(oldIdentity);
    invoke('Publish');

    expect(statSync(path.join(root, 'resources'), { bigint: true }).ino).toBe(newIdentity);
    expect(statSync(path.join(backup, 'resources'), { bigint: true }).ino).toBe(oldIdentity);
    expect(readFileSync(path.join(root, executable), 'utf8')).toBe(newVersion);
    expect(readFileSync(path.join(backup, executable), 'utf8')).toBe(oldVersion);
    expect(readFileSync(path.join(backup, oldCollision), 'utf8')).toBe('old collision');
    expect(readFileSync(path.join(root, collision), 'utf8')).toBe('new collision');
    expect(statSync(path.join(root, 'extra-directory.txt')).isDirectory()).toBe(true);
    expect(existsSync(path.join(root, 'version'))).toBe(false);
    invoke('Clean', 0, newVersion);
    expect(existsSync(work)).toBe(false);
    expect(readFileSync(sentinel, 'utf8')).toBe('keep');
    expect(readFileSync(path.join(root, 'logs', 'keep.txt'), 'utf8')).toBe('keep');
    expect(readFileSync(unmanaged, 'utf8')).toBe('notes');
    expect(readFileSync(path.join(root, 'ffmpeg.dll'), 'utf8')).toBe('new binary');
    expect(readFileSync(path.join(unmanagedJunction, 'keep.txt'), 'utf8')).toBe('keep');
    expect(readFileSync(sharedFile, 'utf8')).toBe('shared contents');
    expect(statSync(sharedFile).mode & 0o222).toBe(0);
  }, 30_000);

  it('recovers both an incomplete extraction and an interrupted file switch', () => {
    invoke('Prepare');
    writeFileSync(path.join(incoming, executable), 'partial');
    invoke('Recover');
    expect(readFileSync(path.join(root, executable), 'utf8')).toBe(oldVersion);
    expect(existsSync(work)).toBe(false);

    invoke('Prepare');
    makePayload(incoming, newVersion);
    writeFileSync(path.join(root, oldCollision), 'previous file');
    mkdirSync(path.join(incoming, collision));
    writeFileSync(path.join(incoming, collision, 'new.txt'), 'new directory');
    invoke('Publish');
    expect(readFileSync(path.join(root, collision, 'new.txt'), 'utf8')).toBe('new directory');
    invoke('Clean', 11);
    expect(readFileSync(path.join(backup, executable), 'utf8')).toBe(oldVersion);
    invoke('Recover');
    expect(readFileSync(path.join(root, marker), 'utf8')).toBe(oldVersion);
    expect(readFileSync(path.join(root, oldCollision), 'utf8')).toBe('previous file');
    expect(readdirSync(root)).toContain(oldCollision);
    expect(existsSync(work)).toBe(false);

    invoke('Prepare');
    makePayload(incoming, newVersion);
    writeFileSync(path.join(incoming, collision), 'replacement file');
    recordSwitchPlan();
    for (const item of [...entries, oldCollision]) renameSync(path.join(root, item), path.join(backup, item));
    writeFileSync(path.join(work, 'switching'), '');
    renameSync(path.join(incoming, 'resources'), path.join(root, 'resources'));
    renameSync(path.join(incoming, collision), path.join(root, collision));
    invoke('Recover');
    expect(readFileSync(path.join(root, marker), 'utf8')).toBe(oldVersion);
    expect(readFileSync(path.join(root, executable), 'utf8')).toBe(oldVersion);
    expect(readFileSync(path.join(root, oldCollision), 'utf8')).toBe('previous file');
    expect(existsSync(work)).toBe(false);
  }, 30_000);

  it('resumes a partial backup and preserves evidence if a backup was replaced', () => {
    invoke('Prepare');
    writeFileSync(path.join(root, oldCollision), 'previous file');
    makePayload(incoming, newVersion);
    writeFileSync(path.join(incoming, collision), 'replacement file');
    recordSwitchPlan();
    renameSync(path.join(root, oldCollision), path.join(backup, oldCollision));
    const realBackup = path.join(fixture, 'original-backup');
    renameSync(path.join(backup, oldCollision), realBackup);
    writeFileSync(path.join(backup, oldCollision), 'unrecognized replacement');

    expect(invoke('Recover', 2)).toContain('An upgrade backup entry is unknown or was replaced');
    expect(readFileSync(path.join(backup, oldCollision), 'utf8')).toBe('unrecognized replacement');
    expect(existsSync(path.join(root, oldCollision))).toBe(false);
    rmSync(path.join(backup, oldCollision));
    renameSync(realBackup, path.join(backup, oldCollision));

    invoke('Recover');
    expect(readFileSync(path.join(root, oldCollision), 'utf8')).toBe('previous file');
    expect(existsSync(work)).toBe(false);
  }, 25_000);

  it('does not fall back to legacy removal with unknown entries and does not overwrite a conflict during recovery', () => {
    const unknown = path.join(root, 'notes.txt');
    writeFileSync(unknown, 'notes');
    expect(invoke('CheckLegacyRemoval', 2)).toContain('Unrecognized application entry: notes.txt');
    expect(readFileSync(unknown, 'utf8')).toBe('notes');
    expect(existsSync(work)).toBe(false);

    invoke('Prepare');
    writeFileSync(path.join(work, 'ready'), JSON.stringify({ schema: 1, root, previousVersion: oldVersion }));
    renameSync(path.join(root, executable), path.join(backup, executable));
    writeFileSync(path.join(root, executable), 'collision');
    invoke('Recover', 2);
    expect(readFileSync(path.join(root, executable), 'utf8')).toBe('collision');
    expect(readFileSync(path.join(backup, executable), 'utf8')).toBe(oldVersion);
  }, 30_000);

  it('does not hand a nested junction to a recursive legacy uninstaller', () => {
    const external = path.join(fixture, 'external');
    mkdirSync(external);
    writeFileSync(path.join(external, 'sentinel'), 'outside');
    symlinkSync(external, path.join(root, 'resources', 'external'), 'junction');

    expect(invoke('CheckLegacyRemoval', 2)).toContain('Conventional upgrade cannot safely remove a link:');
    expect(existsSync(work)).toBe(false);
    expect(readFileSync(path.join(external, 'sentinel'), 'utf8')).toBe('outside');
  });

  it('preserves a directory named like a managed file on both upgrade paths', () => {
    const collision = path.join(root, 'ffmpeg.dll');
    mkdirSync(collision);
    const sentinel = path.join(collision, 'keep.txt');
    writeFileSync(sentinel, 'user file');

    expect(invoke('CheckLegacyRemoval', 2)).toContain('Unexpected file type');
    invoke('Prepare');
    makePayload(incoming, newVersion);
    writeFileSync(path.join(incoming, 'ffmpeg.dll'), 'new binary');
    expect(invoke('Publish', 2)).toContain('Expected an ordinary file:');
    expect(readFileSync(sentinel, 'utf8')).toBe('user file');
    expect(readFileSync(path.join(root, executable), 'utf8')).toBe(oldVersion);
  }, 20_000);

  it('finishes interrupted cleanup without reverting the installed version', () => {
    const key = `Software\\InstallerPayloadFixture\\${path.basename(fixture)}`;
    const registry = (...arguments_: string[]) => spawnSync('reg.exe', [...arguments_, '/reg:64'], {
      windowsHide: true, encoding: 'utf8',
    });
    writeFileSync(path.join(root, executable), newVersion);
    writeFileSync(path.join(root, marker), newVersion);
    try {
      expect(registry('add', `HKCU\\${key}\\Install`, '/v', 'InstallLocation', '/d', root, '/f').status).toBe(0);
      const uninstallKey = `HKCU\\${key}\\Uninstall`;
      expect(registry('add', uninstallKey, '/v', 'DisplayVersion', '/d', newVersion, '/f').status).toBe(0);
      for (const state of ['ready', 'committed']) {
        mkdirSync(work);
        writeFileSync(path.join(work, state), state === 'ready' ? JSON.stringify({
          schema: 1, root, previousVersion: oldVersion,
        }) : '');

        invoke('Recover', 0, newVersion, key);
        expect(existsSync(work)).toBe(false);
        expect(readFileSync(path.join(root, executable), 'utf8')).toBe(newVersion);
        expect(registry('query', uninstallKey, '/v', 'DisplayVersion').stdout).toContain(newVersion);
      }

      makePayload(root, oldVersion);
      invoke('Prepare');
      writeFileSync(path.join(work, 'ready'), JSON.stringify({ schema: 1, root, previousVersion: oldVersion }));
      writeFileSync(path.join(work, 'plan'), '[]');
      invoke('Recover', 0, newVersion, key);
      expect(existsSync(work)).toBe(false);
      expect(registry('query', uninstallKey, '/v', 'DisplayVersion').stdout).toContain(oldVersion);
    } finally {
      registry('delete', `HKCU\\${key}`, '/f');
    }
  }, 20_000);

  it('explains a reparse point in the installation path without writing to its target', () => {
    const alias = path.join(fixture, 'linked-install');
    symlinkSync(root, alias, 'junction');
    root = alias;

    expect(invoke('Prepare', 2)).toContain('step=validate-installation-path message=Expected a directory without a reparse point:');
    expect(existsSync(work)).toBe(false);
  });

  it('clears unused staging without removing live program files or a pending rollback', () => {
    rmSync(path.join(root, marker));
    invoke('Prepare', 0, 'Internal release A');
    writeFileSync(path.join(incoming, 'download.part'), 'unfinished extraction');
    invoke('DiscardStaging');
    expect(existsSync(work)).toBe(false);
    expect(readFileSync(path.join(root, executable), 'utf8')).toBe(oldVersion);

    invoke('Prepare', 0, 'Internal release A');
    makePayload(incoming, newVersion);
    invoke('Publish');
    expect(invoke('DiscardStaging', 2)).toContain('requires recovery by the original installation user');
    expect(readFileSync(path.join(backup, executable), 'utf8')).toBe(oldVersion);
    invoke('Clean', 0, newVersion);
  }, 20_000);

  it('continues another upgrade while a committed backup file is still open', async () => {
    invoke('Prepare');
    makePayload(incoming, newVersion);
    invoke('Publish');
    const release = await lockFile(path.join(backup, executable));
    try {
      invoke('Clean', 13, newVersion);
      invoke('Recover', 13);
      invoke('Prepare', 0, newVersion, undefined, 1);
      makePayload(path.join(root, '.upgrade-next', 'new'), '2.1.0');
      invoke('Publish', 0, newVersion, undefined, 1);
      invoke('Clean', 0, '2.1.0', undefined, 1);
      expect(readFileSync(path.join(root, executable), 'utf8')).toBe('2.1.0');
    } finally {
      await release();
    }
    invoke('Recover');
    expect(existsSync(work)).toBe(false);
  }, 30_000);

  it('restores the old files after a persistent resource lock and switches without re-extracting on retry', async () => {
    invoke('Prepare');
    makePayload(incoming, newVersion);
    const stagedResources = statSync(path.join(incoming, 'resources'), { bigint: true }).ino;
    const release = await lockFile(path.join(root, marker));
    try {
      expect(invoke('Publish', 14)).toMatch(/step=backup-previous-payload message=win32=(5|32|33) rollback=restored/);
      expect(readFileSync(path.join(root, marker), 'utf8')).toBe(oldVersion);
      expect(readFileSync(path.join(root, executable), 'utf8')).toBe(oldVersion);
      expect(readFileSync(path.join(incoming, marker), 'utf8')).toBe(newVersion);
      expect(readdirSync(backup)).toEqual([]);
    } finally {
      await release();
    }
    invoke('RetryPublish');
    expect(statSync(path.join(root, 'resources'), { bigint: true }).ino).toBe(stagedResources);
    invoke('Clean', 0, newVersion);
  }, 25_000);

  it('does not replace a file that appeared at a staged destination after rollback', async () => {
    invoke('Prepare');
    makePayload(incoming, newVersion);
    writeFileSync(path.join(incoming, 'new-runtime.dat'), 'bundled');
    const release = await lockFile(path.join(root, marker));
    try {
      invoke('Publish', 14);
    } finally {
      await release();
    }
    writeFileSync(path.join(root, 'new-runtime.dat'), 'appeared during retry prompt');
    expect(invoke('RetryPublish', 2)).toContain('The upgrade files changed before retry');
    expect(readFileSync(path.join(root, 'new-runtime.dat'), 'utf8')).toBe('appeared during retry prompt');
    expect(readFileSync(path.join(root, executable), 'utf8')).toBe(oldVersion);
  }, 20_000);

  it('automatically retries the move when the old resource handle is released during the switch', async () => {
    invoke('Prepare');
    makePayload(incoming, newVersion);
    const releaseSignal = path.join(fixture, 'release-lock');
    const release = await lockFile(path.join(root, marker), releaseSignal);
    try {
      const result = await new Promise<{ code: number | null; detail: string }>((resolve, reject) => {
        const publishing = spawn(powershell, helperArguments('Publish'), { windowsHide: true });
        let detail = '';
        publishing.stderr.on('data', chunk => {
          detail += String(chunk);
          if (detail.includes('rename-retry') && !existsSync(releaseSignal)) {
            writeFileSync(releaseSignal, '');
          }
        });
        const timeout = setTimeout(() => publishing.kill(), 10_000);
        publishing.once('error', error => { clearTimeout(timeout); reject(error); });
        publishing.once('close', code => { clearTimeout(timeout); resolve({ code, detail }); });
      });
      expect(result.code, result.detail).toBe(0);
      expect(result.detail).toMatch(/rename-retry win32=(5|32|33)/);
      expect(readFileSync(path.join(root, marker), 'utf8')).toBe(newVersion);
      invoke('Clean', 0, newVersion);
    } finally {
      await release();
    }
  }, 25_000);

  it.runIf(existsSync(makensis))('switches through NSIS and falls back to conventional upgrade after rollback', async () => {
    const guid = path.basename(fixture);
    const key = 'Software\\InstallerPayloadFixture\\' + guid;
    const setup = path.join(fixture, 'fixture.exe');
    const script = path.join(fixture, 'fixture.nsi');
    const payload = path.join(fixture, 'fixture-new');
    const diagnostics = path.join(fixture, 'setup.log');
    const authentication = 'chrome.exe';
    const fresh = path.join(fixture, 'fresh');
    const fallbackMarker = path.join(fixture, 'fallback');
    mkdirSync(path.join(fresh, '.upgrade'), { recursive: true });
    makePayload(payload, newVersion);
    for (const name of [agentCli, authentication]) {
      writeFileSync(path.join(root, name), oldVersion);
      writeFileSync(path.join(payload, name), newVersion);
    }
    const source = [
      'Unicode true', 'RequestExecutionLevel user', 'SilentInstall silent',
      'Name "Payload fixture"', 'OutFile "' + setup + '"',
      '!include "LogicLib.nsh"',
      ...Object.entries({
        PROJECT_DIR: project, APP_GUID: guid, VERSION: newVersion,
        PRODUCT_FILENAME: productName, UNINSTALL_FILENAME: uninstaller,
        INSTALL_REGISTRY_KEY: key + '\\Install', UNINSTALL_REGISTRY_KEY: key + '\\Uninstall',
        BROWSER_AUTHENTICATION_EXECUTABLE: authentication, AGENT_CLI_EXECUTABLE: agentCli,
      }).map(([name, value]) => '!define ' + name + ' "' + value + '"'),
      "!define UAC_IsAdmin '0 == 1'",
      ...['installMode', 'InstallerPayloadRoot', 'JustDoPayloadLogsAllowed', 'keepShortcuts', 'isTryToKeepShortcuts', 'oldDesktopLink', 'newDesktopLink',
        'InstallerOldIdentityKind', 'InstallerOldIdentityPath', 'InstallerOldIdentity',
        'oldStartMenuLink', 'newStartMenuLink', 'InstallerLookupMode', 'InstallerLookupState',
        'InstallerLookupDirectory', 'InstallerLookupUninstallDirectory'].map(name => 'Var ' + name),
      '!include "' + path.join(project, 'scripts/packaging/nsis-payload-upgrade.nsh') + '"',
      '!macro InstallerShowCorePhase ZH EN', '!macroend',
      '!macro JustDoLogInstallEvent TEXT',
      'FileOpen $9 "' + diagnostics + '" a', 'FileSeek $9 0 END',
      'FileWrite $9 "${TEXT}$\\r$\\n"', 'FileClose $9',
      '!macroend',
      '!macro JustDoAddInstallActivity ZH EN',
      '!insertmacro JustDoLogInstallEvent "${EN}"',
      '!macroend',
      '!macro FindJustDoProcesses TARGET', 'StrCpy ${TARGET} 1', '!macroend',
      '!macro RequestAndWaitForInstallerQuit TARGET', 'StrCpy ${TARGET} 0', '!macroend',
      '!macro StopJustDoProcesses TARGET FILTER', 'StrCpy ${TARGET} 0', '!macroend',
      '!macro setIsTryToKeepShortcuts', 'StrCpy $isTryToKeepShortcuts "false"', '!macroend',
      'Function JustDoSelectInstallLogDirectory', 'FunctionEnd',
      'Function InstallerReadPreviousIdentity',
      'IfFileExists "$InstallerOldIdentityPath" 0 +2',
      'StrCpy $InstallerOldIdentity "$InstallerOldIdentityKind"',
      'FunctionEnd',
      'Function InstallerResolveRegisteredDirectory',
      'StrCpy $InstallerLookupState confirmed',
      'StrCpy $InstallerLookupDirectory "$INSTDIR"',
      'StrCpy $InstallerLookupUninstallDirectory "$INSTDIR"',
      'FunctionEnd',
      'Section',
      'SetRegView 64',
      'StrCpy $1 "guard-sentinel"',
      'StrCpy $INSTDIR "' + fresh + '"',
      '!insertmacro InstallerClearStagingBeforeWrite "$INSTDIR"',
      'StrCmp $1 "guard-sentinel" +2',
      'Abort "Staging cleanup changed a caller register."',
      'StrCpy $installMode CurrentUser',
      'StrCpy $INSTDIR "' + root + '"',
      'WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"',
      'WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayVersion "' + oldVersion + '"',
      'WriteRegStr HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString \'$\\"$INSTDIR\\' + uninstaller + '$\\" /currentuser\'',
      '!insertmacro InstallerRecoverPayloadUpgrade',
      '!insertmacro InstallerPreparePayloadUpgrade',
      'StrCmp $INSTDIR "$InstallerPayloadRoot\\.upgrade\\new" +2',
      'Abort "The files were not staged."',
      'FixtureWritePayload:',
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
      'Goto FixtureDone',
      'InstallerRunConventionalUpgrade:',
      '!insertmacro JustDoLogInstallEvent "fixture-conventional-upgrade"',
      'StrCmp $InstallerPayloadFallbackRoot "$INSTDIR" +2',
      'Abort "The fallback did not retain the original installation target."',
      'StrCmp $InstallerPayloadFallbackDirectoryId "16" +2',
      'Abort "The fallback did not capture the directory identity."',
      'StrCmp $InstallerPayloadFallbackUninstallerId "0" +2',
      'Abort "The fallback did not capture the uninstaller identity."',
      'IfFileExists "$INSTDIR\\' + executable + '" +2',
      'Abort "The previous executable was not restored."',
      'IfFileExists "$INSTDIR\\.upgrade\\ready" 0 +2',
      'Abort "The previous uninstaller would have removed staging."',
      'FileOpen $9 "' + fallbackMarker + '" w',
      'FileClose $9',
      'Sleep 500',
      'Goto FixtureWritePayload',
      'FixtureDone:',
      'SectionEnd',
    ].join('\n');
    writeFileSync(script, source);
    try {
      const compilation = spawnSync(makensis, ['/V2', '/INPUTCHARSET', 'UTF8', script], {
        encoding: 'utf8', timeout: 20_000, windowsHide: true,
      });
      expect(compilation.status, compilation.stdout + compilation.stderr).toBe(0);
      writeFileSync(work, 'existing state must not be touched');
      const failed = spawnSync(setup, [], { encoding: 'utf8', timeout: 25_000, windowsHide: true });
      expect(failed.status, failed.error?.message).toBe(2);
      expect(existsSync(path.join(fresh, '.upgrade'))).toBe(false);
      const failure = readFileSync(diagnostics, 'utf8');
      expect(failure.match(/^phase=payload-upgrade-pending-recovery result=2 detail=step=restore-previous-payload message=Expected a directory without a reparse point: .+/gm)).toHaveLength(2);
      expect(readFileSync(work, 'utf8')).toBe('existing state must not be touched');
      expect(readFileSync(path.join(root, executable), 'utf8')).toBe(oldVersion);
      rmSync(work);
      rmSync(path.join(root, marker));
      mkdirSync(work);
      writeFileSync(path.join(work, 'ready'), JSON.stringify({ schema: 2, root, previousVersion: oldVersion }));
      mkdirSync(incoming);
      writeFileSync(path.join(incoming, executable), 'interrupted extraction');
      const installed = spawnSync(setup, [], { encoding: 'utf8', timeout: 25_000, windowsHide: true });
      expect(installed.status, installed.error?.message).toBe(0);
      expect(readFileSync(diagnostics, 'utf8')).toContain('phase=payload-upgrade-pending-recovery result=0');
      expect(existsSync(work)).toBe(false);
      expect(readFileSync(path.join(root, executable), 'utf8')).toBe(newVersion);
      expect(readFileSync(path.join(root, agentCli), 'utf8')).toBe(newVersion);
      expect(readFileSync(path.join(root, authentication), 'utf8')).toBe(newVersion);

      makePayload(root, oldVersion);
      const release = await lockFile(path.join(root, 'resources', 'app.asar'));
      try {
        const conventional = await new Promise<number | null>((resolve, reject) => {
          const instance = spawn(setup, [], { windowsHide: true });
          let watcher: ReturnType<typeof setInterval>;
          const timeout = setTimeout(() => instance.kill(), 25_000);
          watcher = setInterval(() => {
            if (existsSync(fallbackMarker)) {
              clearInterval(watcher);
              void release();
            }
          }, 50);
          instance.once('error', error => { clearTimeout(timeout); clearInterval(watcher); reject(error); });
          instance.once('close', code => { clearTimeout(timeout); clearInterval(watcher); resolve(code); });
        });
        expect(conventional).toBe(0);
        const output = readFileSync(diagnostics, 'utf8');
        expect(output.match(/phase=payload-upgrade-publish result=14 /g)).toHaveLength(2);
        expect(output).toContain('phase=payload-upgrade-fallback-start');
        expect(output).toContain('fixture-conventional-upgrade');
        expect(readFileSync(path.join(root, executable), 'utf8')).toBe(newVersion);
        expect(existsSync(work)).toBe(false);
      } finally {
        await release();
      }
    } finally {
      spawnSync('reg.exe', ['delete', 'HKCU\\' + key, '/f', '/reg:64'], { windowsHide: true, stdio: 'ignore' });
    }
  }, 55_000);
});
