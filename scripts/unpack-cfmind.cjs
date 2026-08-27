#!/usr/bin/env node

/**
 * Windows 安装后资源 tar 解压脚本
 *
 * 由 NSIS installer.nsh 的 customInstall 宏调用。
 * 通过 JustDo.exe (ELECTRON_RUN_AS_NODE=1 模式) 执行。
 *
 * 用法: JustDo.exe <本脚本路径> <tarPath> <destDir> <userDataDir>
 *                   <metadataPath> <progressPath> <diagnosticLogPath>
 *
 * 效果:
 *   输入: $INSTDIR/resources/win-resources.tar.zst
 *   输出: $INSTDIR/resources/cfmind/, python-win/, mingit/
 *   tar.zst 和进度 metadata 文件由 NSIS 脚本在解压后删除
 *
 * Electron/Node 流式解码 zstd，优先把裸 tar 流交给系统 tar.exe；系统
 * tar 缺失时从 app.asar 加载 tar npm 包继续流式展开。
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { createZstdDecompress } = require('zlib');

// ============================================================
// 参数解析
// ============================================================

const tarPath = process.argv[2];
const destDir = process.argv[3];
const userDataDir = process.argv[4];
const metadataPath = process.argv[5];
const progressPath = process.argv[6];
const diagnosticLogPath = process.argv[7];
const diagnosticStartedAt = Date.now();
let progressWriteWarningShown = false;
let lastProgressPercent = null;
let lastProgressMode = 'indeterminate';
let diagnosticWriteWarningShown = false;

function sanitizeDiagnosticValue(value) {
  return String(value ?? '')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .slice(0, 8192);
}

function writeDiagnostic(level, event, details = {}) {
  if (!diagnosticLogPath) return;

  const detailText = Object.entries(details)
    .map(([key, value]) => `${key}=${sanitizeDiagnosticValue(value)}`)
    .join(' ');
  const line = [
    new Date().toISOString(),
    `elapsed-ms=${Date.now() - diagnosticStartedAt}`,
    `level=${level}`,
    `event=${event}`,
    detailText,
  ]
    .filter(Boolean)
    .join(' ');

  try {
    fs.mkdirSync(path.dirname(diagnosticLogPath), { recursive: true });
    fs.appendFileSync(diagnosticLogPath, `${line}\n`, 'utf8');
  } catch (error) {
    if (!diagnosticWriteWarningShown) {
      console.error(`[unpack-cfmind] Warning: unable to write diagnostic log: ${error.message}`);
      diagnosticWriteWarningShown = true;
    }
  }
}

function diagnosticWarning(message, error) {
  writeDiagnostic('warn', 'warning', {
    message,
    error: error?.message || '',
    code: error?.code || '',
  });
  console.error(`[unpack-cfmind] Warning: ${message}${error ? `: ${error.message}` : ''}`);
}

function activity(text) {
  // nsExec reads redirected output using the active Windows code page while
  // Node writes UTF-8. Keep this stream ASCII-only to prevent mojibake. The
  // surrounding NSIS milestones remain fully localized Unicode strings.
  writeDiagnostic('info', 'activity', { message: text });
  console.log(text);
}

function reportProgress(percent, text, mode = 'indeterminate') {
  const normalizedMode = mode === 'determinate' ? 'determinate' : 'indeterminate';
  const normalizedPercent =
    normalizedMode === 'determinate' && Number.isFinite(percent)
      ? Math.max(0, Math.min(100, Math.round(percent)))
      : null;
  lastProgressPercent = normalizedPercent;
  lastProgressMode = normalizedMode;
  writeDiagnostic('info', 'progress', {
    mode: normalizedMode,
    percent: normalizedPercent ?? 'unavailable',
    message: text,
  });
  if (!progressPath) return;

  const temporaryPath = `${progressPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(
      temporaryPath,
      `${normalizedMode}\n${normalizedPercent ?? ''}\n${text}`,
      'utf8',
    );
    fs.renameSync(temporaryPath, progressPath);
  } catch (error) {
    if (!progressWriteWarningShown) {
      diagnosticWarning('unable to report progress', error);
      progressWriteWarningShown = true;
    }
  }
}

function readArchiveMetadata() {
  if (!metadataPath || !fs.existsSync(metadataPath)) {
    writeDiagnostic('warn', 'archive-metadata-unavailable', {
      path: metadataPath || 'none',
    });
    return null;
  }

  try {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    if (metadata.schemaVersion !== 1 || !Number.isInteger(metadata.totalEntries)) {
      writeDiagnostic('warn', 'archive-metadata-invalid', { reason: 'schema-or-entry-count' });
      return null;
    }
    if (metadata.totalEntries <= 0) {
      writeDiagnostic('warn', 'archive-metadata-invalid', { reason: 'non-positive-entry-count' });
      return null;
    }
    writeDiagnostic('info', 'archive-metadata-read', {
      schemaVersion: metadata.schemaVersion,
      totalEntries: metadata.totalEntries,
    });
    return metadata;
  } catch (error) {
    diagnosticWarning('unable to read archive metadata', error);
    return null;
  }
}

function createEntryProgressReporter(totalEntries) {
  let extractedEntries = 0;
  let lastReportedPercent = -1;

  const onEntry = () => {
    extractedEntries += 1;
    const extractionPercent = totalEntries
      ? Math.min(100, Math.floor((extractedEntries / totalEntries) * 100))
      : null;

    if (
      (extractionPercent !== null && extractionPercent !== lastReportedPercent) ||
      extractedEntries % 500 === 0
    ) {
      const totalSuffix = totalEntries ? ` of ${totalEntries.toLocaleString('en-US')}` : '';
      reportProgress(
        extractionPercent,
        `Prepared ${extractedEntries.toLocaleString('en-US')}${totalSuffix} resource entries`,
        extractionPercent === null ? 'indeterminate' : 'determinate',
      );
      lastReportedPercent = extractionPercent;
    }
    if (extractedEntries % 1000 === 0) {
      activity(`Prepared ${extractedEntries.toLocaleString('en-US')} resource entries`);
    }
  };

  return {
    complete() {
      if (totalEntries) extractedEntries = totalEntries;
      reportProgress(
        totalEntries ? 100 : null,
        `${extractedEntries.toLocaleString('en-US')} resource entries expanded`,
        totalEntries ? 'determinate' : 'indeterminate',
      );
    },
    get count() {
      return extractedEntries;
    },
    onEntry,
  };
}

async function extractArchive(entryProgress) {
  const windowsRoot = process.env.SystemRoot || process.env.WINDIR;
  const nativeTarPath = windowsRoot ? path.join(windowsRoot, 'System32', 'tar.exe') : '';
  const nativeTarDisabled = process.env.JUSTDO_INSTALLER_DISABLE_NATIVE_TAR === '1';
  const isZstd = tarPath.toLowerCase().endsWith('.zst');
  const extractionStartedAt = Date.now();

  if (
    process.platform === 'win32' &&
    !nativeTarDisabled &&
    nativeTarPath &&
    fs.existsSync(nativeTarPath)
  ) {
    activity('Using Windows native resource extraction...');
    writeDiagnostic('info', 'archive-extractor-selected', {
      extractor: 'windows-native-tar',
      executable: nativeTarPath,
      input: isZstd ? 'zstd-decoded-stdin' : 'archive-file',
    });
    const archiveFlag = tarPath.toLowerCase().endsWith('.gz') ? '-xzf' : '-xf';
    const child = spawn(
      nativeTarPath,
      isZstd ? ['-xf', '-', '-C', destDir] : [archiveFlag, tarPath, '-C', destDir],
      {
        windowsHide: true,
        stdio: [isZstd ? 'pipe' : 'ignore', 'ignore', 'pipe'],
      },
    );
    writeDiagnostic('info', 'archive-extractor-started', {
      extractor: 'windows-native-tar',
      pid: child.pid || '',
    });
    let stderr = '';
    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
      const elapsedSeconds = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
      reportProgress(
        lastProgressPercent,
        `Expanding core resources - ${elapsedSeconds}s elapsed`,
        lastProgressMode,
      );
    }, 1000);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      if (stderr.length < 16_384) stderr += chunk;
    });

    const processResultPromise = new Promise(resolve => {
      child.once('error', error => resolve({ code: null, error }));
      child.once('close', code => resolve({ code, error: null }));
    });
    const archiveSize = fs.statSync(tarPath).size;
    let archiveBytesRead = 0;
    let lastArchivePercent = -1;
    const archiveReadProgress = new Transform({
      transform(chunk, encoding, callback) {
        archiveBytesRead += chunk.length;
        const percent = archiveSize > 0 ? Math.min(100, (archiveBytesRead / archiveSize) * 100) : 0;
        const roundedPercent = Math.round(percent);
        if (roundedPercent !== lastArchivePercent) {
          reportProgress(
            percent,
            `Reading compressed core resources - ${roundedPercent}%`,
            'determinate',
          );
          lastArchivePercent = roundedPercent;
        }
        callback(null, chunk);
      },
    });
    const pumpResultPromise = isZstd
      ? pipeline(
          fs.createReadStream(tarPath),
          archiveReadProgress,
          createZstdDecompress(),
          child.stdin,
        ).then(
          () => {
            reportProgress(null, 'Compressed resources read; writing extracted files');
            return null;
          },
          error => error,
        )
      : Promise.resolve(null);

    let processResult;
    let pumpError;
    try {
      [processResult, pumpError] = await Promise.all([processResultPromise, pumpResultPromise]);
    } finally {
      clearInterval(heartbeat);
    }

    if (processResult.error || processResult.code !== 0 || pumpError) {
      const detail = stderr.trim();
      writeDiagnostic('error', 'archive-extractor-failed', {
        extractor: 'windows-native-tar',
        exitCode: processResult.code ?? 'unavailable',
        processError: processResult.error?.message || '',
        pumpError: pumpError?.message || '',
        stderr: detail,
      });
      const causes = [];
      if (processResult.error) causes.push(`process launch: ${processResult.error.message}`);
      if (processResult.code !== 0) {
        causes.push(`tar exit code ${processResult.code}${detail ? `: ${detail}` : ''}`);
      }
      if (pumpError) causes.push(`zstd stream: ${pumpError.message}`);
      throw new Error(`Windows resource extraction failed (${causes.join('; ')})`);
    }
    entryProgress.complete();
    reportProgress(null, 'Core resource files expanded; validating runtimes');
    writeDiagnostic('info', 'archive-extractor-complete', {
      extractor: 'windows-native-tar',
      durationMs: Date.now() - extractionStartedAt,
      exitCode: processResult.code,
    });
    return;
  }

  activity('Windows native tar is unavailable; using the compatible extractor...');
  writeDiagnostic('info', 'archive-extractor-selected', {
    extractor: 'npm-tar',
    nativeTarCandidate: nativeTarDisabled ? 'disabled' : nativeTarPath || 'unavailable',
    input: isZstd ? 'zstd-decoded-stream' : 'archive-file',
  });
  const tar = loadTarModule();
  if (isZstd) {
    await pipeline(
      fs.createReadStream(tarPath),
      createZstdDecompress(),
      tar.extract({
        cwd: destDir,
        onentry: entryProgress.onEntry,
      }),
    );
  } else {
    await tar.extract({
      file: tarPath,
      cwd: destDir,
      onentry: entryProgress.onEntry,
    });
  }
  entryProgress.complete();
  writeDiagnostic('info', 'archive-extractor-complete', {
    extractor: 'npm-tar',
    durationMs: Date.now() - extractionStartedAt,
  });
}

if (!tarPath || !destDir) {
  writeDiagnostic('error', 'invalid-arguments', {
    tarPathPresent: Boolean(tarPath),
    destinationPresent: Boolean(destDir),
  });
  console.error('[unpack-cfmind] Usage: JustDo.exe unpack-cfmind.cjs <tarPath> <destDir>');
  process.exit(1);
}

if (!fs.existsSync(tarPath)) {
  writeDiagnostic('error', 'archive-missing', { archive: tarPath });
  console.error(`[unpack-cfmind] tar file not found: ${tarPath}`);
  process.exit(1);
}

function migrateLegacyPythonRuntime() {
  if (!userDataDir) return;
  const legacyRoot = path.join(userDataDir, 'runtimes', 'python-win');
  if (!fs.existsSync(legacyRoot)) return;

  activity('Removing legacy Python runtime...');
  try {
    fs.rmSync(legacyRoot, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 250,
    });
  } catch (error) {
    // The replacement runtime is already packaged under resources. A stale
    // userData copy is unused, so antivirus/indexer locks or an unkillable old
    // Python process must not roll back otherwise healthy extracted runtimes.
    // Keep this warning in the diagnostic log only. Cleanup is optional, so it
    // must not surface as an installer-window warning or activity message.
    writeDiagnostic('warn', 'legacy-python-runtime-cleanup-skipped', {
      message: 'unable to remove unused legacy Python runtime; leaving it in place',
      error: error?.message || '',
      code: error?.code || '',
    });
    return;
  }
  try {
    fs.rmdirSync(path.dirname(legacyRoot));
  } catch {
    // Keep the shared runtimes directory when another runtime or file uses it.
  }
}

// ============================================================
// 加载 tar 模块
// ============================================================

function loadTarModule() {
  // Strategy 1: Load from app.asar (Electron built-in ASAR read support)
  const resourcesDir = path.dirname(tarPath);
  const appAsar = path.join(resourcesDir, 'app.asar');
  const asarTarPath = path.join(appAsar, 'node_modules', 'tar');
  try {
    return require(asarTarPath);
  } catch (e) {
    diagnosticWarning('failed to load tar from app.asar', e);
  }

  // Strategy 2: Direct require (may be in NODE_PATH)
  try {
    return require('tar');
  } catch {
    // Also failed
  }

  writeDiagnostic('error', 'tar-module-unavailable', { attemptedPath: asarTarPath });
  console.error('[unpack-cfmind] Error: cannot load tar module');
  console.error(`[unpack-cfmind] Tried: ${asarTarPath}`);
  process.exit(1);
}

// ============================================================
// 执行解压
// ============================================================

async function main() {
  try {
    writeDiagnostic('info', 'resource-install-start', {
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      electron: process.versions.electron || 'none',
      zstd: process.versions.zstd || 'bundled',
      archive: tarPath,
      destination: destDir,
      metadata: metadataPath || 'none',
      progressFile: progressPath || 'none',
    });
    activity('Reading resource package...');
    reportProgress(null, 'Reading resource package');

    const archiveMetadata = readArchiveMetadata();
    const t0 = Date.now();
    const entryProgress = createEntryProgressReporter(archiveMetadata?.totalEntries);
    const archiveStat = fs.statSync(tarPath);
    writeDiagnostic('info', 'archive-inspected', {
      sizeBytes: archiveStat.size,
      totalEntries: archiveMetadata?.totalEntries || 'unknown',
    });

    // Ensure destination directory exists
    fs.mkdirSync(destDir, { recursive: true });
    try {
      const filesystem = fs.statfsSync(destDir, { bigint: true });
      writeDiagnostic('info', 'destination-filesystem-inspected', {
        availableBytes: filesystem.bavail * filesystem.bsize,
        totalBytes: filesystem.blocks * filesystem.bsize,
      });
    } catch (error) {
      diagnosticWarning('unable to inspect destination free space', error);
    }

    // Upgrades used to bundle PortableGit in this directory. Keep a same-volume
    // backup until the replacements have been extracted and validated so a failed
    // installation can restore the last working runtimes. Replace all three
    // managed runtime trees so removed files cannot survive an upgrade.
    const cfmindDir = path.join(destDir, 'cfmind');
    const cfmindBackupDir = path.join(destDir, '.cfmind-upgrade-backup');
    const minGitDir = path.join(destDir, 'mingit');
    const minGitBackupDir = path.join(destDir, '.mingit-upgrade-backup');
    const pythonDir = path.join(destDir, 'python-win');
    const pythonBackupDir = path.join(destDir, '.python-win-upgrade-backup');
    const managedRuntimes = [
      {
        name: 'OpenClaw',
        dir: cfmindDir,
        backupDir: cfmindBackupDir,
      },
      {
        name: 'Git',
        dir: minGitDir,
        backupDir: minGitBackupDir,
      },
      {
        name: 'Python',
        dir: pythonDir,
        backupDir: pythonBackupDir,
      },
    ];
    const transactionStatePath = path.join(destDir, '.runtime-upgrade-in-progress.json');
    const transactionStateTempPath = `${transactionStatePath}.tmp`;
    writeDiagnostic('info', 'runtime-state-inspected', {
      interruptedTransaction: fs.existsSync(transactionStatePath),
      existingOpenClaw: fs.existsSync(cfmindDir),
      existingGit: fs.existsSync(minGitDir),
      existingPython: fs.existsSync(pythonDir),
    });

    if (fs.existsSync(transactionStatePath)) {
      let interruptedOriginals;
      try {
        const interruptedState = JSON.parse(fs.readFileSync(transactionStatePath, 'utf8'));
        if (!Array.isArray(interruptedState.hadOriginal)) throw new Error('missing hadOriginal');
        interruptedOriginals = new Set(interruptedState.hadOriginal);
      } catch {
        // A marker is removed before a transaction is committed. If the marker
        // itself was torn by a crash, conservatively restore every available
        // healthy backup and retain unmatched current directories.
        interruptedOriginals = new Set(managedRuntimes.map(runtime => runtime.name));
      }
      activity('Recovering runtimes from an interrupted installation...');
      reportProgress(null, 'Recovering an interrupted installation');
      for (const runtime of [...managedRuntimes].reverse()) {
        if (fs.existsSync(runtime.backupDir)) {
          fs.rmSync(runtime.dir, { recursive: true, force: true });
          fs.renameSync(runtime.backupDir, runtime.dir);
        } else if (!interruptedOriginals.has(runtime.name)) {
          fs.rmSync(runtime.dir, { recursive: true, force: true });
        }
      }
      fs.rmSync(transactionStatePath, { force: true });
      writeDiagnostic('info', 'interrupted-transaction-recovered');
    }
    fs.rmSync(transactionStateTempPath, { force: true });

    // Without an active transaction marker, a remaining backup belongs to a
    // committed install whose best-effort backup cleanup was interrupted.
    for (const runtime of managedRuntimes) {
      if (!fs.existsSync(runtime.backupDir)) continue;
      if (!fs.existsSync(runtime.dir)) {
        activity(`Recovering the previous ${runtime.name} runtime backup...`);
        fs.renameSync(runtime.backupDir, runtime.dir);
        continue;
      }
      fs.rmSync(runtime.backupDir, { recursive: true, force: true });
      if (fs.existsSync(runtime.backupDir)) {
        throw new Error(`Unable to remove stale ${runtime.name} runtime backup.`);
      }
    }
    reportProgress(null, 'Previous runtime state checked');

    const hadOriginal = new Set();
    const backedUp = new Set();
    for (const runtime of managedRuntimes) {
      if (fs.existsSync(runtime.dir)) hadOriginal.add(runtime);
    }
    fs.writeFileSync(
      transactionStateTempPath,
      `${JSON.stringify({ hadOriginal: [...hadOriginal].map(runtime => runtime.name) })}\n`,
      'utf8',
    );
    fs.renameSync(transactionStateTempPath, transactionStatePath);
    reportProgress(null, 'Runtime upgrade transaction started');
    writeDiagnostic('info', 'runtime-upgrade-transaction-started', {
      originals: [...hadOriginal].map(runtime => runtime.name).join(',') || 'none',
    });

    try {
      for (const runtime of managedRuntimes) {
        if (!hadOriginal.has(runtime)) continue;
        activity(`Backing up the previous ${runtime.name} runtime...`);
        reportProgress(null, `Backing up the previous ${runtime.name} runtime`);
        fs.renameSync(runtime.dir, runtime.backupDir);
        backedUp.add(runtime);
      }

      // Windows ships a native bsdtar implementation that is substantially
      // faster at creating thousands of files on NTFS. A lightweight heartbeat
      // keeps the marquee active without slowing extraction with verbose output;
      // npm tar remains the compatibility fallback with entry-based progress.
      reportProgress(null, 'Expanding core resources');
      await extractArchive(entryProgress);
      reportProgress(null, 'Core resources expanded; validating runtimes');
      writeDiagnostic('info', 'runtime-validation-started');

      const gitCandidates = [
        path.join(minGitDir, 'cmd', 'git.exe'),
        path.join(minGitDir, 'bin', 'git.exe'),
      ];
      const installedGit = gitCandidates.find(candidate => {
        try {
          return fs.statSync(candidate).isFile() && fs.statSync(candidate).size > 0;
        } catch {
          return false;
        }
      });
      if (!installedGit) {
        throw new Error(`MinGit extraction is missing a non-empty git.exe in: ${minGitDir}`);
      }

      const requiredPythonFiles = [
        'python.exe',
        'python3.exe',
        path.join('Lib', 'site-packages', 'sitecustomize.py'),
      ];
      for (const relativePath of requiredPythonFiles) {
        const candidate = path.join(pythonDir, relativePath);
        if (
          !fs.existsSync(candidate) ||
          !fs.statSync(candidate).isFile() ||
          fs.statSync(candidate).size === 0
        ) {
          throw new Error(`Python extraction is missing required file: ${candidate}`);
        }
      }
      reportProgress(null, 'Git and Python runtime files verified');
      writeDiagnostic('info', 'runtime-files-verified', {
        gitExecutable: installedGit,
        pythonExecutable: path.join(pythonDir, 'python.exe'),
      });
      const pthFile = fs.readdirSync(pythonDir).find(name => name.endsWith('._pth'));
      if (!pthFile) {
        throw new Error(`Python extraction is missing its embedded _pth file: ${pythonDir}`);
      }
      const pthContent = fs.readFileSync(path.join(pythonDir, pthFile), 'utf8').toLowerCase();
      for (const requiredEntry of [
        'lib\\site-packages',
        'lib\\bundled-site-packages',
        'import site',
      ]) {
        if (!pthContent.includes(requiredEntry)) {
          throw new Error(`Python embedded path configuration is missing: ${requiredEntry}`);
        }
      }
      const pipModulePath = path.join(pythonDir, 'Lib', 'site-packages', 'pip', '__main__.py');
      const pipExecutableCandidates = [
        path.join(pythonDir, 'Scripts', 'pip.exe'),
        path.join(pythonDir, 'Scripts', 'pip3.exe'),
        path.join(pythonDir, 'Scripts', 'pip.cmd'),
        path.join(pythonDir, 'Scripts', 'pip3.cmd'),
        path.join(pythonDir, 'Scripts', 'pip'),
        path.join(pythonDir, 'Scripts', 'pip3'),
      ];
      if (!fs.existsSync(pipModulePath) || !pipExecutableCandidates.some(fs.existsSync)) {
        throw new Error(`Python extraction is missing pip support: ${pythonDir}`);
      }
      for (const importName of ['requests', 'yaml', 'openpyxl', 'pypdf', 'bs4']) {
        const importEntry = path.join(
          pythonDir,
          'Lib',
          'bundled-site-packages',
          importName,
          '__init__.py',
        );
        if (!fs.existsSync(importEntry) || fs.statSync(importEntry).size === 0) {
          throw new Error(`Python extraction is missing bundled package: ${importName}`);
        }
      }
      if (process.env.JUSTDO_INSTALLER_PYTHON_IMPORT_CHECK === '1') {
        const importCheckStartedAt = Date.now();
        const importCheck = spawnSync(
          path.join(pythonDir, 'python.exe'),
          ['-c', 'import pip, requests, yaml, openpyxl, pypdf, bs4'],
          {
            encoding: 'utf8',
            stdio: 'pipe',
            timeout: 60_000,
          },
        );
        if (importCheck.status !== 0) {
          const detail = (importCheck.stderr || importCheck.stdout || '').trim();
          throw new Error(`Python import validation failed${detail ? `: ${detail}` : ''}`);
        }
        writeDiagnostic('info', 'python-import-validation-complete', {
          durationMs: Date.now() - importCheckStartedAt,
          exitCode: importCheck.status,
        });
      }
      reportProgress(null, 'Python packages verified');

      const runtimePackagePath = path.join(cfmindDir, 'package.json');
      if (!fs.existsSync(runtimePackagePath) || fs.statSync(runtimePackagePath).size === 0) {
        throw new Error(
          `OpenClaw extraction is missing a non-empty package.json: ${runtimePackagePath}`,
        );
      }

      reportProgress(null, 'OpenClaw runtime verified');
      writeDiagnostic('info', 'runtime-validation-complete');
      fs.rmSync(transactionStatePath, { force: true });
      if (fs.existsSync(transactionStatePath)) {
        throw new Error(`Unable to commit runtime upgrade transaction: ${transactionStatePath}`);
      }
    } catch (error) {
      writeDiagnostic('error', 'runtime-upgrade-failed', {
        name: error.name || 'Error',
        message: error.message,
        code: error.code || '',
      });
      const rollbackErrors = [];
      for (const runtime of [...managedRuntimes].reverse()) {
        try {
          if (backedUp.has(runtime) || !hadOriginal.has(runtime)) {
            fs.rmSync(runtime.dir, { recursive: true, force: true });
          }
          if (backedUp.has(runtime) && fs.existsSync(runtime.backupDir)) {
            fs.renameSync(runtime.backupDir, runtime.dir);
            activity(`Restored the previous ${runtime.name} runtime after extraction failed.`);
          }
        } catch (rollbackError) {
          rollbackErrors.push(`${runtime.name}: ${rollbackError.message}`);
        }
      }
      if (rollbackErrors.length === 0) {
        try {
          fs.rmSync(transactionStatePath, { force: true });
          fs.rmSync(transactionStateTempPath, { force: true });
        } catch (rollbackError) {
          rollbackErrors.push(`transaction marker: ${rollbackError.message}`);
          writeDiagnostic('error', 'runtime-rollback-marker-cleanup-failed', {
            message: rollbackError.message,
            code: rollbackError.code || '',
          });
        }
      }
      if (rollbackErrors.length > 0) {
        error.message += `; rollback errors: ${rollbackErrors.join('; ')}`;
        writeDiagnostic('error', 'runtime-rollback-incomplete', {
          errors: rollbackErrors.join('; '),
        });
      } else {
        writeDiagnostic('info', 'runtime-rollback-restored');
      }
      throw error;
    }

    // Legacy userData cleanup is intentionally outside the runtime upgrade
    // transaction. Failure is non-fatal and will be retried on a later start.
    migrateLegacyPythonRuntime();

    // Validation and migration have committed the new runtimes. Backup cleanup
    // is best-effort: a cleanup failure must never roll back verified runtimes.
    reportProgress(null, 'Removing temporary runtime backups');
    for (const runtime of managedRuntimes) {
      try {
        fs.rmSync(runtime.backupDir, { recursive: true, force: true });
      } catch (error) {
        diagnosticWarning(`unable to remove ${runtime.name} runtime backup`, error);
      }
    }
    reportProgress(null, 'Temporary runtime backups removed');

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    activity(
      `${entryProgress.count.toLocaleString('en-US')} resource entries ready in ${elapsed}s`,
    );

    // Verify key directories exist
    const expectedDirs = ['cfmind'];
    for (const dir of expectedDirs) {
      const dirPath = path.join(destDir, dir);
      if (!fs.existsSync(dirPath)) {
        diagnosticWarning(`expected directory missing: ${dir}/`);
      }
    }

    activity('Core resources verified');
    reportProgress(100, 'Core resources verified', 'determinate');
    writeDiagnostic('info', 'resource-install-complete', {
      durationMs: Date.now() - t0,
      extractedEntries: entryProgress.count,
    });
    process.exit(0);
  } catch (err) {
    console.error(`[unpack-cfmind] Extraction failed: ${err.message}`);
    reportProgress(null, `Extraction failed: ${err.message}`);
    writeDiagnostic('error', 'resource-install-failed', {
      name: err.name || 'Error',
      message: err.message,
      code: err.code || '',
      stack: err.stack || '',
      progressPercent: lastProgressPercent,
    });
    process.exit(1);
  }
}

void main();
