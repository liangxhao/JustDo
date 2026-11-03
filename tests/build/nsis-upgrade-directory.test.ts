import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(__dirname, '../..');
const cacheRoot = process.env.ELECTRON_BUILDER_CACHE ||
  path.join(process.env.LOCALAPPDATA || '', 'electron-builder/Cache');
const compiler = [
  path.join(cacheRoot, 'nsis/nsis-3.0.4.1/makensis.exe'),
  path.join(cacheRoot, 'nsis/nsis-3.0.4.1/Bin/makensis.exe'),
].find(candidate => existsSync(candidate));
const installer = readFileSync(path.join(repositoryRoot, 'scripts/packaging/nsis-installer.nsh'), 'utf8');
const upstream = readFileSync(path.join(repositoryRoot, 'node_modules/app-builder-lib/templates/nsis/assistedInstaller.nsh'), 'utf8');

function sourceFunction(source: string, name: string): string {
  const result = source.match(new RegExp(`Function ${name}\\b[^]*?FunctionEnd`));
  if (!result) throw new Error(`Installer function missing: ${name}`);
  return result[0];
}

const nsisPath = (value: string): string => value.replaceAll('$', () => '$$');
const scenarios = [
  { id: 'fresh-current', mode: 'CurrentUser', user: false, machine: false },
  { id: 'upgrade-current', mode: 'CurrentUser', user: true, machine: true },
  { id: 'upgrade-current-zh', mode: 'CurrentUser', user: true, machine: false, language: 2052 },
  { id: 'upgrade-all-inner', mode: 'all', user: true, machine: true, inner: true },
  { id: 'fresh-all-with-user-install', mode: 'all', user: true, machine: false },
  { id: 'updated-target', mode: 'CurrentUser', user: true, machine: false },
  { id: 'switch-to-fresh', mode: 'CurrentUser', user: true, machine: false, switchMode: true },
] as const;

describe.runIf(process.platform === 'win32' && Boolean(compiler))('native installer upgrade directory policy', () => {
  it('restores exact registered targets at the write boundary and normalizes only fresh selections', () => {
    const buildRoot = path.join(repositoryRoot, 'build');
    mkdirSync(buildRoot, { recursive: true });
    const root = mkdtempSync(path.join(buildRoot, 'installer-directory-policy-'));
    const registryKey = `Software\\InstallerDirectoryFixture-${randomUUID()}`;
    const registeredUser = path.join(root, '已安装 软件 & %value% $literal', 'Legacy User Folder');
    const registeredMachine = path.join(root, '机器 软件', 'Legacy Machine Folder');
    const candidate = path.join(root, 'command-line override');
    const selection = path.join(root, 'new selection');
    for (const directory of [registeredUser, registeredMachine, candidate, selection]) {
      mkdirSync(directory, { recursive: true });
    }
    try {
      // Exercise the final target authority used after the combined page.
      // Registry ports are isolated. The actual combined-page fixture owns
      // UI locking, draft switching and updater-page skipping checks.
      const policy = [
        sourceFunction(installer, 'InstallerRestoreUpgradeDirectory')
          .replace('HKLM "${INSTALL_REGISTRY_KEY}"', 'HKCU "${INSTALL_REGISTRY_KEY}\\machine"')
          .replace('HKCU "${INSTALL_REGISTRY_KEY}"', 'HKCU "${INSTALL_REGISTRY_KEY}\\user"'),
        sourceFunction(installer, 'JustDoInstFilesPre')
          .replaceAll('${UAC_IsInnerInstance}', '$ProbeInner == "1"'),
        sourceFunction(upstream, 'instFilesPre'),
      ].join('\n');
      const initializers = scenarios.flatMap(scenario => [
        `\${If} $ProbeCase == "${scenario.id}"`,
        `  StrCpy $installMode "${scenario.mode}"`,
        `  StrCpy $LANGUAGE ${'language' in scenario ? scenario.language : 1033}`,
        `  StrCpy $ProbeInner ${Number('inner' in scenario && scenario.inner)}`,
        `  StrCpy $ProbeSwitch ${Number('switchMode' in scenario && scenario.switchMode)}`,
        ...(scenario.user ? [`  WriteRegStr HKCU "\${INSTALL_REGISTRY_KEY}\\user" InstallLocation "${nsisPath(registeredUser)}"`] : []),
        ...(scenario.machine ? [`  WriteRegStr HKCU "\${INSTALL_REGISTRY_KEY}\\machine" InstallLocation "${nsisPath(registeredMachine)}"`] : []),
        '${EndIf}',
      ]);
      const source = [
        'Unicode true', 'SilentInstall silent', 'RequestExecutionLevel user',
        '!include "LogicLib.nsh"', '!include "FileFunc.nsh"',
        `!include "${path.join(repositoryRoot, 'node_modules/app-builder-lib/templates/nsis/include/StrContains.nsh')}"`,
        `OutFile "${nsisPath(path.join(root, 'directory.exe'))}"`,
        'Name "Directory policy fixture"', '!define APP_FILENAME "DirectoryFixture"',
        '!define allowToChangeInstallationDirectory',
        `!define INSTALL_REGISTRY_KEY "${registryKey}"`,
        ...['InstallerUpgradeDirectory', 'InstallerCombinedLockedMode', 'InstallerCombinedMode',
          'installMode', 'JustDoInstallMode', 'ProbeCase', 'ProbeInner', 'ProbeSwitch', 'ProbeProcessChecks']
          .map(name => `Var ${name}`),
        '!macro JustDoLogInstallEvent TEXT', '  DetailPrint "${TEXT}"', '!macroend',
        'Function JustDoCheckAppRunning', '  IntOp $ProbeProcessChecks $ProbeProcessChecks + 1', 'FunctionEnd',
        policy,
        'Function .onInit', '  SetRegView 64',
        '  ${GetParameters} $0', '  ${GetOptions} $0 "/case=" $ProbeCase',
        '  DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"', '  StrCpy $ProbeProcessChecks 0',
        '  StrCpy $InstallerCombinedLockedMode ""',
        `  StrCpy $INSTDIR "${nsisPath(candidate)}"`, ...initializers, 'FunctionEnd',
        'Section', '  Call InstallerRestoreUpgradeDirectory',
        `  FileOpen $3 "${nsisPath(path.join(root, 'result.txt'))}" w`,
        String.raw`  FileWriteUTF16LE $3 "initial$\t$INSTDIR$\t$installMode$\r$\n"`,
        '  ${If} $ProbeSwitch == "1"', '    StrCpy $installMode "all"', '  ${EndIf}',
        // A late edit must not redirect a registered upgrade.
        `  StrCpy $INSTDIR "${nsisPath(selection)}"`, '  Call JustDoInstFilesPre',
        String.raw`  FileWriteUTF16LE $3 "final$\t$INSTDIR$\t$JustDoInstallMode$\t$ProbeProcessChecks$\r$\n"`,
        '  FileClose $3', '  DeleteRegKey HKCU "${INSTALL_REGISTRY_KEY}"', '  SetErrorLevel 0', 'SectionEnd',
      ].join('\n');
      const scriptPath = path.join(root, 'directory.nsi');
      writeFileSync(scriptPath, source);
      const compilation = spawnSync(compiler!, ['/WX', '/V2', '/INPUTCHARSET', 'UTF8', scriptPath], {
        encoding: 'utf8', windowsHide: true, timeout: 15_000,
      });
      expect(compilation.status, `${compilation.stdout}\n${compilation.stderr}`).toBe(0);
      for (const scenario of scenarios) {
        const run = spawnSync(path.join(root, 'directory.exe'), [`/case=${scenario.id}`], {
          windowsHide: true, timeout: 10_000,
        });
        expect(run.status, `${scenario.id}: ${run.stdout}\n${run.stderr}`).toBe(0);
        const selectedMode = 'switchMode' in scenario && scenario.switchMode ? 'all' : scenario.mode;
        const initial = scenario.mode === 'all'
          ? (scenario.machine ? registeredMachine : candidate)
          : (scenario.user ? registeredUser : candidate);
        const registered = selectedMode === 'all'
          ? (scenario.machine ? registeredMachine : '')
          : (scenario.user ? registeredUser : '');
        const lines = readFileSync(path.join(root, 'result.txt'), 'utf16le').trim().split(/\r?\n/);
        expect(lines, scenario.id).toEqual([
          `initial\t${initial}\t${scenario.mode}`,
          `final\t${registered || path.join(selection, 'DirectoryFixture')}\t${selectedMode}\t${Number('inner' in scenario && scenario.inner)}`,
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
