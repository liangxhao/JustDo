import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, test } from 'vitest';

const repositoryRoot = path.resolve(__dirname, '../..');
const cacheRoot = process.env.ELECTRON_BUILDER_CACHE ||
  path.join(process.env.LOCALAPPDATA || '', 'electron-builder/Cache');
const compiler = path.join(cacheRoot, 'nsis/nsis-3.0.4.1/makensis.exe');
const setup = readFileSync(path.join(repositoryRoot, 'scripts/packaging/nsis-setup-presentation.nsh'), 'utf8');
const installer = readFileSync(path.join(repositoryRoot, 'scripts/packaging/nsis-installer.nsh'), 'utf8');
const lookup = readFileSync(path.join(repositoryRoot, 'scripts/packaging/nsis-existing-installation.nsh'), 'utf8');
const upstream = readFileSync(path.join(repositoryRoot, 'node_modules/app-builder-lib/templates/nsis/assistedInstaller.nsh'), 'utf8');
const nsisPath = (value: string): string => value.replaceAll('$', () => '$$');
const sourceFunction = (source: string, name: string): string => {
  const result = source.match(new RegExp(`Function ${name}\\b[^]*?FunctionEnd`));
  if (!result) throw new Error(`Installer function missing: ${name}`);
  return result[0];
};
const sourceMacro = (name: string): string => {
  const result = setup.match(new RegExp(`!macro ${name}\\b[^]*?!macroend`));
  if (!result) throw new Error(`Installer macro missing: ${name}`);
  return result[0];
};
const isolateRegistry = (source: string): string => source
  .replaceAll('HKLM "${INSTALL_REGISTRY_KEY}"', 'HKCU "${INSTALL_REGISTRY_KEY}\\machine"')
  .replaceAll('HKCU "${INSTALL_REGISTRY_KEY}"', 'HKCU "${INSTALL_REGISTRY_KEY}\\user"');
const scenarios = [
  { id: 'fresh', mode: 'CurrentUser', user: false, machine: false, forced: '', locked: '' },
  { id: 'unique-user', mode: 'all', user: true, machine: false, forced: '', locked: 'CurrentUser' },
  { id: 'unique-machine', mode: 'CurrentUser', user: false, machine: true, forced: '', locked: 'all' },
  { id: 'both-current', mode: 'CurrentUser', user: true, machine: true, forced: '', locked: '' },
  { id: 'both-all', mode: 'all', user: true, machine: true, forced: '', locked: '' },
  { id: 'stale-user-live-machine', mode: 'CurrentUser', user: false, machine: true, staleUser: true, forced: '', locked: 'all' },
  { id: 'stale-only', mode: 'CurrentUser', user: false, machine: false, staleUser: true, forced: '', locked: '' },
  { id: 'forced-current-over-machine', mode: 'CurrentUser', user: false, machine: true, forced: 'CurrentUser', locked: '' },
  { id: 'forced-all-over-user', mode: 'all', user: true, machine: false, forced: 'all', locked: '' },
] as const;

test('resolves scope after authenticated handoff and before skipping updater setup', () => {
  const create = sourceFunction(setup, 'InstallerCombinedCreate');
  const resolve = create.indexOf('Call InstallerCombinedPrepareUpgradeMode');
  expect(resolve).toBeGreaterThan(create.indexOf('${If} ${UAC_IsInnerInstance}'));
  expect(resolve).toBeLessThan(create.indexOf('${If} ${isUpdated}'));
  expect(resolve).toBeLessThan(create.indexOf('nsDialogs::Create'));
  const prepare = sourceFunction(setup, 'InstallerCombinedPrepareUpgradeMode');
  expect(prepare.indexOf('Call InstallerCombinedResolveUpgradeMode'))
    .toBeGreaterThan(prepare.indexOf('StrCpy $InstallerCombinedForcedMode ""'));
  const resolver = sourceFunction(setup, 'InstallerCombinedResolveUpgradeMode');
  expect(resolver).not.toMatch(/hasPerUserInstallation|hasPerMachineInstallation/);
});

describe.runIf(process.platform === 'win32' && existsSync(compiler))('native installer upgrade scope policy', () => {
  it('retains real registered scopes and restores locked scope and folder at the write boundary', () => {
    const buildRoot = path.join(repositoryRoot, 'build');
    mkdirSync(buildRoot, { recursive: true });
    const root = mkdtempSync(path.join(buildRoot, 'installer-scope-policy-'));
    const registryKey = `Software\\InstallerScopeFixture-${randomUUID()}`;
    const userDirectory = path.join(root, '原用户目录 & %value% $literal');
    const machineDirectory = path.join(root, '原机器目录');
    const selection = path.join(root, 'edited location');
    const stale = path.join(root, 'stale registration');
    for (const directory of [userDirectory, machineDirectory, selection]) mkdirSync(directory);
    for (const directory of [userDirectory, machineDirectory]) writeFileSync(path.join(directory, 'ScopeFixture.exe'), 'fixture executable');
    try {
      const initializers = scenarios.flatMap(scenario => [
        `\${If} $ProbeCase == "${scenario.id}"`,
        `  StrCpy $InstallerCombinedMode "${scenario.mode}"`,
        `  StrCpy $InstallerCombinedForcedMode "${scenario.forced}"`,
        ...(scenario.user ? [`  WriteRegStr HKCU "\${INSTALL_REGISTRY_KEY}\\user" InstallLocation "${nsisPath(userDirectory)}"`] : []),
        ...('staleUser' in scenario ? [`  WriteRegStr HKCU "\${INSTALL_REGISTRY_KEY}\\user" InstallLocation "${nsisPath(stale)}"`] : []),
        ...(scenario.machine ? [`  WriteRegStr HKCU "\${INSTALL_REGISTRY_KEY}\\machine" InstallLocation "${nsisPath(machineDirectory)}"`] : []),
        '${EndIf}',
      ]);
      const source = [
        'Unicode true', 'SilentInstall silent', 'RequestExecutionLevel user',
        `OutFile "${nsisPath(path.join(root, 'scope.exe'))}"`, 'Name "Scope policy fixture"',
        '!include "LogicLib.nsh"', '!include "FileFunc.nsh"',
        `!include "${nsisPath(path.join(repositoryRoot, 'node_modules/app-builder-lib/templates/nsis/include/StrContains.nsh'))}"`,
        '!define APP_FILENAME "ScopeFixture"', '!define allowToChangeInstallationDirectory',
        '!define APP_EXECUTABLE_FILENAME "ScopeFixture.exe"', '!define UNINSTALL_FILENAME "Uninstall ScopeFixture.exe"',
        `!define INSTALL_REGISTRY_KEY "${registryKey}"`,
        `!define UNINSTALL_REGISTRY_KEY "${registryKey}\\uninstall"`,
        ...['InstallerCombinedMode', 'InstallerCombinedLockedMode', 'InstallerCombinedForcedMode',
          'InstallerCombinedEvent', 'InstallerCombinedCurrentUser', 'InstallerCombinedAllUsers',
          'InstallerUpgradeDirectory', 'installMode', 'JustDoInstallMode', 'ProbeCase', 'ProbeInner',
          'ProbeExpectedPrograms'].map(name => `Var ${name}`),
        '!macro JustDoLogInstallEvent TEXT', '!macroend',
        sourceMacro('InstallerSetupSave'), sourceMacro('InstallerSetupRestore'),
        '!macro setInstallModePerUser', '!macroend', '!macro setInstallModePerAllUsers', '!macroend',
        'Function InstallerCombinedSaveDraft', 'FunctionEnd',
        'Function InstallerCombinedApplyMode', '  StrCpy $installMode "$InstallerCombinedMode"', 'FunctionEnd',
        'Function JustDoCheckAppRunning', 'FunctionEnd',
        isolateRegistry(lookup),
        isolateRegistry(sourceFunction(setup, 'InstallerCombinedResolveUpgradeMode')),
        sourceFunction(setup, 'InstallerCombinedScopeChanged'),
        isolateRegistry(sourceFunction(installer, 'InstallerRestoreUpgradeDirectory')),
        sourceFunction(installer, 'JustDoInstFilesPre').replaceAll('${UAC_IsInnerInstance}', '$ProbeInner == "1"'),
        sourceFunction(upstream, 'instFilesPre'),
        'Function .onInit', '  SetRegView 64', '  DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"',
        '  ${GetParameters} $0', '  ${GetOptions} $0 "/case=" $ProbeCase',
        '  StrCpy $ProbeInner "0"', '  StrCpy $InstallerCombinedCurrentUser "11"',
        '  StrCpy $InstallerCombinedAllUsers "22"', ...initializers, 'FunctionEnd',
        'Section', '  Call InstallerCombinedResolveUpgradeMode',
        `  FileOpen $3 "${nsisPath(path.join(root, 'result.txt'))}" w`,
        String.raw`  FileWriteUTF16LE $3 "resolved$\t$InstallerCombinedLockedMode$\t$InstallerCombinedMode$\r$\n"`,
        // Invoke the real change callback even for a normally disabled radio.
        '  ${If} $InstallerCombinedMode == "all"', '    Push $InstallerCombinedCurrentUser',
        '  ${Else}', '    Push $InstallerCombinedAllUsers', '  ${EndIf}',
        '  Call InstallerCombinedScopeChanged',
        String.raw`  FileWriteUTF16LE $3 "selected$\t$installMode$\r$\n"`,
        '  ${If} $InstallerCombinedLockedMode != ""',
        '    ${If} $InstallerCombinedLockedMode == "all"', '      SetShellVarContext all',
        '      StrCpy $ProbeExpectedPrograms "$SMPROGRAMS"', '      SetShellVarContext current',
        '      StrCpy $installMode "CurrentUser"',
        '    ${Else}', '      SetShellVarContext current', '      StrCpy $ProbeExpectedPrograms "$SMPROGRAMS"',
        '      SetShellVarContext all', '      StrCpy $installMode "all"', '    ${EndIf}',
        '    StrCpy $InstallerCombinedMode "$installMode"', '  ${EndIf}',
        `  StrCpy $INSTDIR "${nsisPath(selection)}"`, '  Call JustDoInstFilesPre',
        String.raw`  FileWriteUTF16LE $3 "final$\t$installMode$\t$INSTDIR$\r$\n"`,
        '  ${If} $InstallerCombinedLockedMode != ""',
        '    ${If} $SMPROGRAMS != $ProbeExpectedPrograms', '      SetErrorLevel 2', '      Quit', '    ${EndIf}',
        '  ${EndIf}', '  FileClose $3', '  DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"',
        '  SetErrorLevel 0', 'SectionEnd',
      ].join('\n');
      const script = path.join(root, 'scope.nsi');
      writeFileSync(script, source);
      const compile = spawnSync(compiler, ['/WX', '/V2', '/INPUTCHARSET', 'UTF8', script], {
        windowsHide: true, encoding: 'utf8', timeout: 15_000,
      });
      expect(compile.status, `${compile.stdout}\n${compile.stderr}`).toBe(0);
      for (const scenario of scenarios) {
        const run = spawnSync(path.join(root, 'scope.exe'), [`/case=${scenario.id}`], {
          windowsHide: true, encoding: 'utf8', timeout: 10_000,
        });
        expect(run.status, `${scenario.id}: ${run.stdout}\n${run.stderr}`).toBe(0);
        const resolved = scenario.locked || scenario.mode;
        const selected = scenario.locked || scenario.forced || (resolved === 'all' ? 'CurrentUser' : 'all');
        const registered = selected === 'all'
          ? (scenario.machine ? machineDirectory : '') : (scenario.user ? userDirectory : '');
        const lines = readFileSync(path.join(root, 'result.txt'), 'utf16le').trim().split(/\r?\n/);
        expect(lines, scenario.id).toEqual([
          `resolved\t${scenario.locked}\t${resolved}`, `selected\t${selected}`,
          `final\t${selected}\t${registered || path.join(selection, 'ScopeFixture')}`,
        ]);
      }
    } finally {
      spawnSync('reg.exe', ['delete', `HKCU\\${registryKey}`, '/f', '/reg:64'], {
        windowsHide: true, timeout: 5_000, stdio: 'ignore',
      });
      expect(path.dirname(path.resolve(root))).toBe(buildRoot);
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
