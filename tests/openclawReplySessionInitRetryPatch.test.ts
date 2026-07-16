import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

const { applyPatch } =
  require('../scripts/patches/v2026.6.11/009-reply-session-init-conflict-retry.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
  };

const FIXTURE = `let commitAttempts = 0;
async function commitReplySessionInitialization() {
  commitAttempts += 1;
  return { ok: commitAttempts >= 4 };
}
async function initSessionState(params) {
  return await initSessionStateAttempt(params, false);
}
async function initSessionStateAttempt(params, staleSnapshotRetried) {
  const sessionKey = params.sessionKey;
  const committed = await commitReplySessionInitialization(params);
  if (!committed.ok) {
    if (!staleSnapshotRetried) return await initSessionStateAttempt(params, true);
    throw new Error(\`reply session initialization conflicted for \${sessionKey}\`);
  }
  return committed;
}`;

test('recovers from repeated transient reply session initialization conflicts', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-session-init-patch-'));
  try {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    fs.writeFileSync(bundlePath, FIXTURE, 'utf8');

    expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    const patched = fs.readFileSync(bundlePath, 'utf8');

    expect(patched).toContain('REPLY_SESSION_INITIALIZATION_MAX_RETRIES = 8');
    expect(patched).toContain('staleSnapshotRetryCount + 1');
    expect(patched).toContain('Math.min(5 * (staleSnapshotRetryCount + 1), 25)');
    expect(patched).not.toContain('staleSnapshotRetried');

    const harness = new Function(
      `${patched}\nreturn { initSessionState, getCommitAttempts: () => commitAttempts };`,
    )() as {
      initSessionState: (params: { sessionKey: string }) => Promise<{ ok: boolean }>;
      getCommitAttempts: () => number;
    };
    await expect(harness.initSessionState({ sessionKey: 'test-session' })).resolves.toEqual({
      ok: true,
    });
    expect(harness.getCommitAttempts()).toBe(4);
    expect(applyPatch(runtimeDir)).toEqual([]);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('fails visibly when the expected OpenClaw implementation changes', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-session-init-patch-'));
  try {
    fs.writeFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'export {};', 'utf8');

    expect(() => applyPatch(runtimeDir)).toThrow('patch target not found');
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('defers safely until the gateway bundle has been generated', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-session-init-patch-'));
  try {
    expect(applyPatch(runtimeDir)).toEqual([]);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
