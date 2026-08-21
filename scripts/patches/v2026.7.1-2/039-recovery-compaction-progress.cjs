'use strict';

// Capability: publish visible lifecycle and streamed summary progress for recovery compaction.
// Target: patched openclaw@2026.7.1-2 after request-purpose metadata and overflow recovery.
// Scope: direct timeout/overflow context-engine compaction that bypasses AgentSession events.
// Safety: model output remains private to the active session and compaction transport is unchanged.
// Remove when: upstream emits start/update/end/error for every context-engine compaction path.

const fs = require('fs');
const path = require('path');
const { findFilesContaining, replaceUniquePattern, writeIfChanged } = require('./_patch-utils.js');

const MARKER = 'JUSTDO_RECOVERY_COMPACTION_PROGRESS_V2026_7_1_2';
const APPLIED_CONTRACTS = [
  'const beginJustDoRecoveryCompactionProgress = async',
  'finishJustDoTimeoutCompactionProgress(timeoutCompactResult)',
  'finishJustDoOverflowCompactionProgress(compactResult)',
  'elapsedMs: Date.now() - startedAt',
];

function findPatchTargets(runtimeDir) {
  const files = new Set(
    findFilesContaining(runtimeDir, [
      'const onCompactionHookMessages = async',
      'timeoutCompactResult = await compactContextEngineWithSafetyTimeout',
      'compactResult = await compactContextEngineWithSafetyTimeout',
    ]),
  );
  for (const filePath of findFilesContaining(runtimeDir, [MARKER])) files.add(filePath);
  for (const filePath of findFilesContaining(runtimeDir, APPLIED_CONTRACTS)) files.add(filePath);
  return [...files];
}

const PROGRESS_HELPER = `const justDoCompactionStreamListenerSymbol = Symbol.for("justdo.compaction-stream-listeners");
        const beginJustDoRecoveryCompactionProgress = async (reason, attemptNumber) => {
          const compactionSessionId = activeSessionId;
          const listeners = globalThis[justDoCompactionStreamListenerSymbol] instanceof Map
            ? globalThis[justDoCompactionStreamListenerSymbol]
            : new Map();
          globalThis[justDoCompactionStreamListenerSymbol] = listeners;
          let summary = "";
          let pendingDelta = "";
          let updateTimer;
          const startedAt = Date.now();
          let heartbeatTimer;
          const emitProgress = async (data) => {
            try {
              await params.onAgentEvent?.({
                stream: "compaction",
                data: { ...data, reason, attempt: attemptNumber },
                ...(params.sessionKey ? { sessionKey: params.sessionKey } : {})
              });
            } catch {}
          };
          let progressChain = Promise.resolve();
          const queueProgress = (data) => {
            progressChain = progressChain.then(() => emitProgress(data));
            return progressChain;
          };
          const emitSummaryUpdate = () => {
            updateTimer = void 0;
            const delta = pendingDelta;
            pendingDelta = "";
            if (delta) void queueProgress({ phase: "update", delta });
          };
          const listener = (delta) => {
            summary += delta;
            pendingDelta += delta;
            if (updateTimer === void 0) updateTimer = setTimeout(emitSummaryUpdate, 80);
          };
          justDoRecoveryCompactionProgressActive = true;
          listeners.set(compactionSessionId, listener);
          await queueProgress({ phase: "start" });
          heartbeatTimer = setInterval(() => {
            void queueProgress({ phase: "update", elapsedMs: Date.now() - startedAt });
          }, 5000);
          return async (result) => {
            if (updateTimer !== void 0) clearTimeout(updateTimer);
            if (heartbeatTimer !== void 0) clearInterval(heartbeatTimer);
            if (listeners.get(compactionSessionId) === listener) listeners.delete(compactionSessionId);
            justDoRecoveryCompactionProgressActive = false;
            const finalDelta = pendingDelta;
            pendingDelta = "";
            if (finalDelta) await queueProgress({ phase: "update", delta: finalDelta });
            const completed = result?.ok === true && result?.compacted === true;
            await queueProgress({
              phase: completed ? "end" : "failed",
              completed,
              ...(summary ? { text: summary } : {}),
              ...(typeof result?.result?.tokensBefore === "number" ? { tokensBefore: result.result.tokensBefore } : {}),
              ...(typeof result?.result?.tokensAfter === "number" ? { tokensAfter: result.result.tokensAfter } : {}),
              ...(!completed && result?.reason ? { error: String(result.reason) } : {})
            });
          };
        }; // ${MARKER}`;

function transform(content, filePath) {
  const appliedContracts = APPLIED_CONTRACTS.filter(contract => content.includes(contract));
  if (content.includes(MARKER) || appliedContracts.length > 0) {
    if (appliedContracts.length !== APPLIED_CONTRACTS.length) {
      throw new Error(`${filePath}: partial recovery compaction progress patch`);
    }
    return content;
  }
  let out = replaceUniquePattern(
    content,
    /(const onCompactionHookMessages = async \(payload\) => \{)/,
    `let justDoRecoveryCompactionProgressActive = false;
        $1
          if (justDoRecoveryCompactionProgressActive) return;`,
    `${filePath}: fence duplicate recovery compaction hooks`,
  );
  out = replaceUniquePattern(
    out,
    /(const onCompactionHookMessages = async \(payload\) => \{[\s\S]*?\n\s*\};)(\n\s*const runOwnsCompactionBeforeHook = async)/,
    `$1\n        ${PROGRESS_HELPER}$2`,
    `${filePath}: recovery compaction progress helper`,
  );
  out = replaceUniquePattern(
    out,
    /(let timeoutCompactResult;)(\s*\n\s*await runOwnsCompactionBeforeHook\("timeout recovery"\);)/,
    `$1\n              const finishJustDoTimeoutCompactionProgress = await beginJustDoRecoveryCompactionProgress(\n                "timeout_recovery",\n                timeoutCompactionAttempts,\n              );$2`,
    `${filePath}: timeout compaction start`,
  );
  out = replaceUniquePattern(
    out,
    /(await runOwnsCompactionAfterHook\("timeout recovery", timeoutCompactResult(?:, previousSessionId)?\);)/,
    `$1
              await finishJustDoTimeoutCompactionProgress(timeoutCompactResult);`,
    `${filePath}: timeout compaction finish`,
  );
  out = replaceUniquePattern(
    out,
    /(let compactResult;\s*\n(?:\s*let previousSessionId;)?)(\s*\n\s*await runOwnsCompactionBeforeHook\("overflow recovery"\);)/,
    `$1\n              const finishJustDoOverflowCompactionProgress = await beginJustDoRecoveryCompactionProgress(\n                "overflow",\n                overflowCompactionAttempts,\n              );$2`,
    `${filePath}: overflow compaction start`,
  );
  out = replaceUniquePattern(
    out,
    /(await runOwnsCompactionAfterHook\("overflow recovery", compactResult(?:, previousSessionId)?\);)/,
    `$1
              await finishJustDoOverflowCompactionProgress(compactResult);`,
    `${filePath}: overflow compaction finish`,
  );
  return out;
}

function applyPatch(runtimeDir) {
  const matches = findPatchTargets(runtimeDir);
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  const gatewayMatches = matches.filter(
    filePath => path.basename(filePath) === 'gateway-bundle.mjs',
  );
  if (matches.length !== expected || (expected === 2 && gatewayMatches.length !== 1)) {
    throw new Error(
      `Recovery compaction progress target count is ${matches.length}, expected ${expected}`,
    );
  }
  const staged = matches.map(filePath => {
    const original = fs.readFileSync(filePath, 'utf8');
    return { filePath, original, updated: transform(original, filePath) };
  });
  return staged
    .filter(item => writeIfChanged(item.filePath, item.original, item.updated))
    .map(item => path.relative(runtimeDir, item.filePath));
}

function verifyPatch(runtimeDir) {
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  const matches = findFilesContaining(runtimeDir, [
    'finishJustDoTimeoutCompactionProgress',
    'finishJustDoOverflowCompactionProgress',
    'phase: "update"',
    'elapsedMs: Date.now() - startedAt',
  ]);
  if (matches.length !== expected) {
    throw new Error(`Recovery compaction progress contract is incomplete`);
  }
}

module.exports = { applyPatch, verifyPatch, transform, progressHelper: PROGRESS_HELPER };
