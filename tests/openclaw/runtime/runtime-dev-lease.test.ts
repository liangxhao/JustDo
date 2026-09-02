import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

const {
  acquireRuntimeDevLease,
  assertNoActiveRuntimeDevLease,
  findActiveRuntimeDevLeases,
  LEASE_STALE_AFTER_MS,
  resolveRuntimeDevLeaseDir,
} = require('../../../scripts/openclaw-runtime-dev-lease.cjs') as {
  acquireRuntimeDevLease: (
    runtimeBaseDir: string,
    options?: { heartbeatMs?: number; isProcessAlive?: (pid: number) => boolean; pid?: number },
  ) => () => void;
  assertNoActiveRuntimeDevLease: (
    runtimeBaseDir: string,
    options?: { isProcessAlive?: (pid: number) => boolean },
  ) => void;
  findActiveRuntimeDevLeases: (
    runtimeBaseDir: string,
    options?: { isProcessAlive?: (pid: number) => boolean; nowMs?: number },
  ) => Array<{ filePath: string; pid: number }>;
  LEASE_STALE_AFTER_MS: number;
  resolveRuntimeDevLeaseDir: (repoRoot: string) => string;
};

const temporaryRoots: string[] = [];

function createRuntimeBase() {
  const runtimeBase = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-runtime-lease-'));
  temporaryRoots.push(runtimeBase);
  return runtimeBase;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('OpenClaw development runtime lease', () => {
  test('uses a stable repo-scoped directory outside the repository', () => {
    const repoRoot = createRuntimeBase();
    const leaseDir = resolveRuntimeDevLeaseDir(repoRoot);
    const normalizedRepoRoot = path.resolve(repoRoot).toLowerCase();
    const normalizedLeaseDir = path.resolve(leaseDir).toLowerCase();

    expect(leaseDir).toBe(resolveRuntimeDevLeaseDir(repoRoot));
    expect(normalizedLeaseDir.startsWith(`${normalizedRepoRoot}${path.sep}`)).toBe(false);
  });

  test('blocks runtime preparation while a development session is active', () => {
    const runtimeBase = createRuntimeBase();
    const release = acquireRuntimeDevLease(runtimeBase, {
      heartbeatMs: 0,
      isProcessAlive: () => true,
      pid: 4242,
    });

    expect(() =>
      assertNoActiveRuntimeDevLease(runtimeBase, { isProcessAlive: () => true }),
    ).toThrow(/active Electron development session \(PID 4242\)/);

    release();
    expect(() =>
      assertNoActiveRuntimeDevLease(runtimeBase, { isProcessAlive: () => true }),
    ).not.toThrow();
  });

  test('removes abandoned leases for dead processes', () => {
    const runtimeBase = createRuntimeBase();
    const leasePath = path.join(runtimeBase, '.justdo-dev-runtime-lease-5151.json');
    fs.writeFileSync(leasePath, '{}\n');

    expect(
      findActiveRuntimeDevLeases(runtimeBase, { isProcessAlive: () => false }),
    ).toEqual([]);
    expect(fs.existsSync(leasePath)).toBe(false);
  });

  test('expires stale leases even when a PID has been reused', () => {
    const runtimeBase = createRuntimeBase();
    const leasePath = path.join(runtimeBase, '.justdo-dev-runtime-lease-6161.json');
    fs.writeFileSync(leasePath, '{}\n');
    const oldTime = new Date(Date.now() - LEASE_STALE_AFTER_MS - 1);
    fs.utimesSync(leasePath, oldTime, oldTime);

    expect(
      findActiveRuntimeDevLeases(runtimeBase, {
        isProcessAlive: () => true,
        nowMs: Date.now(),
      }),
    ).toEqual([]);
    expect(fs.existsSync(leasePath)).toBe(false);
  });
});
