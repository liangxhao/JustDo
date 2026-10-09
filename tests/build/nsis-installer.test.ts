import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { create as createTar } from 'tar';
import { afterEach, describe, expect, it } from 'vitest';

const nsisScript = readFileSync(
  path.resolve(__dirname, '../../scripts/packaging/nsis-installer.nsh'),
  'utf8',
).replaceAll('\r\n', '\n');
const builderHook = readFileSync(
  path.resolve(__dirname, '../../scripts/packaging/electron-builder-hooks.cjs'),
  'utf8',
);
const executableBuilderConfig = readFileSync(
  path.resolve(__dirname, '../../electron-builder.config.cjs'),
  'utf8',
);
const builderConfig = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../electron-builder.json'), 'utf8'),
) as {
  artifactBuildCompleted?: string;
  electronLanguages?: string[];
  extraResources?: Array<{ from?: string; to?: string }>;
  nsis?: {
    allowElevation?: boolean;
    deleteAppDataOnUninstall?: boolean;
    differentialPackage?: boolean;
    packElevateHelper?: boolean;
    perMachine?: boolean;
    preCompressedFileExtensions?: string[];
  };
  win?: { extraResources?: Array<{ from?: string; to?: string }> };
};
const unpackScriptPath = path.resolve(__dirname, '../../scripts/packaging/unpack-cfmind.cjs');
const unpackScript = readFileSync(unpackScriptPath, 'utf8');
const processHelperPath = path.resolve(__dirname, '../../scripts/packaging/nsis-process-helper.ps1');
const processHelper = readFileSync(processHelperPath, 'utf8').replaceAll('\r\n', '\n');
const userDataHelperPath = path.resolve(__dirname, '../../scripts/packaging/nsis-user-data-helper.ps1');
const userDataHelper = readFileSync(userDataHelperPath, 'utf8').replaceAll('\r\n', '\n');
const tempDirs: string[] = [];
const { compressTarArchive } = require('../../scripts/openclaw/pack-openclaw-tar.cjs') as {
  compressTarArchive: (sourceTar: string, outputArchive: string) => Promise<void>;
};

async function createZstdTarFixture(
  archiveRoot: string,
  archivePath: string,
  entries: string[],
): Promise<void> {
  const tarPath = `${archivePath}.tar`;
  createTar({ cwd: archiveRoot, file: tarPath, sync: true }, entries);
  try {
    await compressTarArchive(tarPath, archivePath);
  } finally {
    rmSync(tarPath, { force: true });
  }
}

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
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe('Windows uninstaller process handling', () => {
  it.runIf(process.platform === 'win32')(
    'recognizes a real executable sharing lock when process enumeration fails',
    () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-lock-probe-'));
      tempDirs.push(root);
      writeFileSync(path.join(root, 'probe.exe'), 'test executable');
      const command = `
        function global:Get-Process { throw 'Simulated unavailable process inventory' }
        $held = [IO.File]::Open((Join-Path $env:JUSTDO_INSTALL_ROOT 'probe.exe'), 'Open', 'Read', 'None')
        try {
          & $env:JUSTDO_TEST_HELPER -Action Find
          Write-Output "locked-find=$LASTEXITCODE"
          & $env:JUSTDO_TEST_HELPER -Action Wait -MaxAttempts 1
          Write-Output "locked-wait=$LASTEXITCODE"
        } finally { $held.Dispose() }
        & $env:JUSTDO_TEST_HELPER -Action Find
        Write-Output "unlocked-find=$LASTEXITCODE"
        & $env:JUSTDO_TEST_HELPER -Action Wait -MaxAttempts 1
        Write-Output "unlocked-wait=$LASTEXITCODE"
        exit 0
      `;
      const result = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(command, 'utf16le').toString('base64'),
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            JUSTDO_INSTALL_ROOT: root,
            JUSTDO_APP_PROCESS_NAME: 'probe',
            JUSTDO_CALLER_PID: String(process.pid),
            JUSTDO_TEST_HELPER: processHelperPath,
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('locked-find=0');
      expect(result.stdout).toContain('locked-wait=1');
      expect(result.stdout).toContain('unlocked-find=1');
      expect(result.stdout).toContain('unlocked-wait=0');
    },
    30_000,
  );

  it('excludes the uninstaller process from installed-process detection', () => {
    expect(nsisScript).toContain('Kernel32::GetCurrentProcessId()');
    expect(processHelper).toContain('$_.Id -ne $callerPid');
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
    expect(processHelper).toContain('[IO.Path]::GetFullPath($executablePath).StartsWith(');
    expect(processHelper).toContain('Get-Process -ErrorAction Stop');
    expect(processHelper).not.toContain('Get-CimInstance');
    expect(nsisScript).toContain('$WINDIR\\Sysnative\\WindowsPowerShell');
    expect(nsisScript).toContain('JUSTDO_APP_PROCESS_NAME');
    expect(processHelper).toContain('$process.ProcessName -ieq $appProcessName');
    expect(nsisScript).toContain('!insertmacro FindJustDoProcesses $0');
    expect(nsisScript).toContain('!insertmacro WaitForJustDoProcesses $0 20');
    expect(nsisScript).toContain('!insertmacro StopJustDoProcesses $0');
    expect(nsisScript).not.toContain('nsProcess::FindProcess');
    expect(nsisScript).not.toContain('nsProcess::KillProcess');
    expect(processHelper).toContain('Stop-MatchedProcess $_');
    expect(processHelper).toContain('operation=terminate-process pid=$($process.Id)');
  });

  it('does not start the process helper for a pristine install', () => {
    const processCheck = nsisScript.slice(
      nsisScript.indexOf('Function JustDoCheckAppRunning'),
      nsisScript.indexOf('FunctionEnd', nsisScript.indexOf('Function JustDoCheckAppRunning')),
    );
    expect(processCheck).toContain('ReadRegStr $R8 HKCU "Software\\${APP_GUID}" InstallLocation');
    expect(processCheck).toContain('phase=process-check-skipped reason=pristine-install');
    expect(processCheck).toContain('ReadRegStr $R7 HKLM "Software\\${APP_GUID}" InstallLocation');
    expect(processCheck).toContain('${AndIfNot} ${FileExists} "$INSTDIR\\*.*"');
    expect(processCheck.indexOf('phase=process-check-skipped')).toBeLessThan(
      processCheck.indexOf('!insertmacro FindJustDoProcesses'),
    );
  });

  it('leaves legacy user-data processes alone during installation', () => {
    expect(nsisScript).not.toContain('Call JustDoStopLegacyPythonProcesses');
    expect(nsisScript).not.toContain('JUSTDO_USER_DATA_ROOT');
  });

  it('falls back to filesystem replacement when scoped process inspection fails', () => {
    expect(nsisScript).toContain('JustDoInstallInspectionFailed:');
    expect(nsisScript).toContain('phase=process-check-degraded');
    expect(nsisScript).toContain('action=continue-to-filesystem-replacement');
    expect(nsisScript).not.toContain(
      'Setup could not inspect processes in the installation directory.',
    );
    expect(nsisScript).not.toContain('安装程序无法确认 ${PRODUCT_NAME} 是否已关闭');
    expect(nsisScript).toContain('${ElseIf} $0 != "1"');
    expect(processHelper).toContain("$Action -in @('Find', 'Wait', 'Stop')");
    expect(processHelper).toContain('fallback=executable-lock-probe locked=$locked');
    expect(processHelper).toContain('$win32Code -eq 32 -or $win32Code -eq 33');
    expect(processHelper).toContain('error-type=$exceptionType hresult=$hresult');
  });

  it('runs process checks from a script file instead of a fragile inline command', () => {
    expect(nsisScript).toContain('/TIMEOUT=15000');
    expect(nsisScript).toContain('/TIMEOUT=90000');
    expect(nsisScript).not.toContain('-Command "');
    expect(processHelper).not.toContain("StageRuntimes");
    expect(nsisScript).not.toContain("JustDoStageManagedRuntimes");
    expect(nsisScript).not.toContain("JustDoRestoreManagedRuntimes");
    expect(processHelper).toContain('$attempt -lt $MaxAttempts');
  });

  it.runIf(process.platform === 'win32')(
    'force-stops only an executable running from the legacy Python directory',
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-legacy-python-process-'));
      tempDirs.push(root);
      const installRoot = path.join(root, 'installed-app');
      const userDataRoot = path.join(root, 'user-data');
      const legacyPythonRoot = path.join(userDataRoot, 'runtimes', 'python-win');
      const legacyPythonExecutable = path.join(legacyPythonRoot, 'python.exe');
      const unrelatedPythonExecutable = path.join(root, 'unrelated-python', 'python.exe');
      const powershellPath = path.join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      );
      mkdirSync(installRoot, { recursive: true });
      mkdirSync(legacyPythonRoot, { recursive: true });
      mkdirSync(path.dirname(unrelatedPythonExecutable), { recursive: true });
      copyFileSync(process.execPath, legacyPythonExecutable);
      copyFileSync(process.execPath, unrelatedPythonExecutable);

      const legacyPython = spawn(legacyPythonExecutable, ['-e', 'setInterval(() => {}, 1_000)'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      const unrelatedPython = spawn(
        unrelatedPythonExecutable,
        ['-e', 'setInterval(() => {}, 1_000)'],
        {
          stdio: 'ignore',
          windowsHide: true,
        },
      );
      const exited = new Promise<boolean>(resolve => {
        legacyPython.once('exit', () => resolve(true));
      });
      const unrelatedExited = new Promise<boolean>(resolve => {
        unrelatedPython.once('exit', () => resolve(true));
      });

      try {
        await Promise.all(
          [legacyPython, unrelatedPython].map(
            child =>
              new Promise<void>((resolve, reject) => {
                child.once('spawn', resolve);
                child.once('error', reject);
              }),
          ),
        );
        await new Promise(resolve => setTimeout(resolve, 250));
        expect(legacyPython.exitCode).toBeNull();
        expect(unrelatedPython.exitCode).toBeNull();

        const result = spawnSync(
          powershellPath,
          [
            '-NoProfile',
            '-NonInteractive',
            '-File',
            processHelperPath,
            '-Action',
            'StopLegacyPython',
          ],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              JUSTDO_INSTALL_ROOT: installRoot,
              JUSTDO_USER_DATA_ROOT: userDataRoot,
              JUSTDO_CALLER_PID: String(process.pid),
            },
          },
        );

        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.stdout).toContain('matched=1 remaining=0');
        await expect(
          Promise.race([
            exited,
            new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2_000)),
          ]),
        ).resolves.toBe(true);
        expect(unrelatedPython.exitCode).toBeNull();
      } finally {
        legacyPython.kill();
        unrelatedPython.kill();
        await Promise.all(
          [exited, unrelatedExited].map(exitPromise =>
            Promise.race([
              exitPromise,
              new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2_000)),
            ]),
          ),
        );
      }
    },
    30_000,
  );

  it.runIf(process.platform === 'win32')(
    'does not stop an outside executable launched through a legacy-directory junction',
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-legacy-python-junction-'));
      tempDirs.push(root);
      const installRoot = path.join(root, 'installed-app');
      const userDataRoot = path.join(root, 'user-data');
      const legacyPythonRoot = path.join(userDataRoot, 'runtimes', 'python-win');
      const outsideRuntimeRoot = path.join(root, 'outside-runtime');
      const outsideExecutable = path.join(outsideRuntimeRoot, 'python.exe');
      const powershellPath = path.join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      );
      mkdirSync(installRoot, { recursive: true });
      mkdirSync(path.dirname(legacyPythonRoot), { recursive: true });
      mkdirSync(outsideRuntimeRoot, { recursive: true });
      copyFileSync(process.execPath, outsideExecutable);
      symlinkSync(outsideRuntimeRoot, legacyPythonRoot, 'junction');

      const outsidePython = spawn(
        path.join(legacyPythonRoot, 'python.exe'),
        ['-e', 'setInterval(() => {}, 1_000)'],
        {
          stdio: 'ignore',
          windowsHide: true,
        },
      );
      const outsideExited = new Promise<boolean>(resolve => {
        outsidePython.once('exit', () => resolve(true));
      });

      try {
        await new Promise<void>((resolve, reject) => {
          outsidePython.once('spawn', resolve);
          outsidePython.once('error', reject);
        });
        await new Promise(resolve => setTimeout(resolve, 250));
        expect(outsidePython.exitCode).toBeNull();

        const result = spawnSync(
          powershellPath,
          [
            '-NoProfile',
            '-NonInteractive',
            '-File',
            processHelperPath,
            '-Action',
            'StopLegacyPython',
          ],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              JUSTDO_INSTALL_ROOT: installRoot,
              JUSTDO_USER_DATA_ROOT: userDataRoot,
              JUSTDO_CALLER_PID: String(process.pid),
            },
          },
        );

        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.stdout).toContain('matched=0 remaining=0');
        await new Promise(resolve => setTimeout(resolve, 250));
        expect(outsidePython.exitCode).toBeNull();
      } finally {
        outsidePython.kill();
        await Promise.race([
          outsideExited,
          new Promise<boolean>(resolve => setTimeout(() => resolve(false), 2_000)),
        ]);
        if (existsSync(legacyPythonRoot)) unlinkSync(legacyPythonRoot);
      }
    },
    30_000,
  );

  it('removes the previous Git runtime before extracting MinGit during upgrades', () => {
    const backupIndex = unpackScript.indexOf('fs.renameSync(runtime.dir, runtime.backupDir)');
    const extractionIndex = unpackScript.indexOf('await extractArchive(entryProgress)');

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
    expect(unpackScript).not.toContain('import pip, requests, yaml, openpyxl, pypdf, bs4');
  });

  it('does not pass userData to the resource extractor', () => {
    expect(nsisScript).toContain('"$INSTDIR\\resources" "" "$INSTDIR\\resources\\win-resources-metadata.json"');
    expect(unpackScript).not.toContain('migrateLegacyPythonRuntime');
  });

  it('keeps packaged dependency config in the installation directory', () => {
    expect(nsisScript).not.toContain('dependency-config\\.npmrc');
    expect(nsisScript).not.toContain('dependency-config\\pip.ini');
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

  it('stores a pre-compressed zstd runtime archive with progress metadata', () => {
    expect(builderConfig.win?.extraResources).toEqual(
      expect.arrayContaining([
        { from: 'build-tar/win-resources.tar.zst', to: 'win-resources.tar.zst' },
        {
          from: 'build-tar/win-resources-metadata.json',
          to: 'win-resources-metadata.json',
        },
      ]),
    );
    expect(builderConfig.electronLanguages).toEqual(['en-US', 'zh-CN']);
    expect(builderConfig.nsis?.differentialPackage).toBe(false);
    expect(builderConfig.nsis?.preCompressedFileExtensions).toEqual(['.zst']);
    expect(builderHook).toContain('compressTarArchive(outputTar, outputArchive)');
    expect(builderHook).toContain('totalEntries: tarEntries.length');
    expect(builderHook).toContain("process.env.ELECTRON_BUILDER_7Z_FILTER = 'BCJ'");
    expect(executableBuilderConfig).toContain("process.env.ELECTRON_BUILDER_7Z_FILTER = 'BCJ'");
    expect(builderConfig.artifactBuildCompleted).toBe('./scripts/packaging/electron-builder-hooks.cjs');
  });

  it('does not retain old Git files or OpenClaw skills in an upgraded installation', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-mingit-upgrade-'));
    tempDirs.push(root);
    const archiveRoot = path.join(root, 'archive');
    const installResources = path.join(root, 'installed-app', 'resources');
    const archivePath = path.join(root, 'win-resources.tar.zst');
    const metadataPath = path.join(root, 'win-resources-metadata.json');
    const progressPath = path.join(root, 'install-progress.txt');
    const diagnosticLogPath = path.join(root, 'install-resource.log');
    const userDataRoot = path.join(root, 'user-data');
    const managedTempRoot = path.join(
      path.dirname(installResources),
      '.justdo-installer-temp-123-456',
    );
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

    mkdirSync(path.join(archiveRoot, 'cfmind', 'skills', 'custom-skill'), { recursive: true });
    mkdirSync(path.join(archiveRoot, 'mingit', 'cmd'), { recursive: true });
    writePythonRuntimeFixture(path.join(archiveRoot, 'python-win'));
    mkdirSync(path.dirname(staleBashPath), { recursive: true });
    mkdirSync(path.dirname(staleSkillPath), { recursive: true });
    mkdirSync(path.dirname(stalePythonPackagePath), { recursive: true });
    mkdirSync(path.dirname(legacyUserPackagePath), { recursive: true });
    mkdirSync(managedTempRoot, { recursive: true });
    writeFileSync(path.join(managedTempRoot, 'extractor-temporary-file'), 'temporary');
    writeFileSync(path.join(archiveRoot, 'cfmind', 'package.json'), '{}');
    writeFileSync(path.join(archiveRoot, 'cfmind', 'skills', 'custom-skill', 'SKILL.md'), 'custom');
    writeFileSync(path.join(archiveRoot, 'mingit', 'cmd', 'git.exe'), 'mingit');
    writeFileSync(staleBashPath, 'portable-git');
    writeFileSync(staleSkillPath, 'default');
    writeFileSync(stalePythonPackagePath, 'stale');
    writeFileSync(legacyUserPackagePath, 'user-package');
    await createZstdTarFixture(archiveRoot, archivePath, ['cfmind', 'mingit', 'python-win']);
    writeFileSync(
      metadataPath,
      '{"schemaVersion":1,"totalEntries":32,"uncompressedBytes":10485760}\n',
    );

    const result = spawnSync(
      process.execPath,
      [
        unpackScriptPath,
        archivePath,
        installResources,
        userDataRoot,
        metadataPath,
        progressPath,
        diagnosticLogPath,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          JUSTDO_INSTALLER_TEMP_ROOT: managedTempRoot,
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(installedGitPath)).toBe(true);
    expect(existsSync(installedPythonPath)).toBe(true);
    expect(existsSync(staleBashPath)).toBe(false);
    expect(existsSync(staleSkillPath)).toBe(false);
    expect(existsSync(stalePythonPackagePath)).toBe(false);
    expect(existsSync(legacyUserPackagePath)).toBe(true);
    expect(existsSync(path.join(userDataRoot, 'runtimes', 'python-win'))).toBe(true);
    expect(existsSync(customSkillPath)).toBe(true);
    expect(existsSync(path.join(installResources, '.cfmind-upgrade-backup'))).toBe(false);
    expect(existsSync(path.join(installResources, '.mingit-upgrade-backup'))).toBe(false);
    expect(existsSync(path.join(installResources, '.python-win-upgrade-backup'))).toBe(false);
    expect(existsSync(managedTempRoot)).toBe(false);
    expect(readFileSync(progressPath, 'utf8')).toBe('determinate\n100\nCore resources verified');
    const diagnosticLog = readFileSync(diagnosticLogPath, 'utf8');
    expect(diagnosticLog).toContain('event=resource-install-start');
    expect(diagnosticLog).toContain('event=archive-inspected');
    expect(diagnosticLog).not.toContain('event=disk-growth-guard-started');
    expect(diagnosticLog).not.toContain('event=disk-growth-guard-using-archive-fallback');
    expect(diagnosticLog).toContain('event=archive-extractor-selected');
    expect(diagnosticLog).toContain('event=runtime-validation-complete');
    expect(diagnosticLog).toContain('event=resource-install-complete');
    expect(diagnosticLog).toContain('event=extractor-temp-cleanup-complete');
    expect(diagnosticLog).toContain('mode=determinate percent=100 message=Core resources verified');
    if (process.platform === 'win32') {
      expect(result.stdout).toContain('Using Windows native resource extraction');
      expect(result.stdout).not.toContain('0 resource entries ready');
      expect(diagnosticLog).toContain('extractor=windows-native-tar');
    }
  });

  it('does not reject a writable installation because of unrelated free-space changes', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-disk-growth-rollback-'));
    tempDirs.push(root);
    const archiveRoot = path.join(root, 'archive');
    const installResources = path.join(root, 'installed-resources');
    const archivePath = path.join(root, 'win-resources.tar.zst');
    const metadataPath = path.join(root, 'win-resources-metadata.json');
    const diagnosticLogPath = path.join(root, 'install-resource.log');
    const statfsPreloadPath = path.join(root, 'statfs-growth-preload.cjs');
    const installedPackagePath = path.join(installResources, 'cfmind', 'package.json');

    mkdirSync(path.join(archiveRoot, 'cfmind'), { recursive: true });
    mkdirSync(path.join(archiveRoot, 'mingit', 'cmd'), { recursive: true });
    writePythonRuntimeFixture(path.join(archiveRoot, 'python-win'));
    mkdirSync(path.dirname(installedPackagePath), { recursive: true });
    writeFileSync(installedPackagePath, '{"version":"previous"}');
    writeFileSync(path.join(archiveRoot, 'cfmind', 'package.json'), '{"version":"new"}');
    writeFileSync(path.join(archiveRoot, 'mingit', 'cmd', 'git.exe'), 'mingit');
    writeFileSync(
      path.join(archiveRoot, 'cfmind', 'growth-fixture.bin'),
      Buffer.alloc(8 * 1024 * 1024, 0x61),
    );
    await createZstdTarFixture(archiveRoot, archivePath, ['cfmind', 'mingit', 'python-win']);
    writeFileSync(
      metadataPath,
      '{"schemaVersion":1,"totalEntries":3,"uncompressedBytes":16777216}\n',
    );
    writeFileSync(
      statfsPreloadPath,
      `const fs = require('node:fs');
const originalStatfsSync = fs.statfsSync;
let samples = 0;
fs.statfsSync = (...args) => {
  const result = originalStatfsSync(...args);
  samples += 1;
  if (samples < 3 || typeof result.bavail !== 'bigint') return result;
  return { ...result, bavail: result.bavail > 3000000n ? result.bavail - 3000000n : 0n };
};
`,
    );

    const result = spawnSync(
      process.execPath,
      [unpackScriptPath, archivePath, installResources, '', metadataPath, '', diagnosticLogPath],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: `--require="${statfsPreloadPath.replaceAll('\\', '/')}"`,
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(diagnosticLogPath, 'utf8')).not.toContain('event=unexpected-disk-growth');
    expect(readFileSync(installedPackagePath, 'utf8')).toBe('{"version":"new"}');
    expect(existsSync(path.join(installResources, '.runtime-upgrade-in-progress.json'))).toBe(
      false,
    );
  });

  it.runIf(process.platform === 'win32')(
    'uses real entry progress when Windows native tar is unavailable',
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-resource-fallback-'));
      tempDirs.push(root);
      const archiveRoot = path.join(root, 'archive');
      const installResources = path.join(root, 'installed-resources');
      const archivePath = path.join(root, 'win-resources.tar.zst');
      const metadataPath = path.join(root, 'win-resources-metadata.json');
      const progressPath = path.join(root, 'install-progress.txt');
      const diagnosticLogPath = path.join(root, 'install-resource.log');
      mkdirSync(path.join(archiveRoot, 'cfmind'), { recursive: true });
      mkdirSync(path.join(archiveRoot, 'mingit', 'cmd'), { recursive: true });
      writePythonRuntimeFixture(path.join(archiveRoot, 'python-win'));
      writeFileSync(path.join(archiveRoot, 'cfmind', 'package.json'), '{}');
      writeFileSync(path.join(archiveRoot, 'mingit', 'cmd', 'git.exe'), 'mingit');
      await createZstdTarFixture(archiveRoot, archivePath, ['cfmind', 'mingit', 'python-win']);
      writeFileSync(
        metadataPath,
        '{"schemaVersion":1,"totalEntries":27,"uncompressedBytes":10485760}\n',
      );

      const result = spawnSync(
        process.execPath,
        [
          unpackScriptPath,
          archivePath,
          installResources,
          '',
          metadataPath,
          progressPath,
          diagnosticLogPath,
        ],
        {
          encoding: 'utf8',
          env: Object.fromEntries([
            ...Object.entries(process.env).filter(
              ([key]) => !['systemroot', 'windir'].includes(key.toLowerCase()),
            ),
            ['JUSTDO_INSTALLER_DISABLE_NATIVE_TAR', '1'],
          ]),
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(path.join(installResources, 'cfmind', 'package.json'))).toBe(true);
      const diagnosticLog = readFileSync(diagnosticLogPath, 'utf8');
      expect(diagnosticLog).toContain('extractor=npm-tar');
      expect(diagnosticLog).toContain('mode=determinate percent=100');
      expect(readFileSync(progressPath, 'utf8')).toBe('determinate\n100\nCore resources verified');
    },
  );

  it.runIf(process.platform === 'win32')('retries native extraction failure and never touches an unusable user-data path', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-资源 test-'));
    tempDirs.push(root);
    const archiveRoot = path.join(root, 'archive');
    const destination = path.join(root, '安装 目录', 'resources');
    const archive = path.join(root, 'win-resources.tar.zst');
    const userData = path.join(root, 'user-data-is-a-file');
    const diagnosticLog = path.join(root, 'install-resource.log');
    const preload = path.join(root, 'fail-native-tar.cjs');
    mkdirSync(path.join(archiveRoot, 'cfmind'), { recursive: true });
    mkdirSync(path.join(archiveRoot, 'mingit', 'cmd'), { recursive: true });
    writePythonRuntimeFixture(path.join(archiveRoot, 'python-win'));
    writeFileSync(path.join(archiveRoot, 'cfmind', 'package.json'), '{}');
    writeFileSync(path.join(archiveRoot, 'mingit', 'cmd', 'git.exe'), 'git');
    writeFileSync(userData, 'untouched profile');
    await createZstdTarFixture(archiveRoot, archive, ['cfmind', 'mingit', 'python-win']);
    writeFileSync(preload, `const cp = require('child_process');
const original = cp.spawn;
cp.spawn = (executable, args, options) => executable.toLowerCase().endsWith('tar.exe')
  ? original(process.execPath, ['-e', 'process.stderr.write("native tar failure" + "x".repeat(40000) + "NATIVE_STDERR_FINAL_RECORD", () => process.exit(1))'], options)
  : original(executable, args, options);
`);
    const result = spawnSync(process.execPath,
      ['--require', preload, unpackScriptPath, archive, destination, userData, '', '', diagnosticLog],
      { encoding: 'utf8', env: { ...process.env, JUSTDO_INSTALLER_PYTHON_IMPORT_CHECK: '1' } });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(userData, 'utf8')).toBe('untouched profile');
    const log = readFileSync(diagnosticLog, 'utf8');
    expect(log).toContain('event=archive-extractor-failed');
    expect(log).toContain('event=native-tar-stderr');
    expect(log).toContain('NATIVE_STDERR_FINAL_RECORD');
    const summary = log.split('\n').find(line => line.includes('event=archive-extractor-failed'));
    expect(summary).not.toContain('NATIVE_STDERR_FINAL_RECORD');
    expect(log).toContain('extractor=npm-tar');
    expect(log).toContain('event=resource-install-complete');
  });

  it.runIf(process.platform === 'win32')('keeps native process and streaming errors while successfully using the fallback extractor', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-native-launch-details-'));
    tempDirs.push(root);
    const source = path.join(root, 'source');
    const resources = path.join(root, 'installed', 'resources');
    const archive = path.join(root, 'resources.tar.zst');
    const missingExecutable = path.join(root, 'missing-native-tar.exe');
    const diagnosticLog = path.join(root, 'install-resource.log');
    const preload = path.join(root, 'fail-native-launch.cjs');
    mkdirSync(path.join(source, 'cfmind'), { recursive: true });
    mkdirSync(path.join(source, 'mingit', 'cmd'), { recursive: true });
    writePythonRuntimeFixture(path.join(source, 'python-win'));
    writeFileSync(path.join(source, 'cfmind', 'package.json'), '{}');
    writeFileSync(path.join(source, 'mingit', 'cmd', 'git.exe'), 'git');
    await createZstdTarFixture(source, archive, ['cfmind', 'mingit', 'python-win']);
    writeFileSync(preload, `const cp = require('child_process');
const original = cp.spawn;
cp.spawn = (executable, args, options) => original(
  executable.toLowerCase().endsWith('tar.exe') ? process.env.JUSTDO_TEST_MISSING_TAR : executable,
  args, options,
);
`);
    const result = spawnSync(process.execPath, [
      '--require', preload, unpackScriptPath, archive, resources, '', '', '', diagnosticLog,
    ], { encoding: 'utf8', env: { ...process.env, JUSTDO_TEST_MISSING_TAR: missingExecutable } });

    expect(result.status, result.stderr).toBe(0);
    const log = readFileSync(diagnosticLog, 'utf8');
    const failure = log.split('\n').find(line => line.includes('event=archive-extractor-failed'));
    expect(failure).toContain('processErrorCode=ENOENT');
    expect(failure).toContain(`processErrorPath=${missingExecutable}`);
    expect(failure).toContain('processErrorStack=Error:');
    expect(failure).toMatch(/pumpErrorStack=Error[^\n]+/);
    expect(log).toContain('extractor=npm-tar');
    expect(log).toContain('event=resource-install-complete');
  });

  it('keeps the real final error available for the installer dialog', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-extraction-error-'));
    tempDirs.push(root);
    const resources = path.join(root, 'resources');
    const progress = path.join(root, 'progress.txt');
    const archive = path.join(root, 'broken.tar.zst');
    mkdirSync(resources);
    writeFileSync(archive, 'broken compressed archive');
    const result = spawnSync(process.execPath, [unpackScriptPath, archive, resources, '', '', progress], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    const error = readFileSync(progress + '.error', 'utf16le');
    expect(error.length).toBeGreaterThan(1);
    expect(result.stderr).toContain(error.slice(1));
    expect(nsisScript).toContain('FileReadUTF16LE $3 $4');
    const failureDialog = nsisScript.slice(
      nsisScript.indexOf('TarExtractFailed:'),
      nsisScript.indexOf('TarExtractOK:'),
    );
    expect(failureDialog).toContain('StrCpy $4 "$INSTDIR\\resources\\install-resource.log"');
    expect(failureDialog).toContain('${If} $4 != $JustDoResourceLogPath');
    expect(failureDialog).toContain('${AndIf} $4 != $JustDoInstallLogPath');
    expect(failureDialog).toContain('${AndIf} ${FileExists} "$4"');
    expect(failureDialog).toContain('StrCpy $1 "$1$\\r$\\n$4"');
  });

  it.each([false, true])('retains detailed resource logs under the install root when the profile log is unavailable (corrupt=%s)', async corrupt => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-resource-log-fallback-'));
    tempDirs.push(root);
    const resources = path.join(root, 'installed', 'resources');
    const archiveRoot = path.join(root, 'source');
    const archive = path.join(root, 'resources.tar');
    const blockedProfile = path.join(root, 'profile-is-a-file');
    writeFileSync(blockedProfile, 'preserve profile');
    if (corrupt) {
      writeFileSync(archive, 'broken archive');
    } else {
      mkdirSync(path.join(archiveRoot, 'cfmind'), { recursive: true });
      mkdirSync(path.join(archiveRoot, 'mingit', 'cmd'), { recursive: true });
      writePythonRuntimeFixture(path.join(archiveRoot, 'python-win'));
      writeFileSync(path.join(archiveRoot, 'cfmind', 'package.json'), '{}');
      writeFileSync(path.join(archiveRoot, 'mingit', 'cmd', 'git.exe'), 'git');
      await createTar({ cwd: archiveRoot, file: archive }, ['cfmind', 'mingit', 'python-win']);
    }
    const result = spawnSync(process.execPath, [unpackScriptPath, archive, resources, '', '', '',
      path.join(blockedProfile, 'install-resource.log')], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(corrupt ? 1 : 0);
    expect(readFileSync(blockedProfile, 'utf8')).toBe('preserve profile');
    const log = readFileSync(path.join(resources, 'install-resource.log'), 'utf8');
    expect(log).toContain('event=diagnostic-log-relocated');
    expect(log).toMatch(/ENOTDIR|EEXIST/);
    expect(log).toContain(corrupt ? 'event=resource-install-failed' : 'event=resource-install-complete');
    if (corrupt) expect(log).toContain('stack=Error:');
  });

  it('recovers resource logging to the original path when the fallback becomes unavailable', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-resource-log-recovery-'));
    tempDirs.push(root);
    const resources = path.join(root, 'installed', 'resources');
    const profile = path.join(root, 'profile');
    const requestedLog = path.join(profile, 'install-resource.log');
    const fallbackLog = path.join(resources, 'install-resource.log');
    const fallbackSnapshot = path.join(resources, 'first-fallback.log');
    const preload = path.join(root, 'recover-log-path.cjs');
    writeFileSync(profile, 'temporarily occupied');
    writeFileSync(preload, `const fs = require('fs');
const append = fs.appendFileSync.bind(fs);
let changed = false;
fs.appendFileSync = (...args) => {
  const result = append(...args);
  if (!changed && String(args[0]) === process.env.JUSTDO_TEST_FALLBACK_LOG) {
    changed = true;
    fs.renameSync(process.env.JUSTDO_TEST_FALLBACK_LOG, process.env.JUSTDO_TEST_FALLBACK_SNAPSHOT);
    fs.mkdirSync(process.env.JUSTDO_TEST_FALLBACK_LOG);
    fs.unlinkSync(process.env.JUSTDO_TEST_PROFILE);
    fs.mkdirSync(process.env.JUSTDO_TEST_PROFILE);
  }
  return result;
};
`);
    const result = spawnSync(process.execPath, [
      '--require', preload, unpackScriptPath, path.join(root, 'missing.tar.zst'),
      resources, '', '', '', requestedLog,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        JUSTDO_TEST_PROFILE: profile,
        JUSTDO_TEST_FALLBACK_LOG: fallbackLog,
        JUSTDO_TEST_FALLBACK_SNAPSHOT: fallbackSnapshot,
      },
    });

    expect(result.status, result.stderr).toBe(1);
    expect(readFileSync(fallbackSnapshot, 'utf8')).toContain('RESOURCE INSTALL SESSION START');
    const recoveredLog = readFileSync(requestedLog, 'utf8');
    expect(recoveredLog).toContain('event=diagnostic-log-relocated');
    expect(recoveredLog).toMatch(/EISDIR|EPERM|EACCES/);
    expect(recoveredLog).toContain('event=archive-missing');
    expect(recoveredLog).toContain('RESOURCE INSTALL SESSION END');
    expect(recoveredLog).toContain('status=archive-missing');
  });

  it('keeps complete warning errors and successful installation when optional filesystem operations fail', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-warning-error-details-'));
    tempDirs.push(root);
    const source = path.join(root, 'source');
    const resources = path.join(root, 'installed', 'resources');
    const archive = path.join(root, 'resources.tar');
    const managedTemp = path.join(root, 'installed', '.justdo-installer-temp-123-456');
    const diagnosticLog = path.join(root, 'install-resource.log');
    const preload = path.join(root, 'optional-failures.cjs');
    mkdirSync(path.join(source, 'cfmind'), { recursive: true });
    mkdirSync(path.join(source, 'mingit', 'cmd'), { recursive: true });
    writePythonRuntimeFixture(path.join(source, 'python-win'));
    writeFileSync(path.join(source, 'cfmind', 'package.json'), '{}');
    writeFileSync(path.join(source, 'mingit', 'cmd', 'git.exe'), 'git');
    createTar({ cwd: source, file: archive, sync: true }, ['cfmind', 'mingit', 'python-win']);
    mkdirSync(resources, { recursive: true });
    mkdirSync(managedTemp);
    writeFileSync(path.join(resources, '.runtime-upgrade-in-progress.json'), 'invalid state');
    writeFileSync(preload, `const fs = require('fs');
const read = fs.readFileSync.bind(fs);
const remove = fs.rmSync.bind(fs);
function failure(message, syscall, target) {
  const error = Object.assign(new Error(message), {
    name: 'DetailedFilesystemError', code: 'EACCES', syscall, path: target,
    cause: new Error('Underlying optional filesystem cause'),
  });
  error.stack += '\\n' + 'full-stack-frame-'.repeat(1000) + '\\nFINAL_STACK_RECORD';
  return error;
}
fs.statfsSync = target => { throw failure('filesystem observation failed', 'statfs', target); };
fs.readFileSync = (target, ...args) => {
  if (String(target).endsWith('.runtime-upgrade-in-progress.json')) {
    throw failure('transaction state read failed', 'read', target);
  }
  return read(target, ...args);
};
fs.rmSync = (target, ...args) => {
  if (String(target) === process.env.JUSTDO_INSTALLER_TEMP_ROOT) {
    throw failure('managed temporary cleanup failed', 'rm', target);
  }
  return remove(target, ...args);
};
`);
    const result = spawnSync(process.execPath, [
      '--require', preload, unpackScriptPath, archive, resources, '', '', '', diagnosticLog,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        JUSTDO_INSTALLER_DISABLE_NATIVE_TAR: '1',
        JUSTDO_INSTALLER_TEMP_ROOT: managedTemp,
      },
    });

    expect(result.status, result.stderr).toBe(0);
    const log = readFileSync(diagnosticLog, 'utf8');
    expect(log).toContain('event=resource-install-complete');
    for (const description of [
      'filesystem observation failed', 'transaction state read failed', 'managed temporary cleanup failed',
    ]) {
      const record = log.split('\n').find(line => line.includes(`error=${description}`) || line.includes(`message=${description}`));
      expect(record).toContain('name=DetailedFilesystemError');
      expect(record).toContain('code=EACCES');
      expect(record).toContain('syscall=');
      expect(record).toContain('path=');
      expect(record).toContain('stack=DetailedFilesystemError:');
      expect(record).toContain('FINAL_STACK_RECORD');
      expect(record).toContain('cause=Error: Underlying optional filesystem cause');
    }
    expect(log).toContain('event=extractor-temp-cleanup-incomplete');
    expect(result.stderr).toContain('FINAL_STACK_RECORD');
  });

  it('logs module loading, rollback and error-report failures without replacing the original extraction error', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-multiple-error-details-'));
    tempDirs.push(root);
    const resources = path.join(root, 'installed', 'resources');
    const archive = path.join(root, 'resources.tar');
    const diagnosticLog = path.join(root, 'install-resource.log');
    const progress = path.join(root, 'progress.txt');
    const preload = path.join(root, 'logging-failures.cjs');
    mkdirSync(path.join(resources, 'cfmind'), { recursive: true });
    writeFileSync(path.join(resources, 'cfmind', 'package.json'), 'previous runtime');
    writeFileSync(archive, 'invalid archive');
    writeFileSync(preload, `const fs = require('fs');
const Module = require('module');
const load = Module._load;
const rename = fs.renameSync.bind(fs);
const write = fs.writeFileSync.bind(fs);
function failure(message, syscall, target) {
  return Object.assign(new Error(message), {
    code: 'EACCES', syscall, path: target, cause: new Error('Underlying failure cause'),
  });
}
Module._load = function (request, ...args) {
  if (request === 'tar' || request.replaceAll('\\\\', '/').endsWith('/node_modules/tar')) {
    throw failure('injected tar loader failure', 'require', request);
  }
  return load.call(this, request, ...args);
};
fs.renameSync = (source, destination) => {
  if (String(source).endsWith('.cfmind-upgrade-backup')) {
    throw failure('injected rollback failure', 'rename', source);
  }
  return rename(source, destination);
};
fs.writeFileSync = (target, ...args) => {
  if (String(target).endsWith('progress.txt.error')) {
    throw failure('injected error report failure', 'write', target);
  }
  return write(target, ...args);
};
`);
    const result = spawnSync(process.execPath, [
      '--require', preload, unpackScriptPath, archive, resources, '', '', progress, diagnosticLog,
    ], { encoding: 'utf8', env: { ...process.env, JUSTDO_INSTALLER_DISABLE_NATIVE_TAR: '1' } });

    expect(result.status, result.stderr).toBe(1);
    const log = readFileSync(diagnosticLog, 'utf8');
    expect(log).toContain('failed to load tar from app.asar');
    expect(log).toContain('failed to load tar from the module search path');
    expect(log).toContain('event=runtime-rollback-failed');
    expect(log).toContain('event=error-report-file-write-failed');
    expect(log).toContain('event=resource-install-failed');
    expect(log).toContain('Cannot load the fallback tar module');
    for (const description of [
      'injected tar loader failure', 'injected rollback failure', 'injected error report failure',
    ]) {
      const record = log.split('\n').find(line => line.includes(`error=${description}`) || line.includes(`message=${description}`));
      expect(record).toContain('code=EACCES');
      expect(record).toContain('syscall=');
      expect(record).toContain('path=');
      expect(record).toContain(`stack=Error: ${description}`);
      expect(record).toContain('cause=Error: Underlying failure cause');
    }
    expect(result.stderr).toContain('injected rollback failure');
    expect(result.stderr).toContain('injected error report failure');
  });

  it('restores PortableGit when the replacement archive is invalid', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-mingit-rollback-'));
    tempDirs.push(root);
    const installResources = path.join(root, 'installed-resources');
    const archivePath = path.join(root, 'invalid-resources.tar.zst');
    const diagnosticLogPath = path.join(root, 'install-resource.log');
    const staleBashPath = path.join(installResources, 'mingit', 'bin', 'bash.exe');
    const previousPythonPath = path.join(installResources, 'python-win', 'python.exe');

    mkdirSync(path.dirname(staleBashPath), { recursive: true });
    mkdirSync(path.dirname(previousPythonPath), { recursive: true });
    writeFileSync(staleBashPath, 'portable-git');
    writeFileSync(previousPythonPath, 'previous-python');
    writeFileSync(archivePath, 'not a tar archive');

    const result = spawnSync(
      process.execPath,
      [unpackScriptPath, archivePath, installResources, '', '', '', diagnosticLogPath],
      {
        encoding: 'utf8',
      },
    );

    expect(result.status).not.toBe(0);
    expect(existsSync(staleBashPath)).toBe(true);
    expect(readFileSync(previousPythonPath, 'utf8')).toBe('previous-python');
    expect(existsSync(path.join(installResources, '.mingit-upgrade-backup'))).toBe(false);
    expect(existsSync(path.join(installResources, '.python-win-upgrade-backup'))).toBe(false);
    const diagnosticLog = readFileSync(diagnosticLogPath, 'utf8');
    expect(diagnosticLog).toContain('event=runtime-upgrade-failed');
    expect(diagnosticLog).toContain('event=runtime-rollback-restored');
    expect(diagnosticLog).toContain('event=resource-install-failed');
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

  it('keeps verified runtimes when the unused legacy Python directory cannot be removed', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-legacy-python-cleanup-'));
    tempDirs.push(root);
    const archiveRoot = path.join(root, 'archive');
    const installResources = path.join(root, 'installed-resources');
    const userDataRoot = path.join(root, 'user-data');
    const legacyPythonRoot = path.join(userDataRoot, 'runtimes', 'python-win');
    const archivePath = path.join(root, 'win-resources.tar');
    const diagnosticLogPath = path.join(root, 'install-resource.log');
    const faultPreloadPath = path.join(root, 'fail-legacy-python-cleanup.cjs');

    mkdirSync(path.join(archiveRoot, 'cfmind'), { recursive: true });
    mkdirSync(path.join(archiveRoot, 'mingit', 'cmd'), { recursive: true });
    mkdirSync(legacyPythonRoot, { recursive: true });
    writePythonRuntimeFixture(path.join(archiveRoot, 'python-win'));
    writeFileSync(path.join(archiveRoot, 'cfmind', 'package.json'), 'new-cfmind');
    writeFileSync(path.join(archiveRoot, 'mingit', 'cmd', 'git.exe'), 'new-git');
    writeFileSync(path.join(legacyPythonRoot, 'python.exe'), 'legacy-python');
    createTar({ cwd: archiveRoot, file: archivePath, sync: true }, [
      'cfmind',
      'mingit',
      'python-win',
    ]);
    writeFileSync(
      faultPreloadPath,
      `const fs = require('fs');
const path = require('path');
const blockedRoot = ${JSON.stringify(legacyPythonRoot)};
const originalRemove = fs.rmSync;
fs.rmSync = (target, options) => {
  if (path.resolve(target) === path.resolve(blockedRoot)) {
    const error = new Error('injected legacy Python lock');
    error.code = 'EPERM';
    throw error;
  }
  return originalRemove(target, options);
};
`,
    );

    const result = spawnSync(
      process.execPath,
      [
        '--require',
        faultPreloadPath,
        unpackScriptPath,
        archivePath,
        installResources,
        userDataRoot,
        '',
        '',
        diagnosticLogPath,
      ],
      { encoding: 'utf8' },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path.join(installResources, 'cfmind', 'package.json'), 'utf8')).toBe(
      'new-cfmind',
    );
    expect(existsSync(legacyPythonRoot)).toBe(true);
    const diagnosticLog = readFileSync(diagnosticLogPath, 'utf8');
    expect(diagnosticLog).not.toContain('legacy-python-runtime-cleanup-skipped');
    expect(diagnosticLog).not.toContain('unable to remove unused legacy Python runtime');
    expect(diagnosticLog).toContain('event=resource-install-complete');
    expect(diagnosticLog).not.toContain('event=runtime-upgrade-failed');
    for (const output of [result.stdout, result.stderr]) {
      expect(output).not.toContain('legacy-python-runtime-cleanup-skipped');
      expect(output).not.toContain('unable to remove unused legacy Python runtime');
    }
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
  it('offers destructive user-data removal as an unchecked uninstall option', () => {
    expect(builderConfig.nsis?.deleteAppDataOnUninstall).toBe(false);
    expect(nsisScript).toContain('!macro customUnInstallSection');
    expect(nsisScript).toContain('Section /o "un.$(JustDoDeleteUserData)"');
    expect(nsisScript).toContain('Delete all local user data');
    expect(nsisScript).toContain('删除所有本机用户数据');
    expect(nsisScript).toContain('刪除所有本機使用者資料');
    expect(nsisScript).toContain('Function un.JustDoDeleteCurrentUserData');
    expect(nsisScript).toContain('UAC_AsUser_Call Function un.JustDoDeleteCurrentUserData');
    expect(nsisScript).toContain('${If} ${isUpdated}');
    expect(nsisScript).not.toContain('MB_RETRYIGNORE');
    expect(nsisScript).toContain('keep the remaining files and finish uninstalling');
    expect(nsisScript).toContain('-RequireDesktopUser');
    expect(nsisScript).toContain('User data preserved: desktop account could not be confirmed.');
    expect(userDataHelper).toContain('$desktopOwners[0] -ne $currentSid');
    expect(nsisScript).not.toContain('RMDir /r "$APPDATA\\${PRODUCT_NAME}"');
    expect(nsisScript).not.toContain('RMDir /r "$PROFILE\\${APP_FILENAME}\\project"');
    expect(userDataHelper).toContain('[IO.FileAttributes]::ReparsePoint');
    expect(userDataHelper).toContain('[IO.Directory]::Delete($item.FullName, $false)');
    expect(userDataHelper).not.toContain('Remove-Item -Recurse');
  });

  it('rejects the legacy deletion bypass before uninstall removes files', () => {
    const start = nsisScript.indexOf('!macro customUnInit');
    const unInit = nsisScript.slice(start, nsisScript.indexOf('!macroend', start));
    expect(unInit).toContain('${GetOptions} $0 "--delete-app-data" $1');
    expect(unInit).toContain('SetErrorLevel 2');
    expect(unInit.indexOf('Quit')).toBeLessThan(unInit.indexOf('InitPluginsDir'));
  });

  it('defines the uninstall option for every electron-builder bundled language', () => {
    const languageIds = [
      1033, 1031, 1036, 3082, 2052, 1028, 1041, 1042, 1040, 1043, 1030, 1053, 1044, 1035, 1049,
      2070, 1046, 1045, 1058, 1029, 1051, 1038, 1025, 1055, 1054, 1066,
    ];
    const definedIds = Array.from(
      nsisScript.matchAll(/LangString JustDoDeleteUserData (\d+) /g),
      match => Number(match[1]),
    );

    expect(definedIds).toHaveLength(languageIds.length);
    expect(new Set(definedIds)).toEqual(new Set(languageIds));
  });

  it.runIf(process.platform === 'win32')(
    'deletes owned user data without traversing a junction',
    () => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-user-data-delete-'));
      tempDirs.push(root);
      const roaming = path.join(root, 'Roaming');
      const local = path.join(root, 'Local');
      const outside = path.join(root, 'outside');
      const powershellPath = path.join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      );
      mkdirSync(path.join(roaming, 'JustDo', 'nested'), { recursive: true });
      mkdirSync(path.join(local, 'JustDo'), { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(path.join(roaming, 'JustDo', 'nested', 'owned.txt'), 'owned');
      writeFileSync(path.join(outside, 'must-survive.txt'), 'safe');
      symlinkSync(outside, path.join(roaming, 'JustDo', 'linked-outside'), 'junction');

      const result = spawnSync(
        powershellPath,
        ['-NoProfile', '-NonInteractive', '-File', userDataHelperPath, '-Names', 'JustDo|justdo'],
        {
          encoding: 'utf8',
          env: { ...process.env, APPDATA: roaming, LOCALAPPDATA: local },
        },
      );

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(existsSync(path.join(roaming, 'JustDo'))).toBe(false);
      expect(existsSync(path.join(local, 'JustDo'))).toBe(false);
      expect(readFileSync(path.join(outside, 'must-survive.txt'), 'utf8')).toBe('safe');
    },
    30_000,
  );

  it('never mutates application data during install or upgrade', () => {
    const install = nsisScript.slice(0, nsisScript.indexOf('!macro customUnInit'));
    expect(install).not.toMatch(/(?:Delete|RMDir|CopyFiles)[^\n]*CurrentUserAppData/);
    expect(unpackScript).not.toContain("path.join(userDataDir");
  });

  it.runIf(process.platform === 'win32').each([true, false])(
    'only deletes elevated profile data when the desktop account matches (%s)',
    sameAccount => {
      const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-user-data-account-'));
      tempDirs.push(root);
      const roaming = path.join(root, 'Roaming');
      const local = path.join(root, 'Local');
      const marker = path.join(roaming, 'JustDo', 'must-preserve.sqlite');
      mkdirSync(path.dirname(marker), { recursive: true });
      mkdirSync(local, { recursive: true });
      writeFileSync(marker, 'user data');
      const desktopSid = sameAccount
        ? '[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'
        : "'S-1-5-21-0-0-0-99999'";
      const command = [
        'function Get-CimInstance { [pscustomobject]@{ ProcessId = 1 } }',
        `function Invoke-CimMethod { [pscustomobject]@{ Sid = ${desktopSid} } }`,
        `& '${userDataHelperPath.replaceAll("'", "''")}' -Names JustDo -RequireDesktopUser`,
        'exit $LASTEXITCODE',
      ].join('; ');
      const result = spawnSync(
        path.join(
          process.env.SystemRoot || 'C:\\Windows',
          'System32',
          'WindowsPowerShell',
          'v1.0',
          'powershell.exe',
        ),
        ['-NoProfile', '-NonInteractive', '-Command', command],
        { encoding: 'utf8', env: { ...process.env, APPDATA: roaming, LOCALAPPDATA: local } },
      );

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(sameAccount ? 0 : 3);
      expect(existsSync(marker)).toBe(!sameAccount);
    },
    30_000,
  );

  it('keeps both install modes but re-enters interactive elevated launches through the desktop user', () => {
    const preInit = nsisScript.slice(
      nsisScript.indexOf('!macro preInit'),
      nsisScript.indexOf('!macroend', nsisScript.indexOf('!macro preInit')),
    );

    expect(builderConfig.nsis?.perMachine).toBeUndefined();
    expect(builderConfig.nsis?.allowElevation).toBeUndefined();
    expect(builderConfig.nsis?.packElevateHelper).toBeUndefined();
    expect(nsisScript).not.toContain('!macro customInstallMode');
    expect(preInit).toContain('${StdUtils.ExecShellAsUser}');
    expect(preInit).toContain('--justdo-current-user-bootstrap');
    expect(preInit).toContain('${If} ${UAC_IsAdmin}');
    expect(preInit).toContain('${AndIfNot} ${UAC_IsInnerInstance}');
    expect(preInit).toContain('${GetOptions} $0 "/currentuser" $1');
    expect(preInit).toContain('${GetOptions} $0 "/allusers" $1');
    expect(preInit).toContain('${AndIf} $2 != "1"');
    expect(preInit.indexOf('${If} ${Silent}')).toBeLessThan(
      preInit.indexOf('${StdUtils.ExecShellAsUser}'),
    );
    expect(preInit).toMatch(
      /\$\{If\} \$\{Silent\}(?:(?!\$\{EndIf\})[\s\S])*Goto JustDoAccountBootstrapComplete/,
    );
    expect(preInit).toContain('JustDoBootstrapAllUsers:');
    expect(preInit).toContain('/allusers $0');
    expect(preInit.indexOf('${StdUtils.ExecShellAsUser}')).toBeLessThan(
      preInit.indexOf('StrCpy $JustDoCurrentUserAppData "$APPDATA"'),
    );
    expect(nsisScript).toContain(
      'UAC_AsUser_Call Function JustDoReadDesktopUserPaths ${UAC_SYNCREGISTERS}',
    );
    expect(nsisScript).toContain('!insertmacro JustDoTryInstallLogDirectory "$JustDoCurrentUserAppData" "${PRODUCT_NAME}"');
  });

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

  it('shows measured progress and freezes at the last real value when unavailable', () => {
    const pageShow = nsisScript.slice(
      nsisScript.indexOf('Function JustDoInstFilesShow'),
      nsisScript.indexOf('FunctionEnd', nsisScript.indexOf('Function JustDoInstFilesShow')),
    );
    expect(pageShow).toContain('ShowWindow $JustDoProgressBar 0');
    expect(pageShow).toContain('ShowWindow $JustDoNativeProgressBar 5');
    expect(pageShow).toContain('SendMessage $HWNDPARENT ${JUSTDO_WM_SETREDRAW} 0 0');
    expect(pageShow).toContain('SendMessage $HWNDPARENT ${JUSTDO_WM_SETREDRAW} 1 0');
    expect(pageShow).toContain('user32::RedrawWindow');
    expect(pageShow).not.toContain('Call JustDoCheckAppRunning');
    expect(nsisScript).toContain('SendMessage $JustDoProgressBar ${JUSTDO_PBM_SETMARQUEE} 0 0');
    expect(nsisScript).not.toContain(
      'SendMessage $JustDoProgressBar ${JUSTDO_PBM_SETMARQUEE} 1 35',
    );
    expect(nsisScript).toContain('StrCpy $JustDoLastResourceProgress $2');
    expect(nsisScript).toContain('${JUSTDO_PBM_SETPOS} $JustDoLastResourceProgress 0');

    expect(nsisScript).not.toContain('JustDoSetInstallProgress');
    expect(nsisScript).toContain('Reading core resources: $2%');
    expect(nsisScript).not.toContain('actual compressed bytes');
    expect(nsisScript).toContain('no exact percentage is available. Setup is still working');
    expect(nsisScript).toContain('${JUSTDO_PBM_SETPOS} $2 0');
    expect(nsisScript).toContain('${JUSTDO_PBM_SETPOS} 100 0');
    expect(unpackScript).not.toContain('reportProgress(50');
    expect(unpackScript).toContain("'determinate'");
    expect(unpackScript).toContain("'indeterminate'");
  });

  it('keeps resource extraction responsive with heartbeat activity', () => {
    expect(nsisScript).toContain('Call JustDoLaunchResourceExtractor');
    expect(nsisScript).toContain('WaitForSingleObject(p $JustDoExtractorProcessHandle, i 0)');
    expect(nsisScript).toContain('WaitForSingleObject(p $JustDoExtractorProcessHandle, i -1)');
    expect(nsisScript).toContain('justdo-resource-progress.txt');
    expect(nsisScript).toContain('Function JustDoPollResourceProgress');
    expect(nsisScript).toContain('Call JustDoPollResourceProgress');
    expect(nsisScript).toContain('GetExitCodeProcess(p $JustDoExtractorProcessHandle');
    expect(nsisScript).not.toContain('process-status-error');
    expect(nsisScript).toContain('JustDoAddInstallActivity');
    expect(unpackScript).toContain("path.join(windowsRoot, 'System32', 'tar.exe')");
    expect(unpackScript).toContain("endsWith('.zst')");
    expect(unpackScript).toContain("['-xf', '-', '-C', destDir]");
    expect(unpackScript).toContain('createZstdDecompress()');
    expect(unpackScript).toContain('child.stdin');
    expect(unpackScript).toContain('Expanding core resources - ${elapsedSeconds}s elapsed');
    expect(unpackScript).toContain('Reading compressed core resources - ${roundedPercent}%');
    expect(nsisScript).toContain('JUSTDO_PBM_SETMARQUEE} 0 0');
    expect(unpackScript).toContain('createEntryProgressReporter');
    expect(unpackScript).toContain('reportProgress(');
    expect(unpackScript).toContain('onentry: entryProgress.onEntry');
    expect(unpackScript).toContain('resource entries ready');
    expect(unpackScript).toContain('Keep this stream ASCII-only');
    expect(unpackScript).not.toContain("activity('●");
  });

  it('isolates extractor temporary files without imposing disk reserves or deadlines', () => {
    expect(nsisScript).toContain('$JustDoExtractorTempDirectory\\justdo-resource-progress.txt');
    expect(nsisScript).not.toContain('RMDir /r "$JustDoExtractorTempDirectory"');
    expect(unpackScript).toContain('function cleanupManagedInstallerTempRoot');
    expect(unpackScript).not.toContain('createDiskGrowthGuard');
    expect(unpackScript).not.toContain('INSTALL_TIMEOUT_MS');
    expect(nsisScript).not.toContain('JUSTDO_INSTALLER_PYTHON_IMPORT_CHECK');
  });

  it('persists privacy-safe diagnostics across early setup and resource extraction', () => {
    expect(nsisScript).toContain('Function JustDoWriteInstallEvent');
    expect(nsisScript).toContain('kernel32::GetTickCount()i.r1');
    expect(nsisScript).toContain('phase=process-check-start');
    expect(nsisScript).toContain('phase=electron-builder-core-start');
    expect(nsisScript).toContain('phase=electron-builder-core-returned duration-ms=$1');
    expect(nsisScript).toContain('phase=electron-builder-core-validation-complete result=passed');
    expect(nsisScript).toContain('phase=installer-failed status=terminated-before-success');
    expect(nsisScript).toContain('Function .onInstSuccess');
    expect(nsisScript).toContain('Function .onGUIEnd');
    expect(nsisScript).toContain('!define MUI_CUSTOMFUNCTION_ABORT JustDoInstallerUserAbort');
    expect(nsisScript).toContain('phase=installer-success status=completed');
    expect(nsisScript).toContain('phase=installer-session-end terminal-state=');
    expect(nsisScript).toContain('INSTALL SESSION START | timestamp=');
    expect(nsisScript).toContain('INSTALL SESSION END | timestamp=');
    expect(nsisScript).toContain('!insertmacro JustDoOpenAppendLog $2 "$JustDoInstallLogPath"');
    expect(nsisScript).toContain('!insertmacro JustDoOpenAppendLog $2 "$JustDoResourceLogPath"');
    expect(nsisScript).not.toContain('FileOpen $2 "$JustDoInstallLogPath" w');
    expect(nsisScript).not.toContain('FileOpen $2 "$JustDoResourceLogPath" w');
    expect(nsisScript).not.toContain('Delete "$JustDoInstallLogPath"');
    expect(nsisScript).not.toContain('Delete "$JustDoResourceLogPath"');
    expect(nsisScript).toContain('install-resource.log');
    expect(nsisScript).toContain('"$JustDoResourceLogPath"');
    expect(nsisScript).toContain('command-line: omitted-for-privacy');
    expect(nsisScript).not.toContain('cmdline: $CMDLINE');
    expect(unpackScript).toContain('function writeDiagnostic');
    expect(unpackScript).toContain("'resource-install-start'");
    expect(unpackScript).toContain("'runtime-upgrade-failed'");
    expect(unpackScript).toContain("'resource-install-failed'");
    expect(unpackScript).toContain("writeDiagnosticBoundary('START')");
    expect(unpackScript).toContain("writeDiagnosticBoundary('END', 'success')");
  });

  it('appends separated resource diagnostics across repeated installer sessions', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'justdo-resource-log-append-'));
    tempDirs.push(root);
    const diagnosticLogPath = path.join(root, 'install-resource.log');
    const missingArchive = path.join(root, 'missing.tar.zst');
    const destination = path.join(root, 'resources');
    writeFileSync(diagnosticLogPath, 'existing-session-must-survive\n');

    for (const sessionId of ['session-one', 'session-two']) {
      const result = spawnSync(
        process.execPath,
        [
          unpackScriptPath,
          missingArchive,
          destination,
          path.join(root, 'user-data'),
          '',
          '',
          diagnosticLogPath,
          sessionId,
          'v-test',
        ],
        { encoding: 'utf8' },
      );
      expect(result.status).toBe(1);
    }

    const log = readFileSync(diagnosticLogPath, 'utf8');
    expect(log).toContain('existing-session-must-survive');
    expect(log.match(/RESOURCE INSTALL SESSION START/g)).toHaveLength(2);
    expect(log.match(/RESOURCE INSTALL SESSION END/g)).toHaveLength(2);
    expect(log).toContain('session=session-one');
    expect(log).toContain('session=session-two');
    expect(log).toContain('status=archive-missing');
  });

  it('writes installer logs only to Roaming without making logging a prerequisite', () => {
    const preInit = nsisScript.slice(
      nsisScript.indexOf('!macro preInit'),
      nsisScript.indexOf('!macroend', nsisScript.indexOf('!macro preInit')),
    );
    const selector = nsisScript.slice(
      nsisScript.indexOf('Function JustDoSelectInstallLogDirectory'),
      nsisScript.indexOf(
        'FunctionEnd',
        nsisScript.indexOf('Function JustDoSelectInstallLogDirectory'),
      ),
    );

    expect(preInit).toContain('StrCpy $JustDoCurrentUserAppData "$APPDATA"');
    expect(preInit).toContain('StrCpy $JustDoCurrentUserLocalAppData "$LOCALAPPDATA"');
    expect(preInit).toContain('Call JustDoSelectInstallLogDirectory');
    expect(nsisScript).not.toContain('logging-unavailable');
    expect(nsisScript).not.toContain('Abort "Required installer log');
    expect(selector).toContain('$JustDoCurrentUserAppData');
    expect(selector).not.toContain('$JustDoCurrentUserLocalAppData');
    expect(selector).not.toContain('$JustDoCurrentTemp');
    expect(selector).not.toContain('$JustDoInstallerDirectory');
    expect(nsisScript.match(/FileOpen \$2 "NUL" w/g)).toHaveLength(3);
    expect(nsisScript).toContain('phase=install-log-relocated');
  });

  it('retrieves captured desktop paths before opening any inner-instance log handle', () => {
    const reader = nsisScript.slice(
      nsisScript.indexOf('Function JustDoReadDesktopUserPaths'),
      nsisScript.indexOf('FunctionEnd', nsisScript.indexOf('Function JustDoReadDesktopUserPaths')),
    );
    const customInit = nsisScript.slice(
      nsisScript.indexOf('!macro customInit'),
      nsisScript.indexOf('!macroend', nsisScript.indexOf('!macro customInit')),
    );
    expect(reader).toContain('StrCpy $0 "$JustDoCurrentUserAppData"');
    expect(reader).toContain('StrCpy $1 "$JustDoCurrentUserLocalAppData"');
    expect(reader).toContain('StrCpy $3 "$JustDoCurrentTemp"');
    expect(reader).not.toContain('"$APPDATA"');
    expect(customInit.indexOf('UAC_AsUser_Call Function JustDoReadDesktopUserPaths')).toBeLessThan(
      customInit.indexOf('$2 "$JustDoInstallLogPath"'),
    );
  });

  it('runs UAC inner process preparation only after the final directory is normalized', () => {
    const customInit = nsisScript.slice(
      nsisScript.indexOf('!macro customInit'),
      nsisScript.indexOf('!macroend', nsisScript.indexOf('!macro customInit')),
    );
    const instFilesPre = nsisScript.slice(
      nsisScript.indexOf('Function JustDoInstFilesPre'),
      nsisScript.indexOf('FunctionEnd', nsisScript.indexOf('Function JustDoInstFilesPre')),
    );

    expect(customInit).toMatch(
      /\$\{If\} \$\{Silent\}[\s\S]*StrCpy \$JustDoInstallMode "\$installMode"[\s\S]*\$\{If\} \$\{UAC_IsInnerInstance\}[\s\S]*Call JustDoCheckAppRunning/,
    );
    expect(nsisScript).toContain('!define MUI_PAGE_CUSTOMFUNCTION_PRE JustDoInstFilesPre');
    expect(instFilesPre).toContain('Call instFilesPre');
    expect(instFilesPre).toContain('StrCpy $JustDoInstallMode "$installMode"');
    expect(instFilesPre).toMatch(
      /Call instFilesPre[\s\S]*\$\{If\} \$\{UAC_IsInnerInstance\}[\s\S]*Call JustDoCheckAppRunning/,
    );
  });

  it('throws when the fallback tar module is unavailable so the transaction can roll back', () => {
    const loadTarModule = unpackScript.slice(
      unpackScript.indexOf('function loadTarModule()'),
      unpackScript.indexOf('\n}', unpackScript.indexOf('function loadTarModule()')) + 2,
    );

    expect(loadTarModule).toContain("'tar-module-unavailable'");
    expect(loadTarModule).toContain('throw new Error');
    expect(loadTarModule).not.toContain('process.exit');
  });

  it('reports a missing main executable before starting resource extraction', () => {
    const customInstall = nsisScript.slice(
      nsisScript.indexOf('!macro customInstall'),
      nsisScript.indexOf('!macroend', nsisScript.indexOf('!macro customInstall')),
    );
    const executableCheck = customInstall.indexOf(
      '${IfNot} ${FileExists} "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"',
    );
    const resourceLaunch = customInstall.indexOf('Call JustDoLaunchResourceExtractor');

    expect(executableCheck).toBeGreaterThan(-1);
    expect(resourceLaunch).toBeGreaterThan(executableCheck);
    expect(customInstall).toContain('reason=core-payload-missing component=$R6');
    expect(customInstall).toContain('resource-unpack-script');
    expect(customInstall).toContain('resource-archive');
    expect(customInstall).toContain('resource-metadata');
    expect(customInstall).not.toContain('better-sqlite3-native-module');
    expect(customInstall).toContain('文件被安全软件拦截');
  });

  it('reassures users while native archive extraction is busy', () => {
    expect(nsisScript).toContain('正在准备应用组件；进度条显示当前解压/写入进度');
    expect(nsisScript).toContain('正在将应用文件解压到安全临时目录并写入安装位置');
    expect(nsisScript).not.toContain('真实压缩字节进度');
    expect(nsisScript).not.toContain('进度到 100% 后仍');
    expect(nsisScript).not.toContain('security scanning can leave the bar at 100%');
    expect(nsisScript).not.toContain('正在解压大型应用资源');
    expect(nsisScript).not.toContain('JustDoRefreshArchiveProgress');
  });
});
