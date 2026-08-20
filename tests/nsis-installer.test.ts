import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { create as createTar } from 'tar';
import { afterEach, describe, expect, it } from 'vitest';

const nsisScript = readFileSync(path.resolve(__dirname, '../scripts/nsis-installer.nsh'), 'utf8');
const builderHook = readFileSync(
  path.resolve(__dirname, '../scripts/electron-builder-hooks.cjs'),
  'utf8',
);
const builderConfig = JSON.parse(
  readFileSync(path.resolve(__dirname, '../electron-builder.json'), 'utf8'),
) as { extraResources?: Array<{ from?: string; to?: string }> };
const unpackScriptPath = path.resolve(__dirname, '../scripts/unpack-cfmind.cjs');
const unpackScript = readFileSync(unpackScriptPath, 'utf8');
const processHelper = readFileSync(
  path.resolve(__dirname, '../scripts/nsis-process-helper.ps1'),
  'utf8',
);
const tempDirs: string[] = [];

function writePythonRuntimeFixture(runtimeRoot: string): void {
  mkdirSync(path.join(runtimeRoot, 'Scripts'), { recursive: true });
  mkdirSync(path.join(runtimeRoot, 'Lib', 'site-packages', 'pip'), { recursive: true });
  for (const importName of ['requests', 'yaml', 'openpyxl', 'pypdf', 'bs4']) {
    const importRoot = path.join(runtimeRoot, 'Lib', 'bundled-site-packages', importName);
    mkdirSync(importRoot, {
      recursive: true,
    });
    writeFileSync(path.join(importRoot, '__init__.py'), importName);
  }
  writeFileSync(path.join(runtimeRoot, 'python.exe'), 'python');
  writeFileSync(path.join(runtimeRoot, 'python3.exe'), 'python');
  writeFileSync(
    path.join(runtimeRoot, 'python312._pth'),
    'python312.zip\n.\nLib\\site-packages\nLib\\bundled-site-packages\nimport site\n',
  );
  writeFileSync(path.join(runtimeRoot, 'Scripts', 'pip.exe'), 'pip');
  writeFileSync(path.join(runtimeRoot, 'Lib', 'site-packages', 'pip', '__main__.py'), 'pip');
  writeFileSync(
    path.join(runtimeRoot, 'Lib', 'site-packages', 'sitecustomize.py'),
    'sitecustomize',
  );
}

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
    const backupIndex = unpackScript.indexOf('fs.renameSync(runtime.dir, runtime.backupDir)');
    const extractionIndex = unpackScript.indexOf('tar.extract({');

    expect(backupIndex).toBeGreaterThan(-1);
    expect(extractionIndex).toBeGreaterThan(backupIndex);
    expect(unpackScript).toContain("const minGitDir = path.join(destDir, 'mingit')");
    expect(unpackScript).toContain(
      "const minGitBackupDir = path.join(destDir, '.mingit-upgrade-backup')",
    );
    expect(unpackScript).toContain('MinGit extraction is missing a non-empty git.exe');
    expect(unpackScript).toContain("const cfmindDir = path.join(destDir, 'cfmind')");
    expect(unpackScript).toContain(
      "const cfmindBackupDir = path.join(destDir, '.cfmind-upgrade-backup')",
    );
    expect(unpackScript).toContain("const pythonDir = path.join(destDir, 'python-win')");
    expect(unpackScript).toContain(
      "const pythonBackupDir = path.join(destDir, '.python-win-upgrade-backup')",
    );
    expect(unpackScript).toContain('fs.renameSync(runtime.dir, runtime.backupDir)');
    expect(unpackScript).toContain('fs.renameSync(runtime.backupDir, runtime.dir)');
    expect(unpackScript).toContain('import pip, requests, yaml, openpyxl, pypdf, bs4');
  });

  it('passes userData to the resource migrator instead of deleting the legacy runtime', () => {
    expect(nsisScript).toContain('"$APPDATA\\${PRODUCT_NAME}"');
    expect(nsisScript).not.toContain('RMDir /r "$APPDATA\\${PRODUCT_NAME}\\runtimes\\python-win"');
    expect(unpackScript).toContain('migrateLegacyPythonRuntime()');
  });

  it('uses packaged dependency config and removes legacy app-data copies', () => {
    expect(nsisScript).not.toContain('CopyFiles /SILENT "$INSTDIR\\resources\\dependency-config');
    expect(nsisScript).toContain('Delete "$APPDATA\\${PRODUCT_NAME}\\dependency-config\\.npmrc"');
    expect(nsisScript).toContain('Delete "$APPDATA\\${PRODUCT_NAME}\\dependency-config\\pip.ini"');
    expect(nsisScript).not.toContain('RMDir /r "$APPDATA\\${PRODUCT_NAME}\\dependency-config"');
    expect(nsisScript).toContain('dependency-config-legacy: cleanup-complete');
  });

  it('packages dependency config once as a standalone installation resource', () => {
    const dependencyConfigResources = (builderConfig.extraResources ?? []).filter(
      resource => resource.from === 'resources/dependency-config',
    );

    expect(dependencyConfigResources).toEqual([
      { from: 'resources/dependency-config', to: 'dependency-config', filter: ['**/*'] },
    ]);
    expect(builderHook).not.toContain("label: 'Dependency manager config'");
  });

  it('does not retain old Git files or OpenClaw skills in an upgraded installation', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-mingit-upgrade-'));
    tempDirs.push(root);
    const archiveRoot = path.join(root, 'archive');
    const installResources = path.join(root, 'installed-resources');
    const archivePath = path.join(root, 'win-resources.tar');
    const userDataRoot = path.join(root, 'user-data');
    const staleBashPath = path.join(installResources, 'mingit', 'bin', 'bash.exe');
    const staleSkillPath = path.join(
      installResources,
      'cfmind',
      'skills',
      'openclaw-default',
      'SKILL.md',
    );
    const customSkillPath = path.join(
      installResources,
      'cfmind',
      'skills',
      'custom-skill',
      'SKILL.md',
    );
    const installedGitPath = path.join(installResources, 'mingit', 'cmd', 'git.exe');
    const installedPythonPath = path.join(installResources, 'python-win', 'python.exe');
    const stalePythonPackagePath = path.join(
      installResources,
      'python-win',
      'Lib',
      'site-packages',
      'stale-package.py',
    );
    const legacyUserPackagePath = path.join(
      userDataRoot,
      'runtimes',
      'python-win',
      'Lib',
      'site-packages',
      'user-package.py',
    );
    const migratedUserPackagePath = path.join(
      userDataRoot,
      'python-user',
      'Python312',
      'legacy-site-packages',
      'user-package.py',
    );

    mkdirSync(path.join(archiveRoot, 'cfmind', 'skills', 'custom-skill'), { recursive: true });
    mkdirSync(path.join(archiveRoot, 'mingit', 'cmd'), { recursive: true });
    writePythonRuntimeFixture(path.join(archiveRoot, 'python-win'));
    mkdirSync(path.dirname(staleBashPath), { recursive: true });
    mkdirSync(path.dirname(staleSkillPath), { recursive: true });
    mkdirSync(path.dirname(stalePythonPackagePath), { recursive: true });
    mkdirSync(path.dirname(legacyUserPackagePath), { recursive: true });
    writeFileSync(path.join(archiveRoot, 'cfmind', 'package.json'), '{}');
    writeFileSync(path.join(archiveRoot, 'cfmind', 'skills', 'custom-skill', 'SKILL.md'), 'custom');
    writeFileSync(path.join(archiveRoot, 'mingit', 'cmd', 'git.exe'), 'mingit');
    writeFileSync(staleBashPath, 'portable-git');
    writeFileSync(staleSkillPath, 'default');
    writeFileSync(stalePythonPackagePath, 'stale');
    writeFileSync(legacyUserPackagePath, 'user-package');
    createTar({ cwd: archiveRoot, file: archivePath, sync: true }, [
      'cfmind',
      'mingit',
      'python-win',
    ]);

    const result = spawnSync(
      process.execPath,
      [unpackScriptPath, archivePath, installResources, userDataRoot],
      { encoding: 'utf8' },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(installedGitPath)).toBe(true);
    expect(existsSync(installedPythonPath)).toBe(true);
    expect(existsSync(staleBashPath)).toBe(false);
    expect(existsSync(staleSkillPath)).toBe(false);
    expect(existsSync(stalePythonPackagePath)).toBe(false);
    expect(readFileSync(migratedUserPackagePath, 'utf8')).toBe('user-package');
    expect(existsSync(path.join(userDataRoot, 'runtimes', 'python-win'))).toBe(false);
    expect(existsSync(customSkillPath)).toBe(true);
    expect(existsSync(path.join(installResources, '.cfmind-upgrade-backup'))).toBe(false);
    expect(existsSync(path.join(installResources, '.mingit-upgrade-backup'))).toBe(false);
    expect(existsSync(path.join(installResources, '.python-win-upgrade-backup'))).toBe(false);
  });

  it('restores PortableGit when the replacement archive is invalid', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-mingit-rollback-'));
    tempDirs.push(root);
    const installResources = path.join(root, 'installed-resources');
    const archivePath = path.join(root, 'invalid-resources.tar');
    const staleBashPath = path.join(installResources, 'mingit', 'bin', 'bash.exe');
    const previousPythonPath = path.join(installResources, 'python-win', 'python.exe');

    mkdirSync(path.dirname(staleBashPath), { recursive: true });
    mkdirSync(path.dirname(previousPythonPath), { recursive: true });
    writeFileSync(staleBashPath, 'portable-git');
    writeFileSync(previousPythonPath, 'previous-python');
    writeFileSync(archivePath, 'not a tar archive');

    const result = spawnSync(process.execPath, [unpackScriptPath, archivePath, installResources], {
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(existsSync(staleBashPath)).toBe(true);
    expect(readFileSync(previousPythonPath, 'utf8')).toBe('previous-python');
    expect(existsSync(path.join(installResources, '.mingit-upgrade-backup'))).toBe(false);
    expect(existsSync(path.join(installResources, '.python-win-upgrade-backup'))).toBe(false);
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

  it('rejects an incomplete Python runtime and restores the previous one', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-python-runtime-rollback-'));
    tempDirs.push(root);
    const archiveRoot = path.join(root, 'archive');
    const installResources = path.join(root, 'installed-resources');
    const archivePath = path.join(root, 'win-resources.tar');
    const previousPythonPath = path.join(installResources, 'python-win', 'python.exe');

    mkdirSync(path.join(archiveRoot, 'cfmind'), { recursive: true });
    mkdirSync(path.join(archiveRoot, 'mingit', 'cmd'), { recursive: true });
    writePythonRuntimeFixture(path.join(archiveRoot, 'python-win'));
    rmSync(path.join(archiveRoot, 'python-win', 'Lib', 'site-packages', 'sitecustomize.py'));
    writeFileSync(path.join(archiveRoot, 'cfmind', 'package.json'), '{}');
    writeFileSync(path.join(archiveRoot, 'mingit', 'cmd', 'git.exe'), 'git');
    createTar({ cwd: archiveRoot, file: archivePath, sync: true }, [
      'cfmind',
      'mingit',
      'python-win',
    ]);

    writePythonRuntimeFixture(path.join(installResources, 'python-win'));
    writeFileSync(previousPythonPath, 'previous-python');

    const result = spawnSync(process.execPath, [unpackScriptPath, archivePath, installResources], {
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('missing required file');
    expect(readFileSync(previousPythonPath, 'utf8')).toBe('previous-python');
    expect(existsSync(path.join(installResources, '.python-win-upgrade-backup'))).toBe(false);
  });

  it('restores already-backed-up runtimes when a later backup rename fails', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-runtime-backup-failure-'));
    tempDirs.push(root);
    const installResources = path.join(root, 'installed-resources');
    const archivePath = path.join(root, 'unused.tar');
    const faultPreloadPath = path.join(root, 'fail-mingit-backup.cjs');
    const oldCfmindPath = path.join(installResources, 'cfmind', 'package.json');
    const oldGitPath = path.join(installResources, 'mingit', 'cmd', 'git.exe');
    const oldPythonPath = path.join(installResources, 'python-win', 'python.exe');

    mkdirSync(path.dirname(oldCfmindPath), { recursive: true });
    mkdirSync(path.dirname(oldGitPath), { recursive: true });
    mkdirSync(path.dirname(oldPythonPath), { recursive: true });
    writeFileSync(oldCfmindPath, 'old-cfmind');
    writeFileSync(oldGitPath, 'old-git');
    writeFileSync(oldPythonPath, 'old-python');
    writeFileSync(archivePath, 'unused');
    writeFileSync(
      faultPreloadPath,
      `const fs = require('fs');
const path = require('path');
const originalRename = fs.renameSync;
fs.renameSync = (source, destination) => {
  if (path.basename(source) === 'mingit' && path.basename(destination) === '.mingit-upgrade-backup') {
    throw new Error('injected backup rename failure');
  }
  return originalRename(source, destination);
};
`,
    );

    const result = spawnSync(
      process.execPath,
      ['--require', faultPreloadPath, unpackScriptPath, archivePath, installResources],
      { encoding: 'utf8' },
    );

    expect(result.status).not.toBe(0);
    expect(readFileSync(oldCfmindPath, 'utf8')).toBe('old-cfmind');
    expect(readFileSync(oldGitPath, 'utf8')).toBe('old-git');
    expect(readFileSync(oldPythonPath, 'utf8')).toBe('old-python');
    expect(existsSync(path.join(installResources, '.cfmind-upgrade-backup'))).toBe(false);
  });

  it('keeps verified runtimes when committed backup cleanup fails', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-runtime-cleanup-failure-'));
    tempDirs.push(root);
    const archiveRoot = path.join(root, 'archive');
    const installResources = path.join(root, 'installed-resources');
    const archivePath = path.join(root, 'win-resources.tar');
    const faultPreloadPath = path.join(root, 'fail-python-backup-cleanup.cjs');

    mkdirSync(path.join(archiveRoot, 'cfmind'), { recursive: true });
    mkdirSync(path.join(archiveRoot, 'mingit', 'cmd'), { recursive: true });
    writePythonRuntimeFixture(path.join(archiveRoot, 'python-win'));
    writeFileSync(path.join(archiveRoot, 'cfmind', 'package.json'), 'new-cfmind');
    writeFileSync(path.join(archiveRoot, 'mingit', 'cmd', 'git.exe'), 'new-git');
    createTar({ cwd: archiveRoot, file: archivePath, sync: true }, [
      'cfmind',
      'mingit',
      'python-win',
    ]);

    mkdirSync(path.join(installResources, 'cfmind'), { recursive: true });
    mkdirSync(path.join(installResources, 'mingit', 'cmd'), { recursive: true });
    writePythonRuntimeFixture(path.join(installResources, 'python-win'));
    writeFileSync(path.join(installResources, 'cfmind', 'package.json'), 'old-cfmind');
    writeFileSync(path.join(installResources, 'mingit', 'cmd', 'git.exe'), 'old-git');
    writeFileSync(path.join(installResources, 'python-win', 'python.exe'), 'old-python');
    writeFileSync(
      faultPreloadPath,
      `const fs = require('fs');
const path = require('path');
const originalRemove = fs.rmSync;
fs.rmSync = (target, options) => {
  if (path.basename(target) === '.python-win-upgrade-backup') {
    throw new Error('injected backup cleanup failure');
  }
  return originalRemove(target, options);
};
`,
    );

    const result = spawnSync(
      process.execPath,
      ['--require', faultPreloadPath, unpackScriptPath, archivePath, installResources],
      { encoding: 'utf8' },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path.join(installResources, 'cfmind', 'package.json'), 'utf8')).toBe(
      'new-cfmind',
    );
    expect(readFileSync(path.join(installResources, 'mingit', 'cmd', 'git.exe'), 'utf8')).toBe(
      'new-git',
    );
    expect(readFileSync(path.join(installResources, 'python-win', 'python.exe'), 'utf8')).toBe(
      'python',
    );
    expect(existsSync(path.join(installResources, '.python-win-upgrade-backup'))).toBe(true);
  });

  it('restores healthy backups even when a crash tears the transaction marker', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-runtime-interrupted-extract-'));
    tempDirs.push(root);
    const installResources = path.join(root, 'installed-resources');
    const archivePath = path.join(root, 'invalid-resources.tar');
    const runtimePairs = [
      ['cfmind', '.cfmind-upgrade-backup', 'package.json'],
      ['mingit', '.mingit-upgrade-backup', path.join('cmd', 'git.exe')],
      ['python-win', '.python-win-upgrade-backup', 'python.exe'],
    ];

    for (const [currentName, backupName, markerPath] of runtimePairs) {
      const currentMarker = path.join(installResources, currentName, markerPath);
      const backupMarker = path.join(installResources, backupName, markerPath);
      mkdirSync(path.dirname(currentMarker), { recursive: true });
      mkdirSync(path.dirname(backupMarker), { recursive: true });
      writeFileSync(currentMarker, 'partial');
      writeFileSync(backupMarker, `healthy-${currentName}`);
    }
    writeFileSync(
      path.join(installResources, '.runtime-upgrade-in-progress.json'),
      '{"hadOriginal":',
    );
    writeFileSync(archivePath, 'not a tar archive');

    const result = spawnSync(process.execPath, [unpackScriptPath, archivePath, installResources], {
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    for (const [currentName, backupName, markerPath] of runtimePairs) {
      expect(readFileSync(path.join(installResources, currentName, markerPath), 'utf8')).toBe(
        `healthy-${currentName}`,
      );
      expect(existsSync(path.join(installResources, backupName))).toBe(false);
    }
    expect(existsSync(path.join(installResources, '.runtime-upgrade-in-progress.json'))).toBe(
      false,
    );
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
