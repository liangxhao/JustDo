import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { afterEach, expect, test } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const helperPath = path.join(repoRoot, 'scripts/packaging/nsis-process-helper.ps1');
const nsisCache = process.env.ELECTRON_BUILDER_CACHE || path.join(process.env.LOCALAPPDATA || '', 'electron-builder/Cache');
const compiler = path.join(nsisCache, 'nsis/nsis-3.0.4.1/makensis.exe');
const children: ChildProcess[] = [];
const directories: string[] = [];

const exited = (child: ChildProcess) => new Promise<number | null>(resolve => {
  if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
  else child.once('exit', resolve);
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    const done = exited(child);
    if (child.exitCode === null) child.kill();
    await done;
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

const fixture = () => {
  const base = path.join(repoRoot, 'build/installer-shutdown-tests');
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(path.join(base, 'process-'));
  directories.push(directory);
  const installRoot = path.join(directory, '安装 目录');
  mkdirSync(installRoot);
  const executable = path.join(installRoot, 'probe.exe');
  copyFileSync(process.execPath, executable);
  const compiled = ts.transpileModule(readFileSync(path.join(repoRoot,
    'src/main/core/app/installerShutdown.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const listenerModule = path.join(directory, 'listener.cjs');
  writeFileSync(listenerModule, compiled);
  return { directory, installRoot, executable, listenerModule };
};

const start = async (executable: string, code: string, args: string[] = []) => {
  const child = spawn(executable, ['-e', code, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    let output = '';
    child.once('error', reject);
    child.once('exit', exit => reject(new Error(`Fixture exited before ready: ${exit}`)));
    child.stdout!.on('data', data => {
      output += data.toString();
      if (output.includes('ready')) resolve();
    });
  });
  return child;
};

const helper = (installRoot: string, action: string) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', helperPath, '-Action', action, '-MaxAttempts', '1'], {
    windowsHide: true,
    env: { ...process.env, JUSTDO_INSTALL_ROOT: installRoot, JUSTDO_CALLER_PID: String(process.pid), JUSTDO_APP_PROCESS_NAME: 'probe' },
  });
  let output = '';
  child.stdout.on('data', data => { output += data.toString(); });
  child.stderr.on('data', data => { output += data.toString(); });
  child.once('error', reject);
  child.once('close', code => resolve({ code, output }));
});

test.runIf(process.platform === 'win32')('signals existing Main without touching another installation and waits for scoped children', async () => {
  const f = fixture();
  const portableRoot = f.installRoot + '-portable';
  mkdirSync(portableRoot);
  const portableExe = path.join(portableRoot, 'probe.exe');
  copyFileSync(process.execPath, portableExe);
  const portable = await start(portableExe, 'setInterval(() => {}, 1000); console.log("ready");');
  const worker = await start(f.executable, 'setInterval(() => {}, 1000); console.log("ready");');
  const main = await start(f.executable,
    'setInterval(() => {}, 1000); const listener = require(process.argv[1]).createInstallerShutdownListener(() => process.exit(0)); listener.ready.then(() => console.log("ready"));',
    [f.listenerModule]);
  const mainExited = exited(main);
  const request = await helper(f.installRoot, 'RequestQuit');
  expect(request.code, request.output).toBe(0);
  expect(await mainExited).toBe(0);
  expect((await helper(f.installRoot, 'Wait')).code).toBe(1);
  const stopped = await helper(f.installRoot, 'Stop');
  expect(stopped.code, stopped.output).toBe(0);
  await exited(worker);
  expect(portable.exitCode).toBeNull();
  expect((await helper(f.installRoot, 'RequestQuit')).code).toBe(1);
}, 30_000);

test.runIf(process.platform === 'win32')('reports legacy processes as unsupported and does not launch a new instance', async () => {
  const f = fixture();
  const legacy = await start(f.executable, 'setInterval(() => {}, 1000); console.log("ready");');
  const request = await helper(f.installRoot, 'RequestQuit');
  expect(request.code, request.output).toBe(3);
  expect(legacy.exitCode).toBeNull();
  expect((await helper(f.installRoot, 'Find')).code).toBe(0);
  const stopped = await helper(f.installRoot, 'Stop');
  expect(stopped.code, stopped.output).toBe(0);
  await exited(legacy);
}, 20_000);

test.runIf(process.platform === 'win32')('requires a valid acknowledgement instead of treating a completed write as acceptance', async () => {
  const f = fixture();
  const main = await start(f.executable,
    'require("node:net").createServer(socket => socket.once("data", () => socket.end("rejected\\n"))).listen("\\\\\\\\.\\\\pipe\\\\desktop-installer-shutdown-" + process.pid, () => console.log("ready"));');
  const request = await helper(f.installRoot, 'RequestQuit');
  expect(request.code, request.output).toBe(3);
  expect(main.exitCode).toBeNull();
}, 20_000);

test.runIf(process.platform === 'win32' && existsSync(compiler))('the native auto-close branch stops installation when forced shutdown leaves a survivor', () => {
  const f = fixture();
  const installer = readFileSync(path.join(repoRoot, 'scripts/packaging/nsis-installer.nsh'), 'utf8');
  const extract = (kind: string, name: string, end: string) => {
    const match = installer.match(new RegExp(`${kind} ${name}\\b[^]*?${end}`));
    if (!match) throw new Error(`Installer source missing: ${name}`);
    return match[0];
  };
  // Run the actual interactive branch unattended; only the user's Yes and the
  // process API results are supplied by the fixture. It writes no app payload.
  const check = extract('Function', 'JustDoCheckAppRunning', 'FunctionEnd')
    .replace('${If} ${Silent}', '${If} 0 == 1')
    .replace(/MessageBox MB_YESNOCANCEL[^\r\n]*/, 'StrCmp 1 1 JustDoInstallAutoClose JustDoInstallProcessRetry');
  const literal = (value: string) => value.replaceAll('$', () => '$$');
  const output = path.join(f.directory, 'check.exe');
  const marker = path.join(f.directory, 'continued.txt');
  const source = [
    'Unicode true', 'RequestExecutionLevel user', 'SilentInstall silent',
    `OutFile "${literal(output)}"`, '!include "LogicLib.nsh"', '!include "FileFunc.nsh"',
    `!define PROJECT_DIR "${literal(repoRoot)}"`, '!define PRODUCT_NAME "Fixture"',
    '!define APP_GUID "installer-shutdown-fixture"',
    '!define JUSTDO_LANG_SIMPCHINESE 2052', '!define JUSTDO_LANG_TRADCHINESE 1028',
    '!define INSTALLER_SHUTDOWN_ATTEMPTS 1',
    ...['JustDoProcessCheckComplete', 'JustDoPristineInstall', 'JustDoInstallTerminalState',
      'JustDoCoreInstallStartedTick', 'JustDoInstFilesPage', 'StopResult'].map(name => `Var ${name}`),
    '!macro JustDoLogInstallEvent TEXT', 'DetailPrint "${TEXT}"', '!macroend',
    '!macro FindJustDoProcesses RESULT', 'StrCpy ${RESULT} 0', '!macroend',
    '!macro RequestInstallerQuit RESULT', 'StrCpy ${RESULT} 3', '!macroend',
    '!macro WaitForJustDoProcesses RESULT ATTEMPTS', 'StrCpy ${RESULT} 1', '!macroend',
    extract('!macro', 'RequestAndWaitForInstallerQuit', '!macroend'),
    '!macro StopJustDoProcesses RESULT', 'StrCpy ${RESULT} $StopResult', '!macroend',
    '!macro JustDoSetInstallStatus ZH EN', 'DetailPrint "${EN}"', '!macroend',
    '!macro JustDoAddInstallActivity ZH EN', 'DetailPrint "${EN}"', '!macroend',
    'Function InstallerPresentationSetStage', 'Pop $0', 'FunctionEnd', check,
    'Function .onInit', `StrCpy $INSTDIR "${literal(f.installRoot)}"`, 'StrCpy $JustDoInstFilesPage 0',
    '${GetParameters} $0', '${GetOptions} $0 "/stop=" $StopResult', 'FunctionEnd',
    'Section', 'Call JustDoCheckAppRunning',
    `FileOpen $0 "${literal(marker)}" w`, 'FileWrite $0 "continued"', 'FileClose $0', 'SectionEnd',
  ].join('\n');
  const script = path.join(f.directory, 'check.nsi');
  writeFileSync(script, source);
  const compiled = spawnSync(compiler, ['/WX', '/V2', '/INPUTCHARSET', 'UTF8', script], {
    encoding: 'utf8', windowsHide: true, timeout: 20_000,
  });
  expect(compiled.status, compiled.stdout + compiled.stderr).toBe(0);
  const failed = spawnSync(output, ['/stop=1'], { windowsHide: true, timeout: 10_000 });
  expect(failed.status, String(failed.error)).toBe(2);
  expect(existsSync(marker)).toBe(false);
  const closed = spawnSync(output, ['/stop=0'], { windowsHide: true, timeout: 10_000 });
  expect(closed.status, String(closed.error)).toBe(0);
  expect(readFileSync(marker, 'utf8')).toBe('continued');
}, 45_000);
