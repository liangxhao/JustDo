import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const cache = process.env.ELECTRON_BUILDER_CACHE || path.join(process.env.LOCALAPPDATA || '', 'electron-builder/Cache');
const compiler = path.join(cache, 'nsis/nsis-3.0.4.1/makensis.exe');
const sevenZip = path.join(path.dirname(require.resolve('7zip-bin/package.json')), 'win/ia32/7za.exe');

function compileFixture(root: string, directory: string, section: string[]): string {
  const executable = path.join(root, 'shell-extraction-test.exe');
  const source = [
    '!include "LogicLib.nsh"',
    'Unicode true',
    'RequestExecutionLevel user',
    'SilentInstall silent',
    '!pragma warning disable 6010', // This fixture exercises one helper entry point at a time.
    `OutFile "${executable}"`,
    `InstallDir "${directory}"`,
    'Var JustDoResourceLogPath',
    'Var JustDoExtractorActive',
    'Var JustDoNativeProgressBar',
    '!define JUSTDO_PBM_SETRANGE32 0x0406',
    '!define JUSTDO_PBM_SETPOS 0x0402',
    '!macro JustDoSetInstallStatus ZH EN',
    '  DetailPrint "${EN}"',
    '!macroend',
    '!macro JustDoLogInstallEvent TEXT',
    '  DetailPrint "${TEXT}"',
    '!macroend',
    `!include "${path.join(repoRoot, 'scripts/packaging/nsis-extractor-launch.nsh')}"`,
    `!include "${path.join(repoRoot, 'scripts/packaging/nsis-shell-extraction.nsh')}"`,
    'Section',
    '  SetOutPath $INSTDIR',
    '  StrCpy $JustDoResourceLogPath ""',
    '  StrCpy $JustDoExtractorActive "0"',
    '  StrCpy $JustDoNativeProgressBar "0"',
    '  StrCpy $InstallerShellExecutable ""',
    '  StrCpy $InstallerShellArchive ""',
    '  StrCpy $InstallerShellLog ""',
    '  GetFunctionAddress $0 InstallerExtractShell',
    ...section,
    'SectionEnd',
  ].join('\n');
  const sourcePath = path.join(root, 'shell-extraction-test.nsi');
  writeFileSync(sourcePath, source);
  const result = spawnSync(compiler, ['/WX', '/V2', '/INPUTCHARSET', 'UTF8', sourcePath], {
    encoding: 'utf8', windowsHide: true, timeout: 15_000,
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return executable;
}

describe.runIf(process.platform === 'win32' && existsSync(compiler))('native application extraction progress', () => {
  it('parses bare-CR records from a live writer across bounded reads without treating paths or malformed values as progress', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'installer-shell-progress-'));
    try {
      const directory = path.join(root, '目录 %literal% & 感叹! 空格');
      mkdirSync(directory);
      const header = 'Archive C:\\100%tools\\中文 & !.7z\rPath = 88%\r 17%\r';
      const chunk = header + 'x'.repeat(1024 - Buffer.byteLength(header) - 3) + '\r 4';
      expect(Buffer.byteLength(chunk)).toBe(1024);
      writeFileSync(path.join(directory, 'capture.log'), chunk);
      const executable = compileFixture(root, directory, [
        '  StrCpy $InstallerShellLog "$INSTDIR\\capture.log"',
        '  Call InstallerResetShellProgress',
        '  FileOpen $8 "$INSTDIR\\result.log" w',
        // Keep an append-only writer open while progress reads the same file.
        '  System::Call \'kernel32::CreateFileW(w "$InstallerShellLog", i 4, i 3, p 0, i 4, i 0x80, p 0)p.r9\'',
        '  Call InstallerPollShellProgress',
        '  FileWrite $8 "first=$InstallerShellProgress offset=$InstallerShellProgressOffset$\\r$\\n"',
        '  FileWrite $9 "2%$\\rPath 99%$\\r101%$\\r1234%$\\r"',
        '  Call InstallerPollShellProgress',
        '  FileWrite $8 "split=$InstallerShellProgress$\\r$\\n"',
        '  FileWrite $9 "100%$\\r 2%$\\r"',
        '  Call InstallerPollShellProgress',
        '  FileWrite $8 "complete=$InstallerShellProgress$\\r$\\n"',
        '  FileClose $9',
        '  StrCpy $InstallerShellLog "$INSTDIR\\unavailable.log"',
        '  ClearErrors',
        '  Call InstallerPollShellProgress',
        '  ${If} ${Errors}',
        '    FileWrite $8 "progress-read-error-leaked$\\r$\\n"',
        '  ${EndIf}',
        '  FileWrite $8 "unavailable=$InstallerShellProgress$\\r$\\n"',
        '  FileClose $8',
      ]);
      const result = spawnSync(executable, [], { windowsHide: true, timeout: 15_000 });
      expect(result.status).toBe(0);
      expect(readFileSync(path.join(directory, 'result.log'), 'utf8')).toBe(
        'first=17 offset=1024\r\nsplit=42\r\ncomplete=100\r\nunavailable=100\r\n',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])('reads the real 7-Zip exit result and complete capture with corrupt archive=%s', corrupt => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'installer-shell-process-'));
    try {
      const directory = path.join(root, '安装目录 %literal% & 感叹! 空格');
      const input = path.join(root, '输入');
      mkdirSync(directory);
      mkdirSync(input);
      const filename = '应用文件 %literal% & 感叹! .txt';
      const contents = 'installed bytes 中文\n';
      writeFileSync(path.join(input, filename), contents);
      const archive = path.join(directory, '应用 %archive% & !.7z');
      if (corrupt) {
        writeFileSync(archive, 'invalid archive');
      } else {
        const packed = spawnSync(sevenZip, ['a', '-y', '-mx=0', archive, path.join(input, filename)], {
          encoding: 'utf8', windowsHide: true, timeout: 15_000,
        });
        expect(packed.status, `${packed.stdout}\n${packed.stderr}`).toBe(0);
      }
      const stagedExecutable = path.join(directory, 'shell-extractor.exe');
      copyFileSync(sevenZip, stagedExecutable);
      writeFileSync(path.join(directory, 'resource.log'), 'previous resource records\n');
      const executable = compileFixture(root, directory, [
        '  StrCpy $InstallerShellExecutable "$INSTDIR\\shell-extractor.exe"',
        `  StrCpy $InstallerShellArchive "$INSTDIR\\${path.basename(archive)}"`,
        '  StrCpy $InstallerShellLog "$INSTDIR\\capture.log"',
        '  StrCpy $JustDoResourceLogPath "$INSTDIR\\resource.log"',
        // A trailing separator must remain literal in the child command line.
        '  StrCpy $INSTDIR "$INSTDIR\\"',
        '  Call InstallerExtractShell',
        '  FileOpen $8 "$INSTDIR\\result.log" w',
        '  FileWrite $8 "exit=$InstallerShellExitCode$\\r$\\nprogress=$InstallerShellProgress$\\r$\\nactive=$JustDoExtractorActive$\\r$\\nhandle=$JustDoExtractorProcessHandle$\\r$\\ncopied=$JustDoExtractorStdioCopied$\\r$\\n"',
        '  FileClose $8',
      ]);
      const result = spawnSync(executable, [], { windowsHide: true, timeout: 15_000 });
      expect(result.status).toBe(0);
      const details = readFileSync(path.join(directory, 'result.log'), 'utf8');
      expect(details).toContain(`exit=${corrupt ? 2 : 0}\r\n`);
      expect(details).toContain('active=0\r\nhandle=0\r\ncopied=1\r\n');
      const capture = readFileSync(path.join(directory, 'capture.log'), 'utf8');
      expect(capture).toContain(corrupt ? 'ERROR' : 'Everything is Ok');
      expect(readFileSync(path.join(directory, 'resource.log'), 'utf8')).toBe('previous resource records\n' + capture);
      if (corrupt) {
        expect(details).not.toContain('progress=100\r\n');
        expect(existsSync(path.join(directory, filename))).toBe(false);
      } else {
        expect(details).toContain('progress=100\r\n');
        expect(readFileSync(path.join(directory, filename), 'utf8')).toBe(contents);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
