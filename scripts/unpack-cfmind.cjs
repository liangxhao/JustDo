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

// ============================================================
// 参数解析
// ============================================================

const tarPath = process.argv[2];
const destDir = process.argv[3];
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
  // backup until the replacement has been extracted and validated so a failed
  // installation can restore the last working Git runtime. Replace cfmind the
  // same way so removed OpenClaw files and default skills cannot survive an
  // upgrade that is meant to provide a fully replaced runtime.
  const cfmindDir = path.join(destDir, 'cfmind');
  const cfmindBackupDir = path.join(destDir, '.cfmind-upgrade-backup');
  const minGitDir = path.join(destDir, 'mingit');
  const minGitBackupDir = path.join(destDir, '.mingit-upgrade-backup');
  if (fs.existsSync(cfmindBackupDir)) {
    activity('Recovering the previous OpenClaw runtime backup...');
    fs.rmSync(cfmindDir, { recursive: true, force: true });
    fs.renameSync(cfmindBackupDir, cfmindDir);
  }
  if (fs.existsSync(minGitBackupDir)) {
    activity('Recovering the previous Git runtime backup...');
    fs.rmSync(minGitDir, { recursive: true, force: true });
    fs.renameSync(minGitBackupDir, minGitDir);
  }
  if (fs.existsSync(cfmindDir)) {
    activity('Backing up the previous OpenClaw runtime...');
    fs.renameSync(cfmindDir, cfmindBackupDir);
  }
  if (fs.existsSync(minGitDir)) {
    activity('Backing up the previous Git runtime...');
    fs.renameSync(minGitDir, minGitBackupDir);
  }

  try {
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

    const runtimePackagePath = path.join(cfmindDir, 'package.json');
    if (!fs.existsSync(runtimePackagePath) || fs.statSync(runtimePackagePath).size === 0) {
      throw new Error(
        `OpenClaw extraction is missing a non-empty package.json: ${runtimePackagePath}`,
      );
    }

    fs.rmSync(cfmindBackupDir, { recursive: true, force: true });
    fs.rmSync(minGitBackupDir, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(cfmindDir, { recursive: true, force: true });
    fs.rmSync(minGitDir, { recursive: true, force: true });
    if (fs.existsSync(cfmindBackupDir)) {
      fs.renameSync(cfmindBackupDir, cfmindDir);
      activity('Restored the previous OpenClaw runtime after extraction failed.');
    }
    if (fs.existsSync(minGitBackupDir)) {
      fs.renameSync(minGitBackupDir, minGitDir);
      activity('Restored the previous Git runtime after extraction failed.');
    }
    throw error;
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
