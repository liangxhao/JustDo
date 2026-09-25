'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LEASE_PREFIX = '.justdo-dev-runtime-lease-';
const LEASE_SUFFIX = '.json';
const LEASE_HEARTBEAT_MS = 15_000;
const LEASE_STALE_AFTER_MS = 60_000;

function leaseFileName(pid) {
  return `${LEASE_PREFIX}${pid}${LEASE_SUFFIX}`;
}

function resolveRuntimeDevLeaseDir(repoRoot) {
  const resolvedRoot = path.resolve(repoRoot);
  const identity = process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot;
  const digest = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24);
  return path.join(os.tmpdir(), 'justdo-openclaw-runtime-leases', digest);
}

function pidFromLeaseFileName(fileName) {
  if (!fileName.startsWith(LEASE_PREFIX) || !fileName.endsWith(LEASE_SUFFIX)) return null;
  const pid = Number(fileName.slice(LEASE_PREFIX.length, -LEASE_SUFFIX.length));
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function removeLeaseFile(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // A racing process can remove its own lease between discovery and cleanup.
  }
}

function findActiveRuntimeDevLeases(runtimeBaseDir, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const processIsAlive = options.isProcessAlive ?? isProcessAlive;
  let entries;
  try {
    entries = fs.readdirSync(runtimeBaseDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const active = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const pid = pidFromLeaseFileName(entry.name);
    if (!pid) continue;
    const filePath = path.join(runtimeBaseDir, entry.name);
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (nowMs - stat.mtimeMs > LEASE_STALE_AFTER_MS || !processIsAlive(pid)) {
      removeLeaseFile(filePath);
      continue;
    }
    active.push({ pid, filePath });
  }
  return active;
}

function assertNoActiveRuntimeDevLease(runtimeBaseDir, options = {}) {
  const active = findActiveRuntimeDevLeases(runtimeBaseDir, options);
  if (active.length === 0) return;
  const pids = active.map(lease => lease.pid).join(', ');
  throw new Error(
    `[openclaw-runtime] Runtime preparation is blocked by an active Electron development ` +
      `session (PID ${pids}). Close the existing Electron/Gateway session (or stop its ` +
      `terminal with Ctrl+C), then retry.`,
  );
}

function acquireRuntimeDevLease(runtimeBaseDir, options = {}) {
  const pid = options.pid ?? process.pid;
  const heartbeatMs = options.heartbeatMs ?? LEASE_HEARTBEAT_MS;
  fs.mkdirSync(runtimeBaseDir, { recursive: true });
  const filePath = path.join(runtimeBaseDir, leaseFileName(pid));
  removeLeaseFile(filePath);
  assertNoActiveRuntimeDevLease(runtimeBaseDir, options);
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({ pid, startedAt: new Date().toISOString() })}\n`,
    'utf8',
  );

  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          try {
            const now = new Date();
            fs.utimesSync(filePath, now, now);
          } catch {
            // Best effort: the next heartbeat can restore freshness. A lease
            // that remains unwritable expires instead of blocking forever.
          }
        }, heartbeatMs)
      : null;
  heartbeat?.unref();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (heartbeat) clearInterval(heartbeat);
    removeLeaseFile(filePath);
  };
}

module.exports = {
  acquireRuntimeDevLease,
  assertNoActiveRuntimeDevLease,
  findActiveRuntimeDevLeases,
  LEASE_STALE_AFTER_MS,
  resolveRuntimeDevLeaseDir,
};
