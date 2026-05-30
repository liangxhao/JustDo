'use strict';

// Purpose: Recover a timed-out session write lock when the lock payload belongs
// to the current process and OpenClaw's in-process lock registry can release it.
// Affected OpenClaw version: v2026.5.22.
// Risk: Force-releasing a self-owned lock changes upstream lock failure behavior.
// Remove when: OpenClaw's session lock controller handles self-owned stale locks.
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

  content = content.replace(
    /const sessionFile = path98\.resolve\(params\.sessionFile\);\n  const sessionDir = path98\.dirname\(sessionFile\);\n  const lockPath = `\$\{await resolveNormalizedSessionFile\(sessionFile\)\}\.lock`;\n  await fs88\.mkdir\(sessionDir, \{ recursive: true \}\);\n  while \(true\) try \{/g,
    'const sessionFile = path98.resolve(params.sessionFile);\n  const sessionDir = path98.dirname(sessionFile);\n  const normalizedSessionFile = await resolveNormalizedSessionFile(sessionFile);\n  const lockPath = `${normalizedSessionFile}.lock`;\n  await fs88.mkdir(sessionDir, { recursive: true });\n  let recoveredSelfOwnedTimeout = false;\n  while (true) try {',
  );

  content = content.replace(
    /const sessionFile = path\.resolve\(params\.sessionFile\);\n\tconst sessionDir = path\.dirname\(sessionFile\);\n\tconst lockPath = `\$\{await resolveNormalizedSessionFile\(sessionFile\)\}\.lock`;\n\tawait fs\.mkdir\(sessionDir, \{ recursive: true \}\);\n\twhile \(true\) try \{/g,
    'const sessionFile = path.resolve(params.sessionFile);\n\tconst sessionDir = path.dirname(sessionFile);\n\tconst normalizedSessionFile = await resolveNormalizedSessionFile(sessionFile);\n\tconst lockPath = `${normalizedSessionFile}.lock`;\n\tawait fs.mkdir(sessionDir, { recursive: true });\n\tlet recoveredSelfOwnedTimeout = false;\n\twhile (true) try {',
  );

  content = content.replace(
    /const timeoutLockPath = err3\.lockPath \?\? lockPath;\n    const payload = await readLockPayload\(timeoutLockPath\);\n    throw new SessionWriteLockTimeoutError\(\{/g,
    'const timeoutLockPath = err3.lockPath ?? lockPath;\n    const payload = await readLockPayload(timeoutLockPath);\n    if (!recoveredSelfOwnedTimeout && payload?.pid === process.pid) {\n      recoveredSelfOwnedTimeout = true;\n      let released = 0;\n      for (const held of SESSION_LOCKS.heldEntries()) {\n        if (held.normalizedTargetPath !== normalizedSessionFile && held.lockPath !== timeoutLockPath) continue;\n        if (await held.forceRelease().catch(() => false)) released += 1;\n      }\n      if (released === 0) await fs88.rm(timeoutLockPath, { force: true }).catch(() => void 0);\n      process.stderr.write(`[session-write-lock] recovered self-owned timed-out lock for ${sessionFile} (released=${released})\\n`);\n      continue;\n    }\n    throw new SessionWriteLockTimeoutError({',
  );

  content = content.replace(
    /const timeoutLockPath = err\.lockPath \?\? lockPath;\n\t\tconst payload = await readLockPayload\(timeoutLockPath\);\n\t\tthrow new SessionWriteLockTimeoutError\(\{/g,
    'const timeoutLockPath = err.lockPath ?? lockPath;\n\t\tconst payload = await readLockPayload(timeoutLockPath);\n\t\tif (!recoveredSelfOwnedTimeout && payload?.pid === process.pid) {\n\t\t\trecoveredSelfOwnedTimeout = true;\n\t\t\tlet released = 0;\n\t\t\tfor (const held of SESSION_LOCKS.heldEntries()) {\n\t\t\t\tif (held.normalizedTargetPath !== normalizedSessionFile && held.lockPath !== timeoutLockPath) continue;\n\t\t\t\tif (await held.forceRelease().catch(() => false)) released += 1;\n\t\t\t}\n\t\t\tif (released === 0) await fs.rm(timeoutLockPath, { force: true }).catch(() => void 0);\n\t\t\tprocess.stderr.write(`[session-write-lock] recovered self-owned timed-out lock for ${sessionFile} (released=${released})\\n`);\n\t\t\tcontinue;\n\t\t}\n\t\tthrow new SessionWriteLockTimeoutError({',
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
    console.log(`[${label}] Patched self-owned session write lock timeout recovery: ${patched.join(', ')}`);
  } else if (options.verbose) {
    console.log(`[${label}] No self-owned session write lock timeout recovery patch needed.`);
  }

  return patched;
}

module.exports = { applyPatch };
