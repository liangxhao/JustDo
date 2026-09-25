'use strict';

const fs = require('fs');
const path = require('path');

function renameDirectoryWithRetries(sourceDir, targetDir) {
  const retryableCodes = new Set(['EBUSY', 'ENOTEMPTY', 'EPERM']);
  const deadline = Date.now() + (process.platform === 'win32' ? 15_000 : 0);
  let delayMs = 25;
  for (;;) {
    try {
      fs.renameSync(sourceDir, targetDir);
      return;
    } catch (error) {
      if (!retryableCodes.has(error?.code) || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
      delayMs = Math.min(delayMs * 2, 500);
    }
  }
}

function prepareStagedRuntimeForCommit(stagedDir, targetDir, options = {}) {
  if ((options.platform || process.platform) !== 'win32') return stagedDir;
  const runtimeBase = path.resolve(path.dirname(targetDir));
  const resolvedStaged = path.resolve(stagedDir);
  const resolvedTarget = path.resolve(targetDir);
  if (
    path.dirname(resolvedStaged) !== runtimeBase ||
    path.dirname(resolvedTarget) !== runtimeBase ||
    resolvedStaged === resolvedTarget
  ) {
    throw new Error(
      'Refusing to prepare an OpenClaw runtime outside the runtime target directory.',
    );
  }

  const readyDir = path.join(
    runtimeBase,
    `.${path.basename(targetDir)}.ready-${process.pid}-${Date.now()}`,
  );
  try {
    fs.cpSync(stagedDir, readyDir, {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
    });
    return readyDir;
  } catch (error) {
    fs.rmSync(readyDir, { recursive: true, force: true });
    throw error;
  }
}

function commitStagedRuntime(stagedDir, targetDir, currentDir, options = {}) {
  const runtimeBase = path.resolve(path.dirname(targetDir));
  const resolvedStaged = path.resolve(stagedDir);
  const resolvedTarget = path.resolve(targetDir);
  const resolvedCurrent = path.resolve(currentDir);
  if (
    path.dirname(resolvedStaged) !== runtimeBase ||
    path.dirname(resolvedTarget) !== runtimeBase ||
    path.dirname(resolvedCurrent) !== runtimeBase ||
    resolvedStaged === resolvedTarget
  ) {
    throw new Error('Refusing to commit an OpenClaw runtime outside the runtime target directory.');
  }

  const renameDirectory = options.renameDirectory || renameDirectoryWithRetries;
  const backupDir = path.join(
    runtimeBase,
    `.${path.basename(targetDir)}.backup-${process.pid}-${Date.now()}`,
  );
  let detachedCurrent = false;
  let previousTargetMoved = false;
  let stagedTargetInstalled = false;
  const restoreCurrentLink = () => {
    if (!detachedCurrent || fs.existsSync(currentDir)) return;
    fs.symlinkSync(resolvedTarget, currentDir, process.platform === 'win32' ? 'junction' : 'dir');
    detachedCurrent = false;
  };
  try {
    try {
      const currentStat = fs.lstatSync(currentDir);
      if (currentStat.isSymbolicLink()) {
        const linkedTarget = path.resolve(path.dirname(currentDir), fs.readlinkSync(currentDir));
        if (linkedTarget.toLowerCase() === resolvedTarget.toLowerCase()) {
          fs.unlinkSync(currentDir);
          detachedCurrent = true;
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    if (fs.existsSync(targetDir)) {
      renameDirectory(targetDir, backupDir);
      previousTargetMoved = true;
    }
    renameDirectory(stagedDir, targetDir);
    stagedTargetInstalled = true;
    restoreCurrentLink();
  } catch (error) {
    let rollbackError;
    try {
      if (stagedTargetInstalled && fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
      }
      if (previousTargetMoved && fs.existsSync(backupDir)) {
        renameDirectory(backupDir, targetDir);
      }
      restoreCurrentLink();
    } catch (candidate) {
      rollbackError = candidate;
    }
    if (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'OpenClaw runtime commit failed and rollback was incomplete.',
      );
    }
    throw error;
  }

  if (fs.existsSync(backupDir)) {
    try {
      fs.rmSync(backupDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(
        `[install-openclaw-runtime] Installed the new runtime but could not remove backup ${backupDir}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

module.exports = {
  commitStagedRuntime,
  prepareStagedRuntimeForCommit,
  renameDirectoryWithRetries,
};
