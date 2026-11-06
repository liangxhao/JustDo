import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(__dirname, '../..');
const buildRoot = path.join(repositoryRoot, 'build');
const cache = process.env.ELECTRON_BUILDER_CACHE || path.join(process.env.LOCALAPPDATA || '', 'electron-builder/Cache');
const compiler = path.join(cache, 'nsis/nsis-3.0.4.1/makensis.exe');
const helper = readFileSync(path.join(repositoryRoot, 'scripts/packaging/nsis-sandbox-permissions.nsh'), 'utf8');
const packageSid = 'S-1-15-2-2';
const literal = (value: string): string => value.replaceAll('$', () => '$$');

type AccessRule = { sid: string; rights: number; inheritance: number; inherited: boolean; type: number };
type Security = { owner: string; sddl: string; rules: AccessRule[] };

function security(filename: string): Security {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    '$fixturePath = $env:INSTALLER_ACL_FIXTURE_PATH',
    '$acl = if ([IO.Directory]::Exists($fixturePath)) { [IO.Directory]::GetAccessControl($fixturePath) } else { [IO.File]::GetAccessControl($fixturePath) }',
    '$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {',
    '  [pscustomobject]@{ sid=$_.IdentityReference.Value; rights=[int]$_.FileSystemRights;',
    '    inheritance=[int]$_.InheritanceFlags; inherited=$_.IsInherited; type=[int]$_.AccessControlType }',
    '})',
    '[pscustomobject]@{ owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;',
    '  sddl=$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All); rules=$rules } | ConvertTo-Json -Depth 4 -Compress',
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    env: { ...process.env, INSTALLER_ACL_FIXTURE_PATH: filename },
    windowsHide: true, encoding: 'utf8', timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim()) as Security;
}

function compile(root: string, sourceHelper = helper): string {
  const executable = path.join(root, 'permissions.exe');
  const source = [
    'Unicode true', 'RequestExecutionLevel user', 'SilentInstall silent',
    `OutFile "${literal(executable)}"`,
    '!include "FileFunc.nsh"', '!include "LogicLib.nsh"',
    '!define JUSTDO_LANG_SIMPCHINESE 2052', '!define JUSTDO_LANG_TRADCHINESE 1028',
    'Var ProbeLog', 'Var ProbeAppData', 'Var ProbeLocalAppData',
    '!macro JustDoLogInstallEvent TEXT',
    `  FileOpen $ProbeLog "${literal(path.join(root, 'events.txt'))}" a`,
    '  FileSeek $ProbeLog 0 END',
    '  FileWriteUTF16LE $ProbeLog "${TEXT}$\\r$\\n"', '  FileClose $ProbeLog', '!macroend',
    sourceHelper,
    'Function .onInit', '  SetShellVarContext all',
    '  ReadEnvStr $INSTDIR "INSTALLER_ACL_FIXTURE_TARGET"',
    '  ReadEnvStr $ProbeAppData "INSTALLER_ACL_FIXTURE_ROAMING"',
    '  ReadEnvStr $ProbeLocalAppData "INSTALLER_ACL_FIXTURE_LOCAL"', 'FunctionEnd',
    'Section',
    ...[0, 1, 2, 3].map(index => `  StrCpy $${index} "preserved-${index}"`),
    '  !insertmacro InstallerRequireSandboxTarget "$ProbeAppData" "$ProbeLocalAppData"',
    '  !insertmacro JustDoLogInstallEvent "phase=fixture-old-version-removal"',
    '  !insertmacro InstallerRequireSandboxReadAccess',
    ...[0, 1, 2, 3].flatMap(index => [
      `  \${If} $${index} != "preserved-${index}"`, '    SetErrorLevel 3', '    Abort', '  ${EndIf}',
    ]),
    '  !insertmacro JustDoLogInstallEvent "phase=fixture-success"', 'SectionEnd',
  ].join('\n');
  const filename = path.join(root, 'permissions.nsi');
  writeFileSync(filename, source);
  const result = spawnSync(compiler, ['/WX', '/V2', '/INPUTCHARSET', 'UTF8', filename], {
    windowsHide: true, encoding: 'utf8', timeout: 15_000,
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return executable;
}

function temporaryRoot(): string {
  mkdirSync(buildRoot, { recursive: true });
  return mkdtempSync(path.join(buildRoot, 'installer-sandbox-'));
}

function cleanup(root: string): void {
  expect(path.dirname(path.resolve(root))).toBe(buildRoot);
  rmSync(root, { recursive: true, force: true });
}

function run(executable: string, directory: string, roots: { roaming?: string; local?: string } = {}): number | null {
  const result = spawnSync(executable, [], {
    env: { ...process.env, INSTALLER_ACL_FIXTURE_TARGET: directory,
      INSTALLER_ACL_FIXTURE_ROAMING: roots.roaming || '', INSTALLER_ACL_FIXTURE_LOCAL: roots.local || '' },
    windowsHide: true, timeout: 40_000,
  });
  expect(result.error).toBeUndefined();
  return result.status;
}

describe.runIf(process.platform === 'win32' && existsSync(compiler))('native installer sandbox permissions', () => {
  it('preserves existing ACLs, grants RX to old and new files, and remains stable across repairs', () => {
    const root = temporaryRoot();
    try {
      const directory = path.join(root, '安装目录 空格 %literal% & ! $value');
      mkdirSync(directory);
      const existingFile = path.join(directory, 'application.exe');
      writeFileSync(existingFile, 'fixture');
      const customSid = 'S-1-15-2-999-999-999';
      const seeded = spawnSync('icacls.exe', [directory, '/grant', `*${customSid}:(OI)(CI)(RX)`, '/L'], { windowsHide: true });
      expect(seeded.status).toBe(0);
      const before = security(directory);
      const parentBefore = security(root);
      const executable = compile(root);
      expect(run(executable, directory), readFileSync(path.join(root, 'events.txt'), 'utf16le')).toBe(0);
      const after = security(directory);
      expect(after.owner).toBe(before.owner);
      expect(after.rules).toEqual(expect.arrayContaining(before.rules));
      expect(after.rules.some(rule => rule.sid === customSid)).toBe(true);
      const grants = after.rules.filter(rule => rule.sid === packageSid && !rule.inherited);
      expect(grants).toHaveLength(1);
      expect(grants[0]).toMatchObject({ inheritance: 3, type: 0 });
      expect(grants[0].rights & 0x200a9).toBe(0x200a9); // ReadAndExecute
      expect(grants[0].rights & 0x116).toBe(0); // Write
      const nested = path.join(directory, 'resources', 'nested');
      mkdirSync(nested, { recursive: true });
      const newFile = path.join(nested, 'payload.dat');
      writeFileSync(newFile, 'newly extracted fixture');
      for (const filename of [existingFile, newFile]) {
        expect(security(filename).rules.some(rule => rule.sid === packageSid && rule.inherited && rule.type === 0)).toBe(true);
      }
      expect(run(executable, directory + path.sep)).toBe(0);
      expect(security(directory).sddl).toBe(after.sddl);
      expect(security(root).sddl).toBe(parentBefore.sddl);
    } finally { cleanup(root); }
  }, 40_000);

  it('rejects drive/profile roots and junction ancestors before changing outside permissions', () => {
    const root = temporaryRoot();
    const junction = path.join(root, 'linked-install');
    try {
      const outside = path.join(root, 'outside');
      const child = path.join(outside, 'product');
      mkdirSync(child, { recursive: true });
      symlinkSync(outside, junction, 'junction');
      const before = security(outside);
      const executable = compile(root);
      for (const target of [path.parse(root).root, process.env.USERPROFILE!, junction, path.join(junction, 'product')]) {
        expect(run(executable, target)).toBe(2);
      }
      expect(security(outside).sddl).toBe(before.sddl);
      const events = readFileSync(path.join(root, 'events.txt'), 'utf16le');
      expect(events).toContain('reason=sandbox-permissions-failed');
      expect(events).not.toContain('phase=fixture-success');
      expect(events).not.toContain('phase=fixture-old-version-removal');
    } finally {
      if (existsSync(junction)) unlinkSync(junction);
      cleanup(root);
    }
  }, 30_000);

  it('keeps the initiating user roots protected in all-users context and admits a fresh child target', () => {
    const root = temporaryRoot();
    try {
      const roaming = path.join(root, 'initiating-user-roaming');
      const local = path.join(root, 'initiating-user-local');
      mkdirSync(roaming);
      mkdirSync(local);
      const before = [security(roaming).sddl, security(local).sddl];
      const executable = compile(root);
      const roots = { roaming, local };
      for (const target of [roaming, local]) expect(run(executable, target, roots)).toBe(2);
      expect([security(roaming).sddl, security(local).sddl]).toEqual(before);
      const events = readFileSync(path.join(root, 'events.txt'), 'utf16le');
      expect(events).not.toContain('phase=fixture-old-version-removal');
      // Only the later grant requires files to have been extracted. Admission
      // itself must accept a missing fresh-install child before replacement.
      expect(run(executable, path.join(local, 'new-product'), roots)).toBe(2);
      expect(readFileSync(path.join(root, 'events.txt'), 'utf16le')).toContain('phase=fixture-old-version-removal');
    } finally { cleanup(root); }
  }, 30_000);

  it.each([
    { reason: 'cannot be launched', change: (source: string) => source.replace('"$SYSDIR\\icacls.exe"', '"$INSTDIR\\missing-permissions-command.exe"'), result: /result=error/ },
    { reason: 'returns a failure', change: (source: string) => source.replace('/grant "*${INSTALLER_SANDBOX_PACKAGE_SID}:(OI)(CI)(RX)" /L', '/invalid-option'), result: /result=[1-9][0-9]*/ },
  ])('aborts before success when the permission command $reason', ({ change, result }) => {
    const root = temporaryRoot();
    try {
      const directory = path.join(root, 'installation');
      mkdirSync(directory);
      const before = security(directory);
      const executable = compile(root, change(helper));
      expect(run(executable, directory)).toBe(2);
      expect(security(directory).sddl).toBe(before.sddl);
      const events = readFileSync(path.join(root, 'events.txt'), 'utf16le');
      expect(events).toMatch(result);
      expect(events).not.toContain('phase=fixture-success');
    } finally { cleanup(root); }
  }, 30_000);
});
