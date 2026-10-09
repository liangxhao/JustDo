#!/usr/bin/env node

/**
 * Windows 安装后资源 tar 解压脚本
 *
 * 由 NSIS installer.nsh 的 customInstall 宏调用。
 * 通过 JustDo.exe (ELECTRON_RUN_AS_NODE=1 模式) 执行。
 *
 * 用法: JustDo.exe <本脚本路径> <tarPath> <destDir> <reserved>
 *                   <metadataPath> <progressPath> <diagnosticLogPath>
 *                   <installerSessionId> <productVersion>
 *
 * 效果:
 *   输入: $INSTDIR/resources/win-resources.tar.zst
 *   输出: $INSTDIR/resources/cfmind/, python-win/, mingit/, local-tts/
 *   tar.zst 和进度 metadata 文件由 NSIS 脚本在解压后删除
 *
 * Electron/Node 流式解码 zstd，优先把裸 tar 流交给系统 tar.exe；系统
 * tar 缺失时从 app.asar 加载 tar npm 包继续流式展开。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { createZstdDecompress } = require('zlib');
const { inspect } = require('util');

// ============================================================
// 参数解析
// ============================================================

const tarPath = process.argv[2];
const destDir = process.argv[3];
// argv[4] is reserved; setup never reads or mutates user data.
const metadataPath = process.argv[5];
const progressPath = process.argv[6];
const fallbackDiagnosticLogPath = destDir && path.join(destDir, 'install-resource.log');
const requestedDiagnosticLogPath = process.argv[7];
let diagnosticLogPath = requestedDiagnosticLogPath || fallbackDiagnosticLogPath;
const installerSessionId = process.argv[8] || 'unknown';
const productVersion = process.argv[9] || 'unknown';
const diagnosticStartedAt = Date.now();
let progressWriteWarningShown = false;
let lastProgressPercent = null;
let lastProgressMode = 'indeterminate';
let diagnosticWriteWarningShown = false;

function appendDiagnostic(content) {
  const candidates = [
    ...new Set([diagnosticLogPath, requestedDiagnosticLogPath, fallbackDiagnosticLogPath]),
  ].filter(Boolean);
  let failureDetail = '';
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(path.dirname(candidate), { recursive: true });
      const relocation = failureDetail
        ? `${new Date().toISOString()} session=${installerSessionId} event=diagnostic-log-relocated path=${candidate} error=${failureDetail}\n`
        : '';
      fs.appendFileSync(candidate, relocation + content, 'utf8');
      diagnosticLogPath = candidate;
      return;
    } catch (error) {
      failureDetail = sanitizeDiagnosticValue(
        inspect(error, {
          depth: null,
          colors: false,
          maxArrayLength: null,
          maxStringLength: null,
          customInspect: false,
          getters: false,
        }),
      );
      if (!diagnosticWriteWarningShown) {
        console.error('[unpack-cfmind] Unable to write diagnostic log:', candidate, error);
        diagnosticWriteWarningShown = true;
      }
    }
  }
}

function sanitizeDiagnosticValue(value) {
  return String(value ?? '')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

function diagnosticErrorDetails(error, prefix = '') {
  const details = {
    name: error?.name || '',
    message: error?.message || (error == null ? '' : String(error)),
    code: error?.code || '',
    syscall: error?.syscall || '',
    path: error?.path || '',
    stack: error?.stack || '',
    cause:
      error?.cause === undefined
        ? ''
        : inspect(error.cause, {
            depth: null,
            colors: false,
            maxArrayLength: null,
            maxStringLength: null,
            customInspect: false,
            getters: false,
          }),
  };
  if (!prefix) return details;
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => [
      `${prefix}${key[0].toUpperCase()}${key.slice(1)}`,
      value,
    ]),
  );
}

function writeDiagnostic(level, event, details = {}) {
  if (!diagnosticLogPath) return;

  const detailText = Object.entries(details)
    .map(([key, value]) => `${key}=${sanitizeDiagnosticValue(value)}`)
    .join(' ');
  const line = [
    new Date().toISOString(),
    `session=${sanitizeDiagnosticValue(installerSessionId)}`,
    `elapsed-ms=${Date.now() - diagnosticStartedAt}`,
    `level=${level}`,
    `event=${event}`,
    detailText,
  ]
    .filter(Boolean)
    .join(' ');

  appendDiagnostic(`${line}\n`);
}

function writeDiagnosticBoundary(kind, status = '') {
  if (!diagnosticLogPath) return;
  const separator = '='.repeat(100);
  const summary = [
    `RESOURCE INSTALL SESSION ${kind}`,
    `timestamp=${new Date().toISOString()}`,
    `session=${sanitizeDiagnosticValue(installerSessionId)}`,
    `version=${sanitizeDiagnosticValue(productVersion)}`,
    status && `status=${sanitizeDiagnosticValue(status)}`,
  ]
    .filter(Boolean)
    .join(' | ');
  appendDiagnostic(`\n${separator}\n${summary}\n${separator}\n`);
}

writeDiagnosticBoundary('START');

function diagnosticWarning(message, error, context = {}) {
  const details = diagnosticErrorDetails(error);
  writeDiagnostic('warn', 'warning', {
    ...details,
    ...context,
    message,
    error: details.message,
  });
  console.error(`[unpack-cfmind] Warning: ${message}`, error ?? '');
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
      uncompressedBytes: metadata.uncompressedBytes || 'unknown',
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
    // Resolve synchronous stream inputs before launching a writer. A failure
    // here must not leave tar running while the transaction rolls back.
    const archiveSize = fs.statSync(tarPath).size;
    const decoder = isZstd ? createZstdDecompress() : null;
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
      // Preserve the complete native error stream on disk without retaining
      // unbounded output in memory. The later summary remains at most 16 KiB.
      appendDiagnostic(
        `${new Date().toISOString()} session=${sanitizeDiagnosticValue(installerSessionId)} event=native-tar-stderr\n${chunk}\n`,
      );
      if (stderr.length < 16_384) stderr += chunk.slice(0, 16_384 - stderr.length);
    });

    let processError = null;
    const processResultPromise = new Promise(resolve => {
      child.once('error', error => {
        processError = error;
      });
      // Always wait for close before another extractor or rollback can write.
      child.once('close', code => resolve({ code, error: processError }));
    });
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
      ? pipeline(fs.createReadStream(tarPath), archiveReadProgress, decoder, child.stdin).then(
          () => {
            reportProgress(null, 'Compressed resources read; writing extracted files');
            return null;
          },
          error => {
            child.kill();
            return error;
          },
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
        ...diagnosticErrorDetails(processResult.error, 'processError'),
        ...diagnosticErrorDetails(pumpError, 'pumpError'),
        stderr: detail,
      });
      const causes = [];
      if (processResult.error) causes.push(`process launch: ${processResult.error.message}`);
      if (processResult.code !== 0) {
        causes.push(`tar exit code ${processResult.code}${detail ? `: ${detail}` : ''}`);
      }
      if (pumpError) causes.push(`zstd stream: ${pumpError.message}`);
      diagnosticWarning(
        `Windows resource extraction failed (${causes.join('; ')}); retrying with npm tar`,
      );
    } else {
      entryProgress.complete();
      reportProgress(null, 'Core resource files expanded; validating runtimes');
      writeDiagnostic('info', 'archive-extractor-complete', {
        extractor: 'windows-native-tar',
        durationMs: Date.now() - extractionStartedAt,
        exitCode: processResult.code,
      });
      return;
    }
  }

  activity('Using the compatible resource extractor...');
  writeDiagnostic('info', 'archive-extractor-selected', {
    extractor: 'npm-tar',
    nativeTarCandidate: nativeTarDisabled ? 'disabled' : nativeTarPath || 'unavailable',
    input: isZstd ? 'zstd-decoded-stream' : 'archive-file',
  });
  const tar = loadTarModule();
  const options = { cwd: destDir, strict: true, onentry: entryProgress.onEntry };
  if (isZstd) {
    await pipeline(fs.createReadStream(tarPath), createZstdDecompress(), tar.extract(options));
  } else {
    await tar.extract({ ...options, file: tarPath });
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
  writeDiagnosticBoundary('END', 'invalid-arguments');
  process.exit(1);
}

if (!fs.existsSync(tarPath)) {
  writeDiagnostic('error', 'archive-missing', { archive: tarPath });
  console.error(`[unpack-cfmind] tar file not found: ${tarPath}`);
  writeDiagnosticBoundary('END', 'archive-missing');
  process.exit(1);
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
  } catch (error) {
    diagnosticWarning('failed to load tar from the module search path', error);
  }

  writeDiagnostic('error', 'tar-module-unavailable', { attemptedPath: asarTarPath });
  throw new Error(`Cannot load the fallback tar module from ${asarTarPath}`);
}

function cleanupManagedInstallerTempRoot() {
  const configuredRoot = process.env.JUSTDO_INSTALLER_TEMP_ROOT;
  if (!configuredRoot) return;

  const managedRoot = path.resolve(configuredRoot);
  const destinationRoot = path.resolve(destDir);
  const installationRoot = path.dirname(destinationRoot);
  // GetTickCount is read through a signed NSIS integer and can be negative
  // after wraparound, producing either "pid-tick" or "pid--tick".
  const expectedName = /^\.justdo-installer-temp-\d+--?\d+$/;
  if (
    path.basename(destinationRoot).toLowerCase() !== 'resources' ||
    path.dirname(managedRoot).toLowerCase() !== installationRoot.toLowerCase() ||
    !expectedName.test(path.basename(managedRoot))
  ) {
    writeDiagnostic('warn', 'extractor-temp-cleanup-refused', {
      reason: 'path-outside-managed-boundary',
      path: managedRoot,
    });
    return;
  }
  if (!fs.existsSync(managedRoot)) return;

  const assertNoReparsePoints = currentPath => {
    const stat = fs.lstatSync(currentPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`reparse point found at ${currentPath}`);
    }
    if (!stat.isDirectory()) return;
    for (const entry of fs.readdirSync(currentPath)) {
      assertNoReparsePoints(path.join(currentPath, entry));
    }
  };

  try {
    assertNoReparsePoints(managedRoot);
    fs.rmSync(managedRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    writeDiagnostic('info', 'extractor-temp-cleanup-complete', { path: managedRoot });
  } catch (error) {
    writeDiagnostic('warn', 'extractor-temp-cleanup-incomplete', {
      ...diagnosticErrorDetails(error),
      managedTempRoot: managedRoot,
    });
    console.error(
      '[unpack-cfmind] Unable to remove installer temporary files:',
      managedRoot,
      error,
    );
  }
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
    // installation can restore the last working runtimes. Replace every
    // managed runtime trees so removed files cannot survive an upgrade.
    const cfmindDir = path.join(destDir, 'cfmind');
    const cfmindBackupDir = path.join(destDir, '.cfmind-upgrade-backup');
    const minGitDir = path.join(destDir, 'mingit');
    const minGitBackupDir = path.join(destDir, '.mingit-upgrade-backup');
    const pythonDir = path.join(destDir, 'python-win');
    const pythonBackupDir = path.join(destDir, '.python-win-upgrade-backup');
    const localTtsDir = path.join(destDir, 'local-tts');
    const localTtsBackupDir = path.join(destDir, '.local-tts-upgrade-backup');
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
      {
        name: 'LocalTts',
        dir: localTtsDir,
        backupDir: localTtsBackupDir,
      },
    ];
    const transactionStatePath = path.join(destDir, '.runtime-upgrade-in-progress.json');
    const transactionStateTempPath = `${transactionStatePath}.tmp`;
    writeDiagnostic('info', 'runtime-state-inspected', {
      interruptedTransaction: fs.existsSync(transactionStatePath),
      existingOpenClaw: fs.existsSync(cfmindDir),
      existingGit: fs.existsSync(minGitDir),
      existingPython: fs.existsSync(pythonDir),
      existingLocalTts: fs.existsSync(localTtsDir),
    });

    if (fs.existsSync(transactionStatePath)) {
      let interruptedOriginals;
      try {
        const interruptedState = JSON.parse(fs.readFileSync(transactionStatePath, 'utf8'));
        if (!Array.isArray(interruptedState.hadOriginal)) throw new Error('missing hadOriginal');
        interruptedOriginals = new Set(interruptedState.hadOriginal);
      } catch (error) {
        diagnosticWarning(
          'unable to read interrupted runtime transaction state; recovering available backups',
          error,
          {
            transactionStatePath,
          },
        );
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
        } catch (error) {
          if (error.code !== 'ENOENT') {
            diagnosticWarning('unable to inspect a Git executable candidate', error, { candidate });
          }
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
      writeDiagnostic('error', 'runtime-upgrade-failed', diagnosticErrorDetails(error));
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
          writeDiagnostic('error', 'runtime-rollback-failed', {
            ...diagnosticErrorDetails(rollbackError),
            runtime: runtime.name,
          });
          console.error(
            `[unpack-cfmind] Unable to restore the previous ${runtime.name} runtime:`,
            rollbackError,
          );
        }
      }
      if (rollbackErrors.length === 0) {
        try {
          fs.rmSync(transactionStatePath, { force: true });
          fs.rmSync(transactionStateTempPath, { force: true });
        } catch (rollbackError) {
          rollbackErrors.push(`transaction marker: ${rollbackError.message}`);
          writeDiagnostic('error', 'runtime-rollback-marker-cleanup-failed', {
            ...diagnosticErrorDetails(rollbackError),
            transactionStatePath,
          });
          console.error(
            '[unpack-cfmind] Unable to remove the runtime rollback marker:',
            rollbackError,
          );
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

    // Committed backup cleanup is best-effort.
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
    cleanupManagedInstallerTempRoot();
    writeDiagnosticBoundary('END', 'success');
    process.exit(0);
  } catch (err) {
    console.error('[unpack-cfmind] Extraction failed:', err);
    reportProgress(null, `Extraction failed: ${err.message}`);
    if (progressPath) {
      try {
        fs.writeFileSync(
          `${progressPath}.error`,
          '\uFEFF' + err.message.replace(/[\r\n]+/g, ' ').slice(0, 700),
          'utf16le',
        );
      } catch (reportError) {
        // Reporting never replaces the original extraction failure.
        writeDiagnostic('warn', 'error-report-file-write-failed', {
          ...diagnosticErrorDetails(reportError),
          reportFile: `${progressPath}.error`,
        });
        console.error('[unpack-cfmind] Unable to write the extraction error report:', reportError);
      }
    }
    writeDiagnostic('error', 'resource-install-failed', {
      ...diagnosticErrorDetails(err),
      progressPercent: lastProgressPercent,
    });
    if (!progressPath) cleanupManagedInstallerTempRoot();
    writeDiagnosticBoundary('END', 'failed');
    process.exit(1);
  }
}

void main();
