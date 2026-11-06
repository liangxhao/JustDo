import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(__dirname, '../..');
const cacheRoot = process.env.ELECTRON_BUILDER_CACHE ||
  path.join(process.env.LOCALAPPDATA || '', 'electron-builder/Cache');
const compiler = [
  process.env.JUSTDO_TEST_MAKENSIS,
  path.join(cacheRoot, 'nsis/nsis-3.0.4.1/makensis.exe'),
  path.join(cacheRoot, 'nsis/nsis-3.0.4.1/Bin/makensis.exe'),
].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
const installer = readFileSync(
  path.join(repositoryRoot, 'scripts/packaging/nsis-installer.nsh'), 'utf8',
).replaceAll('\r\n', '\n');

function installerMacro(name: string): string {
  const result = installer.match(new RegExp(`!macro ${name}\\b[^]*?!macroend`));
  if (!result) throw new Error(`Installer macro missing: ${name}`);
  return result[0];
}

function installerFunction(name: string): string {
  const result = installer.match(new RegExp(`Function ${name}\\b[^]*?FunctionEnd`));
  if (!result) throw new Error(`Installer function missing: ${name}`);
  return result[0];
}

const nsisPath = (value: string): string => value.replaceAll('$', '$$');
const scenarios = [
  { label: 'ordinary current-user installation', inner: false, admin: false, silent: false, sameAccount: true },
  { label: 'silent elevated outer invocation', inner: false, admin: true, silent: true, sameAccount: true },
  { label: 'same-account elevated inner installation', inner: true, admin: true, silent: false, sameAccount: true },
  { label: 'cross-account elevated inner installation', inner: true, admin: true, silent: false, sameAccount: false },
  { label: 'cross-account silent elevated inner upgrade', inner: true, admin: true, silent: true, sameAccount: false },
];

describe.runIf(process.platform === 'win32' && Boolean(compiler))('installer initiating-user log ownership', () => {
  it.each(scenarios)('keeps early and later logs together for $label', scenario => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'installer-user-path-'));
    try {
      const initiatingProfile = path.join(root, '桌面账户 %literal% & !');
      const credentialProfile = scenario.sameAccount ? initiatingProfile : path.join(root, '管理员账户');
      const initiatingRoaming = path.join(initiatingProfile, 'Roaming');
      const initiatingLocal = path.join(initiatingProfile, 'Local');
      const initiatingTemp = path.join(initiatingProfile, 'Temp');
      const credentialRoaming = path.join(credentialProfile, 'Roaming');
      const directoryName = 'ReviewFixture';
      const logDirectory = path.join(initiatingRoaming, directoryName);
      mkdirSync(logDirectory, { recursive: true });
      for (const name of ['install-timing.log', 'install-resource.log']) {
        writeFileSync(path.join(logDirectory, name), 'previous-session\r\n');
      }
      // Keep the production initialization bodies. Substitute only account
      // folder inputs and UAC results; the fixture never elevates or installs.
      const preInit = installerMacro('preInit')
        .replaceAll('${UAC_IsInnerInstance}', `${Number(scenario.inner)} == 1`)
        .replaceAll('${UAC_IsAdmin}', `${Number(scenario.admin)} == 1`)
        .replaceAll('${Silent}', `${Number(scenario.silent)} == 1`)
        .replace('"$APPDATA"', `"${nsisPath(credentialRoaming)}"`)
        .replace('"$LOCALAPPDATA"', `"${nsisPath(path.join(credentialProfile, 'Local'))}"`)
        .replace('"$TEMP"', `"${nsisPath(path.join(credentialProfile, 'Temp'))}"`)
        .replace(/^.*\$\{StdUtils\.ExecShellAsUser\}.*$/m, 'StrCpy $1 "unexpected-bootstrap"');
      const customInit = installerMacro('customInit')
        .replaceAll('${UAC_IsInnerInstance}', `${Number(scenario.inner)} == 1`)
        .replaceAll('${Silent}', `${Number(scenario.silent)} == 1`)
        .replace(/^\s*ReadRegStr (\$\w+) .*$/gm, (_, variable: string) => `StrCpy ${variable} ""`);
      const body = [
        installerMacro('JustDoOpenAppendLog'),
        installerMacro('JustDoTryInstallLogDirectory'),
        installerFunction('JustDoSelectInstallLogDirectory'),
        preInit,
        customInit,
      ].join('\n');
      const variables = [...new Set(Array.from(
        body.matchAll(/\$(JustDo[A-Za-z0-9_]+|hasPerUserInstallation|hasPerMachineInstallation|installMode)/g),
        match => match[1],
      ))];
      const source = [
        '!include "FileFunc.nsh"', '!include "LogicLib.nsh"', '!include "x64.nsh"',
        'Unicode true', 'RequestExecutionLevel user', 'SilentInstall silent',
        `OutFile "${nsisPath(path.join(root, 'ownership.exe'))}"`,
        `!define PRODUCT_NAME "${directoryName}"`, '!define VERSION "review"',
        '!define APP_FILENAME "ReviewFixture"', '!define APP_EXECUTABLE_FILENAME "ReviewFixture.exe"',
        '!define INSTALL_REGISTRY_KEY "unused"', '!define UAC_SYNCREGISTERS 1',
        ...variables.map(name => `Var ${name}`),
        '!macro JustDoLogInstallEvent TEXT', 'DetailPrint "${TEXT}"', '!macroend',
        '!macro UAC_AsUser_Call KIND TARGET FLAGS',
        `StrCpy $0 "${nsisPath(initiatingRoaming)}"`,
        `StrCpy $1 "${nsisPath(initiatingLocal)}"`,
        `StrCpy $3 "${nsisPath(initiatingTemp)}"`,
        // UAC synchronization also replaces handle registers. A late sync must
        // not clobber an already opened log handle or select another profile.
        'StrCpy $2 "outer-register-value"', '!macroend',
        'Function JustDoCheckAppRunning', 'FunctionEnd', body,
        'Section',
        ...variables.map(name => `StrCpy $${name} ""`),
        '!insertmacro preInit', '!insertmacro customInit',
        ...variables.map(name => `DetailPrint "$${name}"`),
        `FileOpen $0 "${nsisPath(path.join(root, 'paths.txt'))}" w`,
        'FileWriteUTF16LE $0 "$JustDoCurrentUserAppData$\\r$\\n$JustDoCurrentUserLocalAppData$\\r$\\n$JustDoCurrentTemp$\\r$\\n$JustDoInstallLogPath$\\r$\\n$JustDoResourceLogPath$\\r$\\n"',
        'FileClose $0', 'SectionEnd',
      ].join('\n');
      const scriptPath = path.join(root, 'ownership.nsi');
      writeFileSync(scriptPath, source);
      const compilation = spawnSync(compiler!, ['/WX', '/V2', '/INPUTCHARSET', 'UTF8', scriptPath], {
        windowsHide: true, encoding: 'utf8', timeout: 15_000,
      });
      expect(compilation.status, `${compilation.stdout}\n${compilation.stderr}`).toBe(0);
      const executablePath = path.join(root, 'ownership.exe');
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const run = spawnSync(executablePath, [], { windowsHide: true, timeout: 15_000 });
        expect(run.status, String(run.error || '')).toBe(0);
        const recorded = readFileSync(path.join(root, 'paths.txt'), 'utf16le').trimEnd().split('\r\n');
        expect(recorded).toEqual([
          initiatingRoaming, initiatingLocal, initiatingTemp,
          path.join(logDirectory, 'install-timing.log'), path.join(logDirectory, 'install-resource.log'),
        ]);
      }
      const timingLog = readFileSync(path.join(logDirectory, 'install-timing.log'), 'utf8');
      const resourceLog = readFileSync(path.join(logDirectory, 'install-resource.log'), 'utf8');
      expect(timingLog).toContain('previous-session');
      expect(timingLog.match(/INSTALL SESSION START/g)).toHaveLength(2);
      expect(timingLog.match(/detected-per-user-installation/g)).toHaveLength(2);
      expect(resourceLog).toContain('previous-session');
      expect(resourceLog.match(/INSTALL SESSION START/g)).toHaveLength(2);
      if (!scenario.sameAccount) {
        expect(existsSync(credentialProfile)).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
