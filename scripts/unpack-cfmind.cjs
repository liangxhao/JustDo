#!/usr/bin/env node

/**
 * Windows 安装后资源 tar 解压脚本
 *
 * 由 NSIS installer.nsh 的 customInstall 宏调用。
 * 通过 JustDo.exe (ELECTRON_RUN_AS_NODE=1 模式) 执行。
 *
 * 用法: JustDo.exe <本脚本路径> <tarPath> <destDir>
 *
 * 效果:
 *   输入: $INSTDIR/resources/win-resources.tar
 *   输出: $INSTDIR/resources/cfmind/, python-win/, mingit/
 *   tar 文件由 NSIS 脚本在解压后删除
 *
 * 依赖: 从 app.asar 内加载 tar npm 包 (Electron 内置 ASAR 透明读取支持)
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ============================================================
// 参数解析
// ============================================================

const tarPath = process.argv[2];
const destDir = process.argv[3];
const userDataDir = process.argv[4];
function activity(text) {
  // nsExec reads redirected output using the active Windows code page while
  // Node writes UTF-8. Keep this stream ASCII-only to prevent mojibake. The
  // surrounding NSIS milestones remain fully localized Unicode strings.
  console.log(text);
}

if (!tarPath || !destDir) {
  console.error('[unpack-cfmind] Usage: JustDo.exe unpack-cfmind.cjs <tarPath> <destDir>');
  process.exit(1);
}

if (!fs.existsSync(tarPath)) {
  console.error(`[unpack-cfmind] tar file not found: ${tarPath}`);
  process.exit(1);
}

function migrateLegacySitePackages(source, destination) {
  if (!fs.existsSync(source) || fs.existsSync(destination)) return;
  const stagingPath = `${destination}.migrating`;
  fs.rmSync(stagingPath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, stagingPath, {
    recursive: true,
    force: true,
    errorOnExist: true,
    dereference: true,
  });
  fs.renameSync(stagingPath, destination);
}

function migrateLegacyPythonRuntime() {
  if (!userDataDir) return;
  const legacyRoot = path.join(userDataDir, 'runtimes', 'python-win');
  if (!fs.existsSync(legacyRoot)) return;

  const legacySitePackages = path.join(
    userDataDir,
    'python-user',
    'Python312',
    'legacy-site-packages',
  );
  activity('Migrating user-installed Python packages...');
  migrateLegacySitePackages(path.join(legacyRoot, 'Lib', 'site-packages'), legacySitePackages);
  fs.rmSync(legacyRoot, { recursive: true, force: true });
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
    console.error(`[unpack-cfmind] Failed to load tar from asar: ${e.message}`);
  }

  // Strategy 2: Direct require (may be in NODE_PATH)
  try {
    return require('tar');
  } catch {
    // Also failed
  }

  console.error('[unpack-cfmind] Error: cannot load tar module');
  console.error(`[unpack-cfmind] Tried: ${asarTarPath}`);
  process.exit(1);
}

// ============================================================
// 执行解压
// ============================================================

try {
  activity('Reading resource package...');

  const tar = loadTarModule();
  const t0 = Date.now();
  let extractedEntries = 0;

  // Ensure destination directory exists
  fs.mkdirSync(destDir, { recursive: true });

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
    for (const runtime of [...managedRuntimes].reverse()) {
      if (fs.existsSync(runtime.backupDir)) {
        fs.rmSync(runtime.dir, { recursive: true, force: true });
        fs.renameSync(runtime.backupDir, runtime.dir);
      } else if (!interruptedOriginals.has(runtime.name)) {
        fs.rmSync(runtime.dir, { recursive: true, force: true });
      }
    }
    fs.rmSync(transactionStatePath, { force: true });
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

  try {
    for (const runtime of managedRuntimes) {
      if (!hadOriginal.has(runtime)) continue;
      activity(`Backing up the previous ${runtime.name} runtime...`);
      fs.renameSync(runtime.dir, runtime.backupDir);
      backedUp.add(runtime);
    }

    // Extract tar using npm tar package (handles long paths, symlinks, etc.)
    tar.extract({
      file: tarPath,
      cwd: destDir,
      sync: true,
      onentry: () => {
        extractedEntries += 1;
        if (extractedEntries % 750 === 0) {
          activity(`Prepared ${extractedEntries.toLocaleString('en-US')} resource entries`);
        }
      },
    });

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
    }

    const runtimePackagePath = path.join(cfmindDir, 'package.json');
    if (!fs.existsSync(runtimePackagePath) || fs.statSync(runtimePackagePath).size === 0) {
      throw new Error(
        `OpenClaw extraction is missing a non-empty package.json: ${runtimePackagePath}`,
      );
    }

    migrateLegacyPythonRuntime();
    fs.rmSync(transactionStatePath, { force: true });
    if (fs.existsSync(transactionStatePath)) {
      throw new Error(`Unable to commit runtime upgrade transaction: ${transactionStatePath}`);
    }
  } catch (error) {
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
    if (rollbackErrors.length > 0) {
      error.message += `; rollback errors: ${rollbackErrors.join('; ')}`;
    } else {
      try {
        fs.rmSync(transactionStatePath, { force: true });
        fs.rmSync(transactionStateTempPath, { force: true });
      } catch (rollbackError) {
        error.message += `; rollback marker cleanup: ${rollbackError.message}`;
      }
    }
    throw error;
  }

  // Validation and migration have committed the new runtimes. Backup cleanup
  // is best-effort: a cleanup failure must never roll back verified runtimes.
  for (const runtime of managedRuntimes) {
    try {
      fs.rmSync(runtime.backupDir, { recursive: true, force: true });
    } catch (error) {
      console.error(
        `[unpack-cfmind] Warning: unable to remove ${runtime.name} runtime backup: ${error.message}`,
      );
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  activity(`${extractedEntries.toLocaleString('en-US')} resource entries ready in ${elapsed}s`);

  // Verify key directories exist
  const expectedDirs = ['cfmind'];
  for (const dir of expectedDirs) {
    const dirPath = path.join(destDir, dir);
    if (!fs.existsSync(dirPath)) {
      console.error(`[unpack-cfmind] Warning: expected directory missing: ${dir}/`);
    }
  }

  activity('Core resources verified');
  process.exit(0);
} catch (err) {
  console.error(`[unpack-cfmind] Extraction failed: ${err.message}`);
  process.exit(1);
}
