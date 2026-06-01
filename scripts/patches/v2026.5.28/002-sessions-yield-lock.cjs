'use strict';

// Purpose: Avoid short abort-settle timeouts causing sessions_yield transcript
// cleanup to contend with active session locks.
// Affected OpenClaw version: v2026.5.28.
// Risk: Longer wait changes abort cleanup latency and can mask upstream lock
// ordering problems.
// Remove when: OpenClaw settles sessions_yield abort cleanup without lock races.
// Upstream tracking: TODO(openclaw): file issue/PR with sessions_yield lock trace.
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
  let content = fs.readFileSync(filePath, 'utf8');
  const original = content;

  content = content.replace(
    /SESSIONS_YIELD_ABORT_SETTLE_TIMEOUT_MS = process\.env\.OPENCLAW_TEST_FAST === "1" \? 250 : 2e3/g,
    'SESSIONS_YIELD_ABORT_SETTLE_TIMEOUT_MS = process.env.OPENCLAW_TEST_FAST === "1" ? 250 : 3e4',
  );

  content = content.replace(
    /if \(outcome === "timed_out"\) log41\.warn\(`sessions_yield abort settle timed out: runId=\$\{params\.runId\} sessionId=\$\{params\.sessionId\} timeoutMs=\$\{SESSIONS_YIELD_ABORT_SETTLE_TIMEOUT_MS\}`\);\n}/g,
    'if (outcome === "timed_out") log41.warn(`sessions_yield abort settle timed out: runId=${params.runId} sessionId=${params.sessionId} timeoutMs=${SESSIONS_YIELD_ABORT_SETTLE_TIMEOUT_MS}`);\n  return outcome;\n}',
  );

  content = content.replace(
    /const outcome = await Promise\.race\(\[params\.settlePromise\.then\(\(\) => "settled"\)\.catch\(\(err3\) => \{\n(\s*)log41\.warn\(`sessions_yield abort settle failed: runId=\$\{params\.runId\} sessionId=\$\{params\.sessionId\} err=\$\{String\(err3\)\}`\);\n(\s*)return "errored";/g,
    'const outcome = await Promise.race([params.settlePromise.then(() => "settled").catch((err3) => {\n$1log41.warn(`sessions_yield abort settle failed: runId=${params.runId} sessionId=${params.sessionId} err=${String(err3)}`);\n$1return "errored";',
  );

  content = content.replace(
    /await waitForSessionsYieldAbortSettle\(\{\n(\s*)settlePromise: yieldAbortSettled,\n(\s*)runId: params\.runId,\n(\s*)sessionId: params\.sessionId\n(\s*)\}\);\n(\s*)await sessionLockController\.waitForSessionEvents\(activeSession\);\n(\s*)await sessionLockController\.withSessionWriteLock\(async \(\) => \{\n(\s*)stripSessionsYieldArtifacts\(activeSession\);\n(\s*)if \(yieldMessage\) await persistSessionsYieldContextMessage\(activeSession, yieldMessage\);\n(\s*)\}\);/g,
    'const yieldAbortSettleOutcome = await waitForSessionsYieldAbortSettle({\n$1settlePromise: yieldAbortSettled,\n$2runId: params.runId,\n$3sessionId: params.sessionId\n$4});\n$5if (yieldAbortSettleOutcome === "timed_out") {\n$5  log41.warn(`sessions_yield transcript cleanup skipped after abort settle timeout: runId=${params.runId} sessionId=${params.sessionId}`);\n$5} else {\n$5  await sessionLockController.waitForSessionEvents(activeSession);\n$5  await sessionLockController.withSessionWriteLock(async () => {\n$7    stripSessionsYieldArtifacts(activeSession);\n$8    if (yieldMessage) await persistSessionsYieldContextMessage(activeSession, yieldMessage);\n$9  });\n$5}',
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
    if (patchFile(filePath)) {
      patched.push(path.relative(runtimeDir, filePath));
    }
  }

  const label = options.label || 'patch-openclaw-sessions-yield-lock';
  if (patched.length > 0) {
    console.log(`[${label}] Patched sessions_yield lock cleanup: ${patched.join(', ')}`);
  } else if (options.verbose) {
    console.log(`[${label}] No sessions_yield lock cleanup patch needed.`);
  }

  return patched;
}

module.exports = { applyPatch };
