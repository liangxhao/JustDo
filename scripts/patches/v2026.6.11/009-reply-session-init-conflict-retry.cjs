'use strict';

// Purpose: Keep transient session-entry writes from aborting reply session
// initialization after only one optimistic-concurrency retry.
// Affected OpenClaw version: v2026.6.11.
// Risk: A reply whose session entry is continuously mutated can start up to
// 150ms later before preserving the upstream conflict error.
// Remove when: OpenClaw retries reply session initialization conflicts with a
// bounded backoff or serializes transcript persistence with initialization.
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

function patchFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const alreadyPatched =
    content.includes(PATCHED_ENTRY) && content.includes(PATCHED_CONFLICT_HANDLER);
  if (alreadyPatched) return false;

  if (!content.includes(ORIGINAL_ENTRY) || !content.includes(ORIGINAL_CONFLICT_HANDLER)) {
    throw new Error(`OpenClaw reply session initialization patch target not found: ${filePath}`);
  }

  const patched = content
    .replace(ORIGINAL_ENTRY, PATCHED_ENTRY)
    .replace(ORIGINAL_CONFLICT_HANDLER, PATCHED_CONFLICT_HANDLER);
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

module.exports = { applyPatch };
