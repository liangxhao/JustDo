'use strict';

// Purpose: Keep stale writer caches, semantically identical session-entry
// snapshots with different object key order, and transient session-entry writes
// from aborting reply session initialization.
// Affected OpenClaw version: v2026.6.11.
// Risk: Revision creation sorts JSON object keys recursively. A reply whose
// session entry is genuinely mutated can start up to 150ms later before
// preserving the upstream conflict error.
// Remove when: OpenClaw uses key-order-independent revisions and retries reply
// session initialization conflicts, or serializes persistence with initialization.
// Upstream tracking: TODO(openclaw): file issue/PR with the JustDo concurrent
// chat transcript persistence reproduction from 2026-07-16.
// Temporary: yes.

const fs = require('fs');
const path = require('path');

const ORIGINAL_ENTRY = `async function initSessionState(params) {
  return await initSessionStateAttempt(params, false);
}
async function initSessionStateAttempt(params, staleSnapshotRetried) {`;

const PATCHED_ENTRY = `const REPLY_SESSION_INITIALIZATION_MAX_RETRIES = 8;
async function initSessionState(params) {
  return await initSessionStateAttempt(params, 0);
}
async function initSessionStateAttempt(params, staleSnapshotRetryCount) {`;

const ORIGINAL_CONFLICT_HANDLER = `  if (!committed.ok) {
    if (!staleSnapshotRetried) return await initSessionStateAttempt(params, true);
    throw new Error(\`reply session initialization conflicted for \${sessionKey}\`);
  }`;

const PATCHED_CONFLICT_HANDLER = `  if (!committed.ok) {
    if (staleSnapshotRetryCount < REPLY_SESSION_INITIALIZATION_MAX_RETRIES) {
      const retryDelayMs = Math.min(5 * (staleSnapshotRetryCount + 1), 25);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      return await initSessionStateAttempt(params, staleSnapshotRetryCount + 1);
    }
    throw new Error(\`reply session initialization conflicted for \${sessionKey}\`);
  }`;

const ORIGINAL_REVISION = `function createReplySessionInitializationRevision(entry) {
  return JSON.stringify(entry ?? null);
}`;

const PATCHED_REVISION = `function canonicalizeReplySessionInitializationRevisionValue(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalizeReplySessionInitializationRevisionValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalizeReplySessionInitializationRevisionValue(value[key])])
    );
  }
  return value;
}
function createReplySessionInitializationRevision(entry) {
  return JSON.stringify(canonicalizeReplySessionInitializationRevisionValue(entry ?? null));
}`;

const ORIGINAL_COMMIT_ENTRY = `async function commitReplySessionInitialization(params) {
  const committed = await updateSessionStore(params.storePath, async (store2) => {`;

const PATCHED_COMMIT_ENTRY = `async function commitReplySessionInitialization(params) {
  dropSessionStoreObjectCache(params.storePath);
  const committed = await updateSessionStore(params.storePath, async (store2) => {`;

const LEGACY_PATCHED_COMMIT_ENTRY = `async function commitReplySessionInitialization(params) {
  invalidateSessionStoreCache(params.storePath);
  const committed = await updateSessionStore(params.storePath, async (store2) => {`;

function patchFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const retryAlreadyPatched =
    content.includes(PATCHED_ENTRY) && content.includes(PATCHED_CONFLICT_HANDLER);
  const revisionAlreadyPatched = content.includes(PATCHED_REVISION);
  const commitAlreadyPatched = content.includes(PATCHED_COMMIT_ENTRY);
  const alreadyPatched = retryAlreadyPatched && revisionAlreadyPatched && commitAlreadyPatched;
  if (alreadyPatched) return false;

  let patched = content;
  if (!retryAlreadyPatched) {
    if (!patched.includes(ORIGINAL_ENTRY) || !patched.includes(ORIGINAL_CONFLICT_HANDLER)) {
      throw new Error(
        `OpenClaw reply session initialization retry patch target not found: ${filePath}`,
      );
    }
    patched = patched
      .replace(ORIGINAL_ENTRY, PATCHED_ENTRY)
      .replace(ORIGINAL_CONFLICT_HANDLER, PATCHED_CONFLICT_HANDLER);
  }

  if (!revisionAlreadyPatched) {
    if (!patched.includes(ORIGINAL_REVISION)) {
      throw new Error(
        `OpenClaw reply session initialization revision patch target not found: ${filePath}`,
      );
    }
    patched = patched.replace(ORIGINAL_REVISION, PATCHED_REVISION);
  }

  if (!commitAlreadyPatched) {
    if (patched.includes(LEGACY_PATCHED_COMMIT_ENTRY)) {
      patched = patched.replace(LEGACY_PATCHED_COMMIT_ENTRY, PATCHED_COMMIT_ENTRY);
    } else if (patched.includes(ORIGINAL_COMMIT_ENTRY)) {
      patched = patched.replace(ORIGINAL_COMMIT_ENTRY, PATCHED_COMMIT_ENTRY);
    } else {
      throw new Error(
        `OpenClaw reply session initialization commit patch target not found: ${filePath}`,
      );
    }
  }

  fs.writeFileSync(filePath, patched, 'utf8');
  return true;
}

function applyPatch(runtimeDir, options = {}) {
  const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
  const label = options.label || 'patch-openclaw-reply-session-init-conflict-retry';
  if (!fs.existsSync(bundlePath)) {
    if (options.verbose) {
      console.log(`[${label}] Gateway bundle not generated yet; deferring reply session patch.`);
    }
    return [];
  }

  const patched = patchFile(bundlePath) ? ['gateway-bundle.mjs'] : [];
  if (patched.length > 0) {
    console.log(`[${label}] Patched reply session initialization conflict retry.`);
  } else if (options.verbose) {
    console.log(`[${label}] Reply session initialization conflict retry already patched.`);
  }
  return patched;
}

function verifyPatch(runtimeDir) {
  const content = fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8');
  const required = [PATCHED_ENTRY, PATCHED_CONFLICT_HANDLER, PATCHED_REVISION, PATCHED_COMMIT_ENTRY];
  const missing = required.filter(marker => !content.includes(marker));
  if (missing.length > 0) throw new Error(`Reply session initialization retry patch is incomplete: ${missing.length} replacement(s) missing`);
  return true;
}

module.exports = { applyPatch, verifyPatch };
