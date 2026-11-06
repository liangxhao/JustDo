import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(__dirname, '../..');
const cache = process.env.ELECTRON_BUILDER_CACHE || path.join(process.env.LOCALAPPDATA || '', 'electron-builder/Cache');
const compiler = path.join(cache, 'nsis/nsis-3.0.4.1/makensis.exe');
const lookup = readFileSync(path.join(repositoryRoot, 'scripts/packaging/nsis-existing-installation.nsh'), 'utf8');
const literal = (value: string): string => value.replaceAll('$', () => '$$');

describe.runIf(process.platform === 'win32' && existsSync(compiler))('native registered installation lookup', () => {
  it('confirms product files, recovers stale locations from paired uninstallers and keeps uncertainty editable', () => {
    const buildRoot = path.join(repositoryRoot, 'build');
    mkdirSync(buildRoot, { recursive: true });
    const root = mkdtempSync(path.join(buildRoot, 'installer-lookup-'));
    const registryKey = `Software\\InstallerLookupFixture-${randomUUID()}`;
    // Exercise the released brand, independently from the stable package ID.
    const product = 'Wedax';
    const applicationFile = `${product}.exe`;
    const uninstallFile = `Uninstall ${product}.exe`;
    const installed = path.join(root, 'D 盘旧安装 & %value% $literal');
    const other = path.join(root, '另一份有效安装');
    const incomplete = path.join(root, '仅剩卸载器');
    const directoryFile = path.join(root, '文件名其实是目录');
    const stale = path.join(root, '不存在的旧记录');
    const unrelated = path.join(root, '其他品牌');
    for (const directory of [installed, other, incomplete, directoryFile, unrelated]) mkdirSync(directory);
    for (const directory of [installed, other]) {
      writeFileSync(path.join(directory, applicationFile), 'fixture product executable');
      writeFileSync(path.join(directory, uninstallFile), 'fixture uninstaller');
    }
    writeFileSync(path.join(incomplete, uninstallFile), 'fixture uninstaller');
    writeFileSync(path.join(unrelated, 'justdo.exe'), 'internal package name is not the released executable');
    mkdirSync(path.join(directoryFile, applicationFile));
    writeFileSync(path.join(directoryFile, uninstallFile), 'fixture uninstaller');
    chmodSync(path.join(installed, applicationFile), 0o444);
    const command = (directory: string, file = uninstallFile): string => `"${path.join(directory, file)}" /currentuser`;
    const cases = [
      { id: 'fresh', location: '', command: '', state: 'missing', directory: '', uninstall: '' },
      { id: 'live', location: installed, command: '', state: 'confirmed', directory: installed, uninstall: '' },
      { id: 'paired', location: installed, command: command(installed), state: 'confirmed', directory: installed, uninstall: installed },
      { id: 'same-normalized', location: `${installed}\\.`, command: command(installed), state: 'confirmed', directory: `${installed}\\.`, uninstall: installed },
      { id: 'trailing-separator', location: `${installed}\\`, command: command(installed), state: 'confirmed', directory: `${installed}\\`, uninstall: installed },
      { id: 'recovered', location: stale, command: command(installed), state: 'confirmed', directory: installed, uninstall: installed },
      { id: 'arp-only', location: '', command: command(installed), state: 'confirmed', directory: installed, uninstall: installed },
      { id: 'stale', location: stale, command: '', state: 'missing', directory: '', uninstall: '' },
      { id: 'conflict', location: installed, command: command(other), state: 'conflict', directory: '', uninstall: '' },
      { id: 'incomplete', location: incomplete, command: command(incomplete), state: 'missing', directory: '', uninstall: incomplete },
      { id: 'incomplete-conflict', location: installed, command: command(incomplete), state: 'conflict', directory: '', uninstall: '' },
      { id: 'directory-file', location: directoryFile, command: command(directoryFile), state: 'missing', directory: '', uninstall: directoryFile },
      { id: 'wrong-brand', location: unrelated, command: '', state: 'missing', directory: '', uninstall: '' },
      { id: 'unquoted', location: '', command: command(installed).slice(1), state: 'missing', directory: '', uninstall: '' },
      { id: 'quoted-argument', location: '', command: `missing.exe ${command(installed)}`, state: 'missing', directory: '', uninstall: '' },
      { id: 'wrong-leaf', location: '', command: command(installed, applicationFile), state: 'missing', directory: '', uninstall: '' },
      { id: 'unterminated', location: '', command: `"${path.join(installed, uninstallFile)}`, state: 'missing', directory: '', uninstall: '' },
      { id: 'relative', location: '.\\relative', command: '".\\Uninstall Wedax.exe"', state: 'missing', directory: '', uninstall: '' },
      { id: 'access-denied-after-product-confirmation', location: installed, command: command(installed), state: 'unknown', directory: '', uninstall: '' },
      { id: 'unavailable-location-before-valid-arp', location: stale, command: command(installed), state: 'unknown', directory: '', uninstall: '' },
    ];
    try {
      // Keep file IO real except two narrowly injected Win32 error results. The
      // System plug-in's ?e option pushes LastError, so each failure must push it
      // too. No ACL or system-wide network state needs to change for this test.
      const attributesCall = 'System::Call \'kernel32::GetFileAttributesW(w "${_PATH}")i.r5 ?e\'';
      expect(lookup.split(attributesCall)).toHaveLength(2);
      const lookupFixture = lookup.replace(attributesCall, [
        '    ${If} $ProbeCase == "access-denied-after-product-confirmation"',
        '    ${AndIf} "${_PATH}" == $ProbeDeniedFile',
        '      StrCpy $5 -1', '      Push 5',
        '    ${ElseIf} $ProbeCase == "unavailable-location-before-valid-arp"',
        '    ${AndIf} "${_PATH}" == $ProbeUnavailableFile',
        '      StrCpy $5 -1', '      Push 53',
        '    ${Else}', `      ${attributesCall}`, '    ${EndIf}',
      ].join('\n'));
      const initializers = cases.flatMap(item => [
        `  \${If} $ProbeCase == "${item.id}"`,
        `    WriteRegStr HKCU "\${INSTALL_REGISTRY_KEY}" InstallLocation "${literal(item.location)}"`,
        `    WriteRegStr HKCU "\${UNINSTALL_REGISTRY_KEY}" UninstallString '${literal(item.command)}'`,
        '  ${EndIf}',
      ]);
      const source = [
        'Unicode true', 'SilentInstall silent', 'RequestExecutionLevel user', 'Name "Installation lookup fixture"',
        `OutFile "${literal(path.join(root, 'lookup.exe'))}"`, '!include "LogicLib.nsh"', '!include "FileFunc.nsh"',
        `!define INSTALL_REGISTRY_KEY "${registryKey}\\install"`,
        `!define UNINSTALL_REGISTRY_KEY "${registryKey}\\uninstall"`,
        `!define APP_EXECUTABLE_FILENAME "${applicationFile}"`, `!define UNINSTALL_FILENAME "${uninstallFile}"`,
        'Var ProbeCase', 'Var ProbeDeniedFile', 'Var ProbeUnavailableFile',
        lookupFixture.replaceAll('HKLM ', 'HKCU '),
        'Function .onInit', '  SetRegView 64', `  DeleteRegKey HKCU "${registryKey}"`,
        `  StrCpy $ProbeDeniedFile "${literal(path.join(installed, uninstallFile))}"`,
        `  StrCpy $ProbeUnavailableFile "${literal(path.join(stale, applicationFile))}"`,
        '  ${GetParameters} $0', '  ${GetOptions} $0 "/case=" $ProbeCase', ...initializers, 'FunctionEnd',
        'Section', '  StrCpy $InstallerLookupMode "CurrentUser"',
        ...Array.from({ length: 10 }, (_, index) => `  StrCpy $${index} "preserved-${index}"`),
        '  SetErrors', '  Call InstallerResolveRegisteredDirectory',
        '  ${IfNot} ${Errors}', '    SetErrorLevel 3', '    Quit', '  ${EndIf}',
        ...Array.from({ length: 10 }, (_, index) => [
          `  \${If} $${index} != "preserved-${index}"`, '    SetErrorLevel 4', '    Quit', '  ${EndIf}',
        ]).flat(),
        '  ClearErrors', '  Call InstallerResolveRegisteredDirectory',
        '  ${If} ${Errors}', '    SetErrorLevel 5', '    Quit', '  ${EndIf}',
        `  FileOpen $0 "${literal(path.join(root, 'result.txt'))}" w`,
        String.raw`  FileWriteUTF16LE $0 "$InstallerLookupState$\t$InstallerLookupDirectory$\t$InstallerLookupUninstallDirectory$\r$\n"`,
        '  FileClose $0', `  DeleteRegKey HKCU "${registryKey}"`, '  SetErrorLevel 0', 'SectionEnd',
      ].join('\n');
      const script = path.join(root, 'lookup.nsi');
      writeFileSync(script, source);
      const compile = spawnSync(compiler, ['/WX', '/V2', '/INPUTCHARSET', 'UTF8', script], {
        windowsHide: true, encoding: 'utf8', timeout: 15_000,
      });
      expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);
      for (const item of cases) {
        const run = spawnSync(path.join(root, 'lookup.exe'), [`/case=${item.id}`], {
          windowsHide: true, encoding: 'utf8', timeout: 10_000,
        });
        expect(run.status, `${item.id}: ${run.stdout}\n${run.stderr}`).toBe(0);
        expect(readFileSync(path.join(root, 'result.txt'), 'utf16le').replace(/\r?\n$/, ''), item.id)
          .toBe(`${item.state}\t${item.directory}\t${item.uninstall}`);
      }
    } finally {
      chmodSync(path.join(installed, applicationFile), 0o666);
      spawnSync('reg.exe', ['delete', `HKCU\\${registryKey}`, '/f', '/reg:64'], {
        windowsHide: true, timeout: 5_000, stdio: 'ignore',
      });
      expect(path.dirname(path.resolve(root))).toBe(buildRoot);
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
