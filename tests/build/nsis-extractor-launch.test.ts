import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rootDirectory = path.resolve(__dirname, '../..');
const cache = process.env.ELECTRON_BUILDER_CACHE || path.join(process.env.LOCALAPPDATA || '', 'electron-builder/Cache');
const compiler = path.join(cache, 'nsis/nsis-3.0.4.1/makensis.exe');
const helper = path.join(rootDirectory, 'scripts/packaging/nsis-extractor-launch.nsh');
const electronExecutable = require('electron') as string;
const processKinds = [
  { label: 'Node', executable: process.execPath, environment: process.env },
  { label: 'Electron', executable: electronExecutable, environment: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
];

function fixture(root: string, scriptText: string, unavailableCapture = false, unavailableResource = false, missingExecutable = false, launchExecutable = process.execPath) {
  const directory = path.join(root, '目录 %literal% & 感叹! 空格');
  mkdirSync(directory);
  const scriptPath = path.join(directory, 'extract.cjs');
  const stdioPath = path.join(directory, unavailableCapture ? 'capture-directory' : 'stdio.log');
  const resourcePath = path.join(directory, unavailableResource ? 'resource-directory' : 'resource.log');
  const executablePath = path.join(root, 'launch.exe');
  writeFileSync(scriptPath, scriptText);
  if (unavailableCapture) mkdirSync(stdioPath);
  if (unavailableResource) mkdirSync(resourcePath);
  else writeFileSync(resourcePath, 'previous resource log\n');
  const executable = missingExecutable ? path.join(directory, 'missing.exe') : launchExecutable;
  const source = [
    '!include "LogicLib.nsh"',
    'Unicode true',
    'RequestExecutionLevel user',
    'SilentInstall silent',
    `OutFile "${executablePath}"`,
    `InstallDir "${directory}"`,
    'Var JustDoResourceLogPath',
    `!include "${helper}"`,
    'Section',
    '  SetOutPath $INSTDIR',
    `  StrCpy $JustDoExtractorExecutable "${executable}"`,
    `  StrCpy $JustDoExtractorCommandLine '"${executable}" "${scriptPath}" "${directory}" ""'`,
    `  StrCpy $JustDoExtractorStdioLog "${stdioPath}"`,
    `  StrCpy $JustDoResourceLogPath "${resourcePath}"`,
    '  Call JustDoLaunchResourceExtractor',
    '  FileOpen $8 "$INSTDIR\\result.log" w',
    '  FileWrite $8 "launch-error=$JustDoExtractorLaunchError$\\r$\\nstdio-error=$JustDoExtractorStdioError$\\r$\\n"',
    '  ${If} $JustDoExtractorLaunchError != ""',
    '    FileClose $8',
    '    SetErrorLevel 2',
    '    Abort',
    '  ${EndIf}',
    '  System::Call \'kernel32::WaitForSingleObject(p $JustDoExtractorProcessHandle, i 0)i.r0\'',
    '  FileWrite $8 "initial-wait=$0$\\r$\\n"',
    '  System::Call \'kernel32::WaitForSingleObject(p $JustDoExtractorProcessHandle, i -1)i.r0\'',
    '  System::Call \'kernel32::GetExitCodeProcess(p $JustDoExtractorProcessHandle, *i .r0)i.r1\'',
    '  FileWrite $8 "exit=$0$\\r$\\n"',
    '  System::Call \'kernel32::CloseHandle(p $JustDoExtractorProcessHandle)i.r1\'',
    '  Call JustDoAppendExtractorStdioLog',
    '  FileWrite $8 "copied=$JustDoExtractorStdioCopied$\\r$\\ncopy-error=$JustDoExtractorStdioCopyError$\\r$\\n"',
    '  FileClose $8',
    '  ${If} $0 != 0',
    '    SetErrorLevel 2',
    '    Abort',
    '  ${EndIf}',
    'SectionEnd',
  ].join('\n');
  const installerSource = path.join(root, 'launch.nsi');
  writeFileSync(installerSource, source);
  const compiled = spawnSync(compiler, ['/WX', '/V2', '/INPUTCHARSET', 'UTF8', installerSource], {
    encoding: 'utf8', windowsHide: true, timeout: 15_000,
  });
  expect(compiled.status, `${compiled.stdout}\n${compiled.stderr}`).toBe(0);
  return { directory, executablePath, stdioPath, resourcePath };
}

describe.runIf(process.platform === 'win32' && existsSync(compiler))('native hidden resource process launch', () => {
  it.each(processKinds)('returns while $label is running and preserves Unicode/shell-special paths and both streams', ({ executable, environment }) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-native-launch-'));
    try {
      const prepared = fixture(root, `console.log('stdout 中文', JSON.stringify(process.argv.slice(2))); console.error('stderr 中文'); setTimeout(() => {}, 400);`, false, false, false, executable);
      const result = spawnSync(prepared.executablePath, [], { windowsHide: true, timeout: 15_000, env: environment });
      expect(result.status).toBe(0);
      const details = readFileSync(path.join(prepared.directory, 'result.log'), 'utf8');
      expect(details).toContain('launch-error=\r\n');
      expect(details).toContain('initial-wait=258');
      expect(details).toContain('exit=0');
      expect(details).toContain('copied=1');
      const capture = readFileSync(prepared.stdioPath, 'utf8');
      expect(capture).toContain('stdout 中文');
      expect(capture).toContain('stderr 中文');
      expect(capture).toContain(JSON.stringify([prepared.directory, '']));
      expect(readFileSync(prepared.resourcePath, 'utf8')).toBe('previous resource log\n' + capture);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(processKinds)('captures $label parse failures before the resource script starts', ({ executable, environment }) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-native-parse-'));
    try {
      const prepared = fixture(root, `console.log('script-body-started'); function {`, false, false, false, executable);
      const result = spawnSync(prepared.executablePath, [], { windowsHide: true, timeout: 15_000, env: environment });
      expect(result.status).toBe(2);
      const capture = readFileSync(prepared.stdioPath, 'utf8');
      expect(capture).toContain('SyntaxError');
      expect(capture).toContain(path.join(prepared.directory, 'extract.cjs'));
      expect(capture).not.toContain('script-body-started\r\n');
      expect(readFileSync(prepared.resourcePath, 'utf8')).toBe('previous resource log\n' + capture);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('continues normal execution when capture or resource log creation is unavailable', () => {
    for (const [captureUnavailable, resourceUnavailable] of [[true, false], [false, true]]) {
      const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-native-log-failure-'));
      try {
        const prepared = fixture(root, `console.log('script completed');`, captureUnavailable, resourceUnavailable);
        const result = spawnSync(prepared.executablePath, [], { windowsHide: true, timeout: 15_000 });
        expect(result.status).toBe(0);
        const details = readFileSync(path.join(prepared.directory, 'result.log'), 'utf8');
        expect(details).toContain('exit=0');
        expect(details).toContain(captureUnavailable ? 'stdio-error=open-output-win32-' : 'copy-error=open-target-win32-');
        if (!captureUnavailable) expect(readFileSync(prepared.stdioPath, 'utf8')).toContain('script completed');
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  });

  it('reports the actual Win32 launch error without inventing an extractor exit code', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-native-missing-'));
    try {
      const prepared = fixture(root, '', false, false, true);
      const result = spawnSync(prepared.executablePath, [], { windowsHide: true, timeout: 15_000 });
      expect(result.status).toBe(2);
      expect(readFileSync(path.join(prepared.directory, 'result.log'), 'utf8')).toContain('launch-error=create-process-win32-2');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('copies complete UTF-8 output across buffer boundaries', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-native-large-log-'));
    try {
      const prepared = fixture(root, `process.stdout.write('中文输出'.repeat(16000) + '\\nlast record\\n');`);
      const result = spawnSync(prepared.executablePath, [], { windowsHide: true, timeout: 15_000 });
      expect(result.status).toBe(0);
      const capture = readFileSync(prepared.stdioPath, 'utf8');
      expect(Buffer.byteLength(capture)).toBeGreaterThan(65536);
      expect(capture).toContain('last record');
      expect(readFileSync(prepared.resourcePath, 'utf8')).toBe('previous resource log\n' + capture);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('preserves an unrelated .error file when finalizing with an empty progress path', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-native-progress-cleanup-'));
    try {
      const installer = readFileSync(path.join(rootDirectory, 'scripts/packaging/nsis-installer.nsh'), 'utf8');
      const onGuiEnd = installer.match(/Function \.onGUIEnd[^]*?FunctionEnd/)?.[0];
      expect(onGuiEnd).toBeTruthy();
      writeFileSync(path.join(root, '.error'), 'unrelated existing file');
      const executablePath = path.join(root, 'cleanup.exe');
      const source = [
        '!include "LogicLib.nsh"', 'Unicode true', 'RequestExecutionLevel user', 'SilentInstall silent',
        `OutFile "${executablePath}"`,
        'Var JustDoInstallTerminalState', 'Var JustDoLastInstallEvent', 'Var JustDoExtractorActive',
        'Var JustDoResourceProgressFile', 'Var JustDoExtractorTempDirectory',
        '!macro JustDoLogInstallEvent TEXT', 'DetailPrint "${TEXT}"', '!macroend',
        'Function JustDoCleanupExtractorEnvironment', 'FunctionEnd',
        'Function JustDoWriteInstallSessionEnd', 'FunctionEnd', onGuiEnd,
        'Section', `SetOutPath "${root}"`,
        'StrCpy $JustDoResourceProgressFile ""', 'StrCpy $JustDoExtractorActive "0"',
        'StrCpy $JustDoInstallTerminalState "running"', 'StrCpy $JustDoLastInstallEvent "test"',
        'StrCpy $JustDoExtractorTempDirectory ""',
        'Call .onGUIEnd', 'SectionEnd',
      ].join('\n');
      const sourcePath = path.join(root, 'cleanup.nsi');
      writeFileSync(sourcePath, source);
      const compiled = spawnSync(compiler, ['/WX', '/V2', '/INPUTCHARSET', 'UTF8', sourcePath], {
        windowsHide: true, timeout: 15_000, encoding: 'utf8',
      });
      expect(compiled.status, `${compiled.stdout}\n${compiled.stderr}`).toBe(0);
      const result = spawnSync(executablePath, [], { windowsHide: true, timeout: 15_000 });
      expect(result.status).toBe(0);
      expect(readFileSync(path.join(root, '.error'), 'utf8')).toBe('unrelated existing file');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
