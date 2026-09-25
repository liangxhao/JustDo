'use strict';

const { spawnSync } = require('child_process');
const { findActiveRuntimeDevLeases } = require('./openclaw-runtime-dev-lease.cjs');

const DEV_SHUTDOWN_SWITCH = '--justdo-request-quit-for-update';

function waitSynchronously(delayMs) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

function requestActiveRuntimeDevShutdown(repoRoot, runtimeLeaseDir, options = {}) {
  const findActiveLeases = options.findActiveLeases || findActiveRuntimeDevLeases;
  const active = findActiveLeases(runtimeLeaseDir);
  if (active.length === 0) return false;

  const electronPath = options.electronPath || require('electron');
  const runElectron = options.spawnSync || spawnSync;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  console.log(
    `[openclaw-runtime] Requesting graceful shutdown of the active Electron development ` +
      `session (PID ${active.map(lease => lease.pid).join(', ')}).`,
  );
  const result = runElectron(electronPath, [repoRoot, DEV_SHUTDOWN_SWITCH], {
    cwd: repoRoot,
    env,
    stdio: 'ignore',
    timeout: options.signalTimeoutMs || 15_000,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(
      `[openclaw-runtime] Failed to request shutdown from the active Electron development ` +
        `session: ${result.error.message}`,
    );
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    throw new Error(
      `[openclaw-runtime] Electron shutdown request exited with code ${result.status}.`,
    );
  }

  const timeoutMs = options.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  let remaining = findActiveLeases(runtimeLeaseDir);
  while (remaining.length > 0 && Date.now() < deadline) {
    (options.wait || waitSynchronously)(100);
    remaining = findActiveLeases(runtimeLeaseDir);
  }
  if (remaining.length > 0) {
    throw new Error(
      `[openclaw-runtime] Timed out waiting for Electron development session ` +
        `(PID ${remaining.map(lease => lease.pid).join(', ')}) to release the runtime.`,
    );
  }
  console.log('[openclaw-runtime] Active Electron development session stopped.');
  return true;
}

module.exports = {
  DEV_SHUTDOWN_SWITCH,
  requestActiveRuntimeDevShutdown,
};
