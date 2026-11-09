import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, test } from 'vitest';

const repositoryRoot = path.resolve(__dirname, '../..');
const cacheRoot = process.env.ELECTRON_BUILDER_CACHE ||
  path.join(process.env.LOCALAPPDATA || '', 'electron-builder/Cache');
const compiler = path.join(cacheRoot, 'nsis/nsis-3.0.4.1/makensis.exe');
const read = (name: string): string => readFileSync(path.join(repositoryRoot, 'scripts/packaging', name), 'utf8');
const setup = read('nsis-setup-presentation.nsh');
const installer = read('nsis-installer.nsh');
const lookup = read('nsis-existing-installation.nsh');
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
const nsisPath = (value: string): string => value.replaceAll('$', () => '$$');
const isolateRegistry = (source: string): string => source
  .replaceAll('HKLM "${INSTALL_REGISTRY_KEY}"', 'HKCU "${INSTALL_REGISTRY_KEY}\\machine"')
  .replaceAll('HKCU "${INSTALL_REGISTRY_KEY}"', 'HKCU "${INSTALL_REGISTRY_KEY}\\user"')
  .replaceAll('HKLM "${UNINSTALL_REGISTRY_KEY}"', 'HKCU "${UNINSTALL_REGISTRY_KEY}\\machine"')
  .replaceAll('HKCU "${UNINSTALL_REGISTRY_KEY}"', 'HKCU "${UNINSTALL_REGISTRY_KEY}\\user"');

test('prepares verified update targets before updater page skipping and silent process checks', () => {
  const create = sourceFunction(setup, 'InstallerCombinedCreate');
  const prepare = create.indexOf('Call InstallerCombinedPrepareUpgradeMode');
  expect(prepare).toBeGreaterThan(create.indexOf('InstallerCombinedHandoffFailed:'));
  expect(prepare).toBeLessThan(create.indexOf('${If} ${isUpdated}'));
  const customInit = installer.match(/!macro customInit\b[^]*?!macroend/)![0];
  const silent = customInit.slice(customInit.indexOf('${If} ${Silent}'));
  expect(silent).toContain('${isUpdated}');
  expect(silent.indexOf('Call InstallerCombinedPrepareUpgradeMode')).toBeGreaterThanOrEqual(0);
  expect(silent.indexOf('Call InstallerCombinedPrepareUpgradeMode'))
    .toBeLessThan(silent.indexOf('Call JustDoCheckAppRunning'));
  expect(silent.indexOf('Call InstallerCombinedApplyUpgradeMode')).toBeGreaterThanOrEqual(0);
  expect(silent.indexOf('Call InstallerCombinedApplyUpgradeMode'))
    .toBeLessThan(silent.indexOf('Call JustDoCheckAppRunning'));
  const innerBranch = silent.slice(silent.indexOf('${If} ${UAC_IsInnerInstance}'), silent.indexOf('${Else}'));
  expect(innerBranch).toContain('StrCpy $InstallerCombinedMode "all"');
  expect(innerBranch).toContain('Call InstallerCombinedApplyUpgradeMode');
  expect(innerBranch).not.toContain('Call InstallerCombinedPrepareUpgradeMode');
});

test('restores the registered target after upstream silent scope selection and before file operations', () => {
  const { createWindowsInstallerScript } = require('../../scripts/packaging/windows-installer-script.cjs');
  const templates = path.join(path.dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis');
  const generated = createWindowsInstallerScript(templates);
  const section = generated.slice(generated.indexOf('Section "install" INSTALL_SECTION_ID'));
  const restore = section.indexOf('Call InstallerRestoreUpgradeDirectory');
  expect(restore).toBeGreaterThan(section.indexOf('!insertmacro setInstallModePerAllUsers'));
  expect(restore).toBeLessThan(section.indexOf('StrCpy $appExe'));
  expect(restore).toBeLessThan(section.indexOf('!insertmacro uninstallOldVersion SHELL_CONTEXT'));
});

const scenarios = [
  { id: 'stale-user-live-machine', user: 'stale', machine: 'live', forced: '', expected: 'all', ready: true },
  { id: 'live-user-stale-machine', user: 'live', machine: 'stale', forced: '', expected: 'CurrentUser', ready: true },
  { id: 'both-live-ambiguous', user: 'live', machine: 'live', forced: '', expected: 'CurrentUser', ready: false },
  { id: 'explicit-current', user: 'live', machine: 'live', forced: 'CurrentUser', expected: 'CurrentUser', ready: true },
  { id: 'explicit-all', user: 'live', machine: 'live', forced: 'all', expected: 'all', ready: true },
  { id: 'explicit-stale-current', user: 'stale', machine: 'live', forced: 'CurrentUser', expected: 'CurrentUser', ready: false },
  { id: 'explicit-stale-all', user: 'live', machine: 'stale', forced: 'all', expected: 'all', ready: false },
  { id: 'no-valid-target', user: 'stale', machine: 'none', forced: '', expected: 'CurrentUser', ready: false },
  { id: 'no-registration', user: 'none', machine: 'none', forced: '', expected: 'CurrentUser', ready: false },
  { id: 'inner-with-administrator-user-install', user: 'live', machine: 'live', forced: '', expected: 'all', ready: true, inner: true },
  { id: 'inner-machine-target-missing', user: 'live', machine: 'stale', forced: '', expected: 'all', ready: false, inner: true },
  { id: 'recovered-machine-boundary', user: 'stale', machine: 'recovered', forced: '', expected: 'all', ready: true, boundary: true },
] as const;

describe.runIf(process.platform === 'win32' && existsSync(compiler))('native updater target preparation', () => {
  it('uses real installation evidence and aligns the flags consumed by silent elevation', () => {
    const buildRoot = path.join(repositoryRoot, 'build');
    mkdirSync(buildRoot, { recursive: true });
    const root = mkdtempSync(path.join(buildRoot, 'installer-update-target-'));
    const registryKey = `Software\\InstallerUpdateFixture-${randomUUID()}`;
    const userDirectory = path.join(root, '用户 安装 & %literal% $value');
    const machineDirectory = path.join(root, '机器 安装');
    const staleUser = path.join(root, 'missing-user');
    const staleMachine = path.join(root, 'missing-machine');
    const initialDirectory = path.join(root, 'initial-selection');
    for (const directory of [userDirectory, machineDirectory, initialDirectory]) mkdirSync(directory);
    for (const directory of [userDirectory, machineDirectory]) {
      writeFileSync(path.join(directory, 'UpdateFixture.exe'), 'fixture executable');
      writeFileSync(path.join(directory, 'Uninstall UpdateFixture.exe'), 'fixture uninstaller');
    }
    const directoryFor = (scope: 'user' | 'machine', state: string): string => state === 'live' || state === 'recovered'
      ? (scope === 'user' ? userDirectory : machineDirectory)
      : (scope === 'user' ? staleUser : staleMachine);
    try {
      const initializers = scenarios.flatMap(scenario => [
        `\${If} $ProbeCase == "${scenario.id}"`,
        `  StrCpy $ProbeForced "${scenario.forced}"`,
        `  StrCpy $ProbeInner "${Number('inner' in scenario && scenario.inner)}"`,
        `  StrCpy $ProbeBoundary "${Number('boundary' in scenario && scenario.boundary)}"`,
        `  StrCpy $hasPerUserInstallation "${Number(scenario.user !== 'none')}"`,
        `  StrCpy $hasPerMachineInstallation "${Number(scenario.machine !== 'none')}"`,
        ...(['user', 'machine'] as const).flatMap(scope => scenario[scope] === 'none' ? [] : [
          `  WriteRegStr HKCU "\${INSTALL_REGISTRY_KEY}\\${scope}" InstallLocation "${nsisPath(scenario[scope] === 'recovered' ? staleMachine : directoryFor(scope, scenario[scope]))}"`,
        ]),
        ...(scenario.machine === 'recovered' ? [
          `  WriteRegStr HKCU "\${UNINSTALL_REGISTRY_KEY}\\machine" UninstallString '$\\"${nsisPath(path.join(machineDirectory, 'Uninstall UpdateFixture.exe'))}$\\" /allusers'`,
        ] : []),
        '${EndIf}',
      ]);
      const source = [
        'Unicode true', 'SilentInstall silent', 'RequestExecutionLevel user',
        `OutFile "${nsisPath(path.join(root, 'update.exe'))}"`, 'Name "Update target fixture"',
        '!include "LogicLib.nsh"', '!include "FileFunc.nsh"',
        '!define APP_EXECUTABLE_FILENAME "UpdateFixture.exe"', '!define UNINSTALL_FILENAME "Uninstall UpdateFixture.exe"',
        `!define INSTALL_REGISTRY_KEY "${registryKey}"`, `!define UNINSTALL_REGISTRY_KEY "${registryKey}\\uninstall"`,
        '!define isForCurrentUser \'$ProbeForced == "CurrentUser"\'', '!define isForAllUsers \'$ProbeForced == "all"\'',
        ...['InstallerCombinedMode', 'InstallerCombinedLockedMode', 'InstallerCombinedForcedMode',
          'InstallerCombinedUpgradeReady', 'InstallerUpgradeDirectory', 'installMode',
          'hasPerUserInstallation', 'hasPerMachineInstallation', 'ProbeCase', 'ProbeForced', 'ProbeInner', 'ProbeBoundary'].map(name => `Var ${name}`),
        '!macro JustDoLogInstallEvent TEXT', '!macroend',
        sourceMacro('InstallerSetupSave'), sourceMacro('InstallerSetupRestore'),
        '!macro setInstallModePerUser', '  StrCpy $installMode "CurrentUser"', '  SetShellVarContext current',
        '  ReadRegStr $INSTDIR HKCU "${INSTALL_REGISTRY_KEY}\\user" InstallLocation', '!macroend',
        '!macro setInstallModePerAllUsers', '  StrCpy $installMode "all"', '  SetShellVarContext all',
        '  ReadRegStr $INSTDIR HKCU "${INSTALL_REGISTRY_KEY}\\machine" InstallLocation', '!macroend',
        isolateRegistry(lookup), sourceFunction(setup, 'InstallerCombinedResolveUpgradeMode'),
        sourceFunction(setup, 'InstallerCombinedPrepareUpgradeMode'),
        sourceFunction(setup, 'InstallerCombinedApplyUpgradeMode'),
        sourceFunction(installer, 'InstallerRestoreUpgradeDirectory'),
        'Function .onInit', '  SetRegView 64', '  DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"',
        '  ${GetParameters} $0', '  ${GetOptions} $0 "/case=" $ProbeCase',
        // A subsequent preparation must clear a formerly ready selection.
        '  StrCpy $InstallerCombinedUpgradeReady "1"', '  StrCpy $InstallerCombinedLockedMode "all"',
        '  StrCpy $installMode "CurrentUser"', `  StrCpy $INSTDIR "${nsisPath(initialDirectory)}"`,
        ...initializers, 'FunctionEnd',
        'Section', '  ${If} $ProbeInner == "1"',
        '    StrCpy $InstallerCombinedMode "all"', '    Call InstallerCombinedApplyUpgradeMode',
        '  ${Else}', '    Call InstallerCombinedPrepareUpgradeMode', '  ${EndIf}',
        '  ${If} $ProbeBoundary == "1"',
        // The upstream silent section reapplies the raw registry directory.
        '    !insertmacro setInstallModePerAllUsers',
        `    \${If} $INSTDIR != "${nsisPath(staleMachine)}"`, '      SetErrorLevel 2', '      Quit', '    ${EndIf}',
        '    Call InstallerRestoreUpgradeDirectory', '  ${EndIf}',
        `  FileOpen $3 "${nsisPath(path.join(root, 'result.txt'))}" w`,
        String.raw`  FileWriteUTF16LE $3 "$InstallerCombinedUpgradeReady$\t$InstallerCombinedMode$\t$installMode$\t$INSTDIR$\t$hasPerUserInstallation$\t$hasPerMachineInstallation"`,
        '  FileClose $3', '  DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"', 'SectionEnd',
      ].join('\n');
      const script = path.join(root, 'update.nsi');
      writeFileSync(script, source);
      const compilation = spawnSync(compiler, ['/WX', '/V2', '/INPUTCHARSET', 'UTF8', script], {
        encoding: 'utf8', windowsHide: true, timeout: 15_000,
      });
      expect(compilation.status, `${compilation.stdout}\n${compilation.stderr}`).toBe(0);
      for (const scenario of scenarios) {
        const run = spawnSync(path.join(root, 'update.exe'), [`/case=${scenario.id}`], { windowsHide: true, timeout: 10_000 });
        expect(run.status, scenario.id).toBe(0);
        const selected = scenario.ready || scenario.forced !== '' || 'inner' in scenario;
        const selectedScope = scenario.expected === 'all' ? 'machine' : 'user';
        const expectedDirectory = selected ? directoryFor(selectedScope, scenario[selectedScope]) : initialDirectory;
        expect(readFileSync(path.join(root, 'result.txt'), 'utf16le'), scenario.id).toBe([
          Number(scenario.ready), scenario.expected, scenario.expected, expectedDirectory,
          scenario.ready ? Number(scenario.expected === 'CurrentUser') : Number(scenario.user !== 'none'),
          scenario.ready ? Number(scenario.expected === 'all') : Number(scenario.machine !== 'none'),
        ].join('\t'));
      }
    } finally {
      spawnSync('reg.exe', ['delete', `HKCU\\${registryKey}`, '/f', '/reg:64'], { windowsHide: true, stdio: 'ignore', timeout: 5_000 });
      expect(path.dirname(path.resolve(root))).toBe(buildRoot);
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
