'use strict';

// Capability: preserve the actual terminal failure after overflow-triggered compaction.
// Target: patched openclaw@2026.7.1-2 after bounded overflow recovery.
// Scope: embedded-agent overflow recovery final payload and lifecycle metadata.
// Safety: provider-confirmed overflow keeps the upstream recovery message; local precheck,
// timeout, auth, network and compaction no-op failures retain their own reason.
// Remove when: upstream distinguishes local precheck pressure from provider overflow and
// carries the last recovery failure into the terminal payload/lifecycle error.

const fs = require('fs');
const path = require('path');
const { findFilesContaining, replaceUniquePattern, writeIfChanged } = require('./_patch-utils.js');

const MARKER = 'JUSTDO_COMPACTION_ERROR_ATTRIBUTION_V2026_7_1_2_V3';
const APPLIED_CONTRACTS = [
  'let justDoLastOverflowRecoveryFailure;',
  'const clearJustDoLastOverflowRecoveryFailure = () =>',
  'const justDoProviderConfirmedOverflow =',
  'providerConfirmedOverflow: justDoProviderConfirmedOverflow',
  'resolveJustDoOverflowTerminalFailure({',
  'message: justDoTerminalErrorText',
];

const FAILURE_HELPER = `const resolveJustDoOverflowTerminalFailure = ({
        lastCompactionFailure,
        isCompactionFailure,
        errorText,
        promptErrorSource,
        providerConfirmedOverflow,
      }) => {
        if (lastCompactionFailure) return lastCompactionFailure;
        if (isCompactionFailure) return { kind: "compaction_failure", message: errorText };
        if (promptErrorSource === "precheck") return {
          kind: "precheck_budget",
          message: "Automatic compaction could not reduce the request below the locally estimated prompt safety budget."
        };
        if (!providerConfirmedOverflow) return {
          kind: promptErrorSource === "compaction" ? "compaction_failure" : "context_recovery_failure",
          message: errorText
        };
      }; // ${MARKER}`;

const REQUIRED_TRANSFORMED_PATTERNS = [
  /if \(promptErrorSource !== "precheck"\) \{\s*clearJustDoLastOverflowRecoveryFailure\(\);/u,
  /if \(timeoutCompactResult\.compacted\) \{\s*clearJustDoLastOverflowRecoveryFailure\(\);/u,
  /if \(!isCompactionFailure && hadAttemptLevelCompaction[^\{]+\{\s*clearJustDoLastOverflowRecoveryFailure\(\);/u,
  /if \(preflightRecovery && isNoRealConversationCompactionNoop\(compactResult\)\) \{\s*clearJustDoLastOverflowRecoveryFailure\(\);/u,
  /if \(compactResult\.compacted\) \{\s*clearJustDoLastOverflowRecoveryFailure\(\);/u,
  /if \(truncResult\.truncated\) \{\s*clearJustDoLastOverflowRecoveryFailure\(\);/u,
];

function assertTransformedContent(content, filePath) {
  for (const pattern of REQUIRED_TRANSFORMED_PATTERNS) {
    if (!pattern.test(content)) {
      throw new Error(`${filePath}: partial compaction error attribution patch`);
    }
  }
}

function findPatchTargets(runtimeDir) {
  const files = new Set(
    findFilesContaining(runtimeDir, [
      'const justDoRetryCancelledCodexCompaction =',
      'const overflowRecoveryText = "Context overflow: prompt too large for the model.',
    ]),
  );
  for (const filePath of findFilesContaining(runtimeDir, [MARKER])) files.add(filePath);
  for (const filePath of findFilesContaining(runtimeDir, APPLIED_CONTRACTS)) files.add(filePath);
  return [...files];
}

function transform(content, filePath) {
  const appliedContracts = APPLIED_CONTRACTS.filter(contract => content.includes(contract));
  if (content.includes(MARKER) || appliedContracts.length > 0) {
    if (appliedContracts.length !== APPLIED_CONTRACTS.length) {
      throw new Error(`${filePath}: partial compaction error attribution patch`);
    }
    assertTransformedContent(content, filePath);
    return content;
  }

  let out = replaceUniquePattern(
    content,
    /(let overflowCompactionAttempts = 0;)/,
    `${FAILURE_HELPER}
      $1
      let justDoLastOverflowRecoveryFailure;
      const clearJustDoLastOverflowRecoveryFailure = () => {
        justDoLastOverflowRecoveryFailure = void 0;
      };`,
    `${filePath}: terminal failure helper`,
  );
  out = replaceUniquePattern(
    out,
    /(const errorText = contextOverflowError\.text;)/,
    `$1
            const justDoProviderConfirmedOverflow =
              promptErrorSource === "prompt" || contextOverflowError.source === "assistantError";
            if (promptErrorSource !== "precheck") {
              clearJustDoLastOverflowRecoveryFailure();
            }`,
    `${filePath}: newer provider overflow supersedes stale recovery failure`,
  );
  out = replaceUniquePattern(
    out,
    /(if \(timeoutCompactResult\.compacted\) \{)/,
    `$1\n                clearJustDoLastOverflowRecoveryFailure();`,
    `${filePath}: timeout recovery success supersedes stale failure`,
  );
  out = replaceUniquePattern(
    out,
    /(if \(!isCompactionFailure && hadAttemptLevelCompaction && overflowCompactionAttempts < MAX_OVERFLOW_COMPACTION_ATTEMPTS\) \{)/,
    `$1\n              clearJustDoLastOverflowRecoveryFailure();`,
    `${filePath}: in-attempt compaction success supersedes stale failure`,
  );
  out = replaceUniquePattern(
    out,
    /(if \(compactResult\.compacted\) \{)/,
    `$1\n                clearJustDoLastOverflowRecoveryFailure();`,
    `${filePath}: clear stale compaction failure`,
  );
  out = replaceUniquePattern(
    out,
    /(if \(preflightRecovery && isNoRealConversationCompactionNoop\(compactResult\)\) \{)/,
    `$1
              clearJustDoLastOverflowRecoveryFailure();`,
    `${filePath}: clear failure for stale no-conversation snapshot`,
  );
  out = replaceUniquePattern(
    out,
    /(log[\w$]*\.warn\(`auto-compaction failed for \$\{provider\}\/\$\{modelId\}: \$\{compactResult\.reason \?\? "nothing to compact"\}`\);)/,
    `$1
              const justDoCompactionFailureReason =
                typeof compactResult.reason === "string" && compactResult.reason.trim()
                  ? compactResult.reason.trim()
                  : "Automatic context compaction did not complete.";
              justDoLastOverflowRecoveryFailure = {
                kind: compactResult.ok === false ? "compaction_failure" : "compaction_noop",
                message: justDoCompactionFailureReason
              };`,
    `${filePath}: retain actual compaction failure`,
  );
  out = replaceUniquePattern(
    out,
    /(if \(truncResult\.truncated\) \{\s*\n\s*)(log[\w$]*\.info\(`\[context-overflow-recovery\] Truncated \$\{truncResult\.truncatedCount\} tool result\(s\); retrying prompt`\);)/,
    `$1clearJustDoLastOverflowRecoveryFailure();
                $2`,
    `${filePath}: successful truncation supersedes stale recovery failure`,
  );
  out = replaceUniquePattern(
    out,
    /(const kind = isCompactionFailure \? "compaction_failure" : "context_overflow";\s*\n\s*)(const overflowRecoveryText = "Context overflow: prompt too large for the model\. Try \/reset \(or \/new\) to start a fresh session, or use a larger-context model\.";)/,
    `const justDoTerminalRecoveryFailure = resolveJustDoOverflowTerminalFailure({
              lastCompactionFailure: justDoLastOverflowRecoveryFailure,
              isCompactionFailure,
              errorText,
              promptErrorSource,
              providerConfirmedOverflow: justDoProviderConfirmedOverflow
            });
            const kind = justDoTerminalRecoveryFailure?.kind ?? (isCompactionFailure ? "compaction_failure" : "context_overflow");
            const overflowRecoveryText = justDoTerminalRecoveryFailure?.message ?? "Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session, or use a larger-context model.";
            const justDoTerminalErrorText = justDoTerminalRecoveryFailure?.message ?? errorText;`,
    `${filePath}: select truthful terminal failure`,
  );
  out = replaceUniquePattern(
    out,
    /(error:\s*\{\s*\n\s*kind,\s*\n\s*message:) errorText/,
    '$1 justDoTerminalErrorText',
    `${filePath}: terminal error metadata`,
  );
  assertTransformedContent(out, filePath);
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
      `Compaction error attribution target count is ${matches.length}, expected ${expected}`,
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
    'let justDoLastOverflowRecoveryFailure;',
    'const clearJustDoLastOverflowRecoveryFailure = () =>',
    'message: justDoTerminalErrorText',
    'resolveJustDoOverflowTerminalFailure({',
  ]);
  if (matches.length !== expected) {
    throw new Error(
      `Compaction error attribution contract count is ${matches.length}, expected ${expected}`,
    );
  }
  for (const filePath of matches) {
    assertTransformedContent(fs.readFileSync(filePath, 'utf8'), filePath);
  }
}

module.exports = {
  applyPatch,
  verifyPatch,
  transform,
  failureHelper: FAILURE_HELPER,
};
