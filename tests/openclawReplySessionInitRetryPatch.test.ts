import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

const { applyPatch } =
  require('../scripts/patches/v2026.6.11/009-reply-session-init-conflict-retry.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
  };

const FIXTURE = `let commitAttempts = 0;
let objectCacheDrops = 0;
function dropSessionStoreObjectCache() {
  objectCacheDrops += 1;
}
function createReplySessionInitializationRevision(entry) {
  return JSON.stringify(entry ?? null);
}
async function updateSessionStore(storePath, mutator) {
  return await mutator({});
}
async function commitReplySessionInitialization(params) {
  const committed = await updateSessionStore(params.storePath, async (store2) => {
    commitAttempts += 1;
    return { ok: commitAttempts >= 4 };
  });
  return committed;
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
    const initiallyPatched = fs.readFileSync(bundlePath, 'utf8');
    fs.writeFileSync(
      bundlePath,
      initiallyPatched.replace(
        'dropSessionStoreObjectCache(params.storePath);',
        'invalidateSessionStoreCache(params.storePath);',
      ),
      'utf8',
    );
    expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    const patched = fs.readFileSync(bundlePath, 'utf8');

    expect(patched).toContain('REPLY_SESSION_INITIALIZATION_MAX_RETRIES = 8');
    expect(patched).toContain('staleSnapshotRetryCount + 1');
    expect(patched).toContain('Math.min(5 * (staleSnapshotRetryCount + 1), 25)');
    expect(patched).toContain('canonicalizeReplySessionInitializationRevisionValue');
    expect(patched).toContain('dropSessionStoreObjectCache(params.storePath)');
    expect(patched).not.toContain('invalidateSessionStoreCache(params.storePath)');
    expect(patched).not.toContain('staleSnapshotRetried');

    const harness = new Function(
      `${patched}\nreturn { createReplySessionInitializationRevision, initSessionState, getCommitAttempts: () => commitAttempts, getObjectCacheDrops: () => objectCacheDrops };`,
    )() as {
      createReplySessionInitializationRevision: (entry: unknown) => string;
      initSessionState: (params: { sessionKey: string }) => Promise<{ ok: boolean }>;
      getCommitAttempts: () => number;
      getObjectCacheDrops: () => number;
    };
    expect(
      harness.createReplySessionInitializationRevision({
        status: 'running',
        nested: { updatedAt: 2, sessionId: 'session-1' },
      }),
    ).toBe(
      harness.createReplySessionInitializationRevision({
        nested: { sessionId: 'session-1', updatedAt: 2 },
        status: 'running',
      }),
    );
    await expect(harness.initSessionState({ sessionKey: 'test-session' })).resolves.toEqual({
      ok: true,
    });
    expect(harness.getCommitAttempts()).toBe(4);
    expect(harness.getObjectCacheDrops()).toBe(4);
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
