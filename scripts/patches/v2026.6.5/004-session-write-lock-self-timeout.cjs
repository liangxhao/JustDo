'use strict';

// Purpose: Recover a timed-out session write lock when the lock payload belongs
// to the current process and OpenClaw's in-process lock registry can release it.
// Affected OpenClaw version: v2026.6.5.
// Risk: Force-releasing a self-owned lock changes upstream lock failure behavior.
// Remove when: OpenClaw's session lock controller handles self-owned stale locks
// with auto-recovery natively.
// Upstream tracking: TODO(openclaw): file issue/PR with self-owned timeout trace.
// Temporary: yes.

const fs = require('fs');
const path = require('path');

function walkJsFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsFiles(fullPath, out);
    } else if (entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name)) {
      out.push(fullPath);
    }
  }
  return out;
}

function patchFile(filePath) {
  if (!fs.existsSync(filePath)) return false;

  let content = fs.readFileSync(filePath, 'utf8');
  const original = content;

  if (content.includes('recoveredSelfOwnedTimeout')) return false;

  // 1. Insert recoveredSelfOwnedTimeout flag after startedAtMs, before while(true)
  content = content.replace(
    /const startedAtMs = Date\.now\(\);\n(\t)while \(true\) \{/g,
    'const startedAtMs = Date.now();\n$1let recoveredSelfOwnedTimeout = false;\n$1while (true) {',
  );

  // 2. Add self-owned timeout recovery before the first throw (timeout check block).
  //    heldByThisProcess is already computed right before the throw.
  content = content.replace(
    /(const heldByThisProcess = sessionLockHeldByThisProcess\(normalizedSessionFile\);\n)(\t\t\t)(throw new SessionWriteLockTimeoutError\(\{)/g,
    '$1$2if (!recoveredSelfOwnedTimeout && heldByThisProcess) {\n$2	recoveredSelfOwnedTimeout = true;\n$2	let released = 0;\n$2	for (const held of SESSION_LOCKS.heldEntries()) {\n$2		if (held.normalizedTargetPath !== normalizedSessionFile && held.lockPath !== lockPath) continue;\n$2		if (await held.forceRelease().catch(() => false)) released += 1;\n$2	}\n$2	if (released === 0) await fs.rm(lockPath, { force: true }).catch(() => void 0);\n$2	process.stderr.write(`[session-write-lock] recovered self-owned timed-out lock for ${sessionFile} (released=${released})\n`);\n$2	continue;\n$2}\n$2$3',
  );

  // 3. Add self-owned timeout recovery before the second throw (catch block).
  content = content.replace(
    /(\t\t\t\}\n)(\t\t\t)(throw new SessionWriteLockTimeoutError\(\{)/g,
    '$1$2if (!recoveredSelfOwnedTimeout && heldByThisProcess) {\n$2	recoveredSelfOwnedTimeout = true;\n$2	let released = 0;\n$2	for (const held of SESSION_LOCKS.heldEntries()) {\n$2		if (held.normalizedTargetPath !== normalizedSessionFile && held.lockPath !== errorLockPath) continue;\n$2		if (await held.forceRelease().catch(() => false)) released += 1;\n$2	}\n$2	if (released === 0) await fs.rm(errorLockPath, { force: true }).catch(() => void 0);\n$2	process.stderr.write(`[session-write-lock] recovered self-owned timed-out lock for ${sessionFile} (released=${released})\n`);\n$2	continue;\n$2}\n$2$3',
  );

  if (content === original) return false;
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function applyPatch(runtimeDir, options = {}) {
  const candidates = [
    path.join(runtimeDir, 'gateway-bundle.mjs'),
    ...walkJsFiles(path.join(runtimeDir, 'dist')),
  ].filter((filePath, index, arr) => fs.existsSync(filePath) && arr.indexOf(filePath) === index);

  const patched = [];
  for (const filePath of candidates) {
    if (patchFile(filePath)) patched.push(path.relative(runtimeDir, filePath));
  }

  const label = options.label || 'patch-openclaw-session-write-lock-self-timeout';
  if (patched.length > 0) {
    console.log('[' + label + '] Patched self-owned session write lock timeout recovery: ' + patched.join(', '));
  } else if (options.verbose) {
    console.log('[' + label + '] No self-owned session write lock timeout recovery patch needed.');
  }

  return patched;
}

module.exports = { applyPatch };
