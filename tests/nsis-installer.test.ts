import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { create as createTar } from 'tar';
import { afterEach, describe, expect, it } from 'vitest';

const nsisScript = readFileSync(path.resolve(__dirname, '../scripts/nsis-installer.nsh'), 'utf8');
const unpackScriptPath = path.resolve(__dirname, '../scripts/unpack-cfmind.cjs');
const unpackScript = readFileSync(unpackScriptPath, 'utf8');
const processHelper = readFileSync(
  path.resolve(__dirname, '../scripts/nsis-process-helper.ps1'),
  'utf8',
);
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Windows uninstaller process handling', () => {
  it('excludes the uninstaller process from installed-process detection', () => {
    expect(nsisScript).toContain('Kernel32::GetCurrentProcessId()');
    expect(processHelper).toContain('$_.ProcessId -ne $callerPid');
  });

  it('prompts interactive users to close the running app and retry', () => {
    expect(nsisScript).toContain('MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION');
    expect(nsisScript).toContain('正在运行。请先关闭应用');
    expect(nsisScript).toContain('is currently running. Close the app');
    expect(nsisScript).toMatch(
      /\$\{If\} \$\{Silent\}[\s\S]*StopJustDoProcesses[\s\S]*\$\{Else\}[\s\S]*FindJustDoProcesses/,
    );
  });
});

describe('Windows installer process handling', () => {
  it('keeps the automatic-close, manual-retry, and cancel choices', () => {
    expect(nsisScript).toContain('MessageBox MB_YESNOCANCEL|MB_ICONEXCLAMATION');
    expect(nsisScript).toContain('IDYES JustDoInstallAutoClose');
    expect(nsisScript).toContain('IDNO JustDoInstallProcessRetry');
    expect(nsisScript).toContain('点击“是”：自动关闭旧版并继续安装');
    expect(nsisScript).toContain('点击“否”：我已从系统托盘手动退出，重新检测');
  });

  it('matches and stops only processes inside the selected installation root', () => {
    expect(nsisScript).toContain('JUSTDO_INSTALL_ROOT');
    expect(nsisScript).toContain('justdo-process-helper.ps1');
    expect(nsisScript).toContain('-File "$PLUGINSDIR\\justdo-process-helper.ps1" -Action Find');
    expect(processHelper).toContain('[IO.Path]::GetFullPath($_.ExecutablePath).StartsWith(');
    expect(nsisScript).toContain('!insertmacro FindJustDoProcesses $0');
    expect(nsisScript).toContain('!insertmacro WaitForJustDoProcesses $0 20');
    expect(nsisScript).toContain('!insertmacro StopJustDoProcesses $0');
    expect(nsisScript).not.toContain('nsProcess::FindProcess');
    expect(nsisScript).not.toContain('nsProcess::KillProcess');
    expect(processHelper).toContain('Stop-Process -Id $_.ProcessId -Force');
  });

  it('does not continue silently when scoped process inspection fails', () => {
    expect(nsisScript).toContain(
      'Abort "Setup could not inspect processes in the installation directory."',
    );
    expect(nsisScript).toContain('JustDoInstallInspectionFailed:');
    expect(nsisScript).toContain('安装程序无法确认 ${PRODUCT_NAME} 是否已关闭');
    expect(nsisScript).toContain('Setup could not verify whether ${PRODUCT_NAME} has closed.');
  });

  it('runs process checks from a script file instead of a fragile inline command', () => {
    expect(nsisScript).toContain('/TIMEOUT=15000');
    expect(nsisScript).toContain('/TIMEOUT=90000');
    expect(nsisScript).not.toContain('-Command "');
    expect(processHelper).toContain("[ValidateSet('Find', 'Wait', 'Stop')]");
    expect(processHelper).toContain('$attempt -lt $MaxAttempts');
  });

  it('removes the previous Git runtime before extracting MinGit during upgrades', () => {
    const backupIndex = unpackScript.indexOf('fs.renameSync(minGitDir, minGitBackupDir)');
    const extractionIndex = unpackScript.indexOf('tar.extract({');

    expect(backupIndex).toBeGreaterThan(-1);
    expect(extractionIndex).toBeGreaterThan(backupIndex);
    expect(unpackScript).toContain("const minGitDir = path.join(destDir, 'mingit')");
    expect(unpackScript).toContain(
      "const minGitBackupDir = path.join(destDir, '.mingit-upgrade-backup')",
    );
    expect(unpackScript).toContain('MinGit extraction is missing a non-empty git.exe');
  });

  it('does not retain PortableGit files in an upgraded installation', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-mingit-upgrade-'));
    tempDirs.push(root);
    const archiveRoot = path.join(root, 'archive');
    const installResources = path.join(root, 'installed-resources');
    const archivePath = path.join(root, 'win-resources.tar');
    const staleBashPath = path.join(installResources, 'mingit', 'bin', 'bash.exe');
    const installedGitPath = path.join(installResources, 'mingit', 'cmd', 'git.exe');

    mkdirSync(path.join(archiveRoot, 'cfmind'), { recursive: true });
    mkdirSync(path.join(archiveRoot, 'mingit', 'cmd'), { recursive: true });
    mkdirSync(path.dirname(staleBashPath), { recursive: true });
    writeFileSync(path.join(archiveRoot, 'cfmind', 'package.json'), '{}');
    writeFileSync(path.join(archiveRoot, 'mingit', 'cmd', 'git.exe'), 'mingit');
    writeFileSync(staleBashPath, 'portable-git');
    createTar({ cwd: archiveRoot, file: archivePath, sync: true }, ['cfmind', 'mingit']);

    const result = spawnSync(process.execPath, [unpackScriptPath, archivePath, installResources], {
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(installedGitPath)).toBe(true);
    expect(existsSync(staleBashPath)).toBe(false);
    expect(existsSync(path.join(installResources, '.mingit-upgrade-backup'))).toBe(false);
  });

  it('restores PortableGit when the replacement archive is invalid', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-mingit-rollback-'));
    tempDirs.push(root);
    const installResources = path.join(root, 'installed-resources');
    const archivePath = path.join(root, 'invalid-resources.tar');
    const staleBashPath = path.join(installResources, 'mingit', 'bin', 'bash.exe');

    mkdirSync(path.dirname(staleBashPath), { recursive: true });
    writeFileSync(staleBashPath, 'portable-git');
    writeFileSync(archivePath, 'not a tar archive');

    const result = spawnSync(process.execPath, [unpackScriptPath, archivePath, installResources], {
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(existsSync(staleBashPath)).toBe(true);
    expect(existsSync(path.join(installResources, '.mingit-upgrade-backup'))).toBe(false);
  });

  it('rejects a resource archive without git.exe and restores PortableGit', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-mingit-missing-git-'));
    tempDirs.push(root);
    const archiveRoot = path.join(root, 'archive');
    const installResources = path.join(root, 'installed-resources');
    const archivePath = path.join(root, 'win-resources.tar');
    const staleBashPath = path.join(installResources, 'mingit', 'bin', 'bash.exe');

    mkdirSync(path.join(archiveRoot, 'cfmind'), { recursive: true });
    mkdirSync(path.dirname(staleBashPath), { recursive: true });
    writeFileSync(path.join(archiveRoot, 'cfmind', 'package.json'), '{}');
    writeFileSync(staleBashPath, 'portable-git');
    createTar({ cwd: archiveRoot, file: archivePath, sync: true }, ['cfmind']);

    const result = spawnSync(process.execPath, [unpackScriptPath, archivePath, installResources], {
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('missing a non-empty git.exe');
    expect(existsSync(staleBashPath)).toBe(true);
  });
});

describe('Windows installer presentation', () => {
  it('uses a branded, DPI-aware install page', () => {
    expect(nsisScript).toContain('Function JustDoInstFilesShow');
    expect(nsisScript).toContain('user32::GetWindowRect');
    expect(nsisScript).toContain('user32::MapWindowPoints');
    expect(nsisScript).toContain('JUSTDO_PBM_SETBARCOLOR');
    expect(nsisScript).not.toContain('Var JustDoHeaderBackground');
    expect(nsisScript).not.toContain('CreateFont');
    expect(nsisScript).not.toContain('JUSTDO_WM_SETFONT');
    expect(nsisScript).toContain('正在安装 ${PRODUCT_NAME}，请稍候');
    expect(nsisScript).toContain('Installing ${PRODUCT_NAME}, please wait');
    expect(nsisScript).toContain('GetDlgItem $R6 $HWNDPARENT 1038\n  ShowWindow $R6 0');
    expect(nsisScript).toContain('user32::SetWindowPos(p $R5');
    expect(nsisScript).toContain('IntOp $2 $2 / 2');
    expect(nsisScript).not.toContain('正在为你准备');
    expect(nsisScript).not.toContain('安全安装');
    expect(nsisScript).toContain('ShowWindow $JustDoInstallLog 5');
    expect(nsisScript).toContain('SetCtlColors $JustDoInstallLog "4C526B" "FFFFFF"');
  });

  it('owns a monotonic stage-based progress bar instead of exposing archive resets', () => {
    expect(nsisScript).toContain('ShowWindow $JustDoNativeProgressBar 0');

    const positions = Array.from(nsisScript.matchAll(/JustDoSetInstallProgress (\d+)/g), match =>
      Number(match[1]),
    );

    expect(positions).toEqual([8, 72, 78, 92, 95, 98, 100]);
    expect(positions.every((value, index) => index === 0 || value > positions[index - 1])).toBe(
      true,
    );
  });

  it('streams real resource activity into the scrolling install feed', () => {
    expect(nsisScript).toContain('nsExec::ExecToLog');
    expect(nsisScript).toContain('JustDoAddInstallActivity');
    expect(unpackScript).toContain('onentry: () =>');
    expect(unpackScript).toContain('extractedEntries % 750 === 0');
    expect(unpackScript).toContain('resource entries ready');
    expect(unpackScript).toContain('Keep this stream ASCII-only');
    expect(unpackScript).not.toContain("activity('●");
  });

  it('reassures users while native archive extraction is busy', () => {
    expect(nsisScript).toContain('正在准备应用组件，请耐心等待');
    expect(nsisScript).toContain('安装程序正在正常运行，此步骤需要一些时间');
    expect(nsisScript).toContain('Setup is working normally. This step may take a little while.');
    expect(nsisScript).not.toContain('正在解压大型应用资源');
    expect(nsisScript).not.toContain('JustDoRefreshArchiveProgress');
  });
});
