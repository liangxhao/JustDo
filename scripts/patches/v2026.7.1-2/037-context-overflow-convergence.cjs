'use strict';

// Capability: converge recoverable Codex-local context overflows without ending the active turn.
// Target: patched openclaw@2026.7.1-2 after 035 Codex-local compaction semantics.
// Scope: bounded multi-pass overflow compaction, progressively smaller recovery checkpoints,
// unchanged-checkpoint recompaction, retry after a cancelled pass and transient lifecycle fencing.
// Safety: the normal Codex checkpoint is unchanged; aggressive budgets activate only after an
// observed overflow, remain capped at three passes and preserve recent user text plus handoff tails.
// Remove when: upstream retries overflow with convergent checkpoints and non-terminal attempt events.

const fs = require('fs');
const path = require('path');
const { findFilesContaining, replaceUniquePattern, writeIfChanged } = require('./_patch-utils.js');

const MARKER = 'JUSTDO_CONTEXT_OVERFLOW_CONVERGENCE_V2026_7_1_2';

function findPatchTargets(runtimeDir, pristineAnchors, appliedAnchor) {
  const files = new Set(findFilesContaining(runtimeDir, pristineAnchors));
  for (const filePath of findFilesContaining(runtimeDir, [appliedAnchor])) files.add(filePath);
  return [...files];
}

function transformAttemptLoop(content, filePath) {
  if (
    content.includes(`${MARKER}_ATTEMPT_LOOP`) ||
    (content.includes('const justDoCodexOverflowAttemptLimit =') &&
      /justdoCodexLocal === true\s*\? 3\s*: 3;/u.test(content) &&
      content.includes('const justDoRetryCancelledCodexCompaction =') &&
      content.includes('overflowCompactionAttempts < MAX_OVERFLOW_COMPACTION_ATTEMPTS'))
  )
    return content;
  let out = replaceUniquePattern(
    content,
    /(const justDoCodexOverflowAttemptLimit =\s*params\.config\?\.agents\?\.defaults\?\.compaction\?\.justdoCodexLocal === true \?)\s*1(\s*: 3;)/,
    `$1 3$2 // ${MARKER}_ATTEMPT_LOOP`,
    `${filePath}: three-pass Codex-local overflow recovery`,
  );
  out = replaceUniquePattern(
    out,
    /(log[\w$]*\.warn\(`auto-compaction failed for \$\{provider\}\/\$\{modelId\}: \$\{compactResult\.reason \?\? "nothing to compact"\}`\);)/,
    `$1
              const justDoRetryCancelledCodexCompaction =
                params.config?.agents?.defaults?.compaction?.justdoCodexLocal === true &&
                !params.abortSignal?.aborted &&
                overflowCompactionAttempts < MAX_OVERFLOW_COMPACTION_ATTEMPTS;
              if (justDoRetryCancelledCodexCompaction) {
                if (preflightRecovery?.source === "mid-turn") continueFromCurrentTranscript();
                continue;
              }`,
    `${filePath}: retry cancelled Codex-local compaction pass`,
  );
  return out;
}

function transformExternalInvocation(content, filePath) {
  if (
    content.includes(`${MARKER}_INVOCATION_ATTEMPT`) ||
    (content.includes('justDoCodexExternalCompactionInvocationV1') &&
      content.includes('attempt: Number.isFinite(params.attempt)'))
  )
    return content;
  return replaceUniquePattern(
    content,
    /(phase: justDoManual \|\| params\.forcePreflight === true \|\| params\.preflightRequired === true \|\| justDoExternalTrigger === "budget"\s*\? "pre_turn"\s*: "mid_turn")/,
    `$1,
              attempt: Number.isFinite(params.attempt)
                ? Math.max(1, Math.floor(params.attempt))
                : 0 // ${MARKER}_INVOCATION_ATTEMPT`,
    `${filePath}: forward overflow compaction attempt`,
  );
}

const RECOVERY_HELPERS = `function estimateJustDoOverflowRecoveryTokens(value) {
  return Math.ceil(Buffer.byteLength(typeof value === "string" ? value : "", "utf8") / 4);
}
function sliceJustDoOverflowRecoveryText(value, tokenBudget) {
  const text = typeof value === "string" ? value : "";
  if (tokenBudget <= 0 || !text) return "";
  if (estimateJustDoOverflowRecoveryTokens(text) <= tokenBudget) return text;
  const maxBytes = Math.max(0, Math.floor(tokenBudget) * 4);
  let marker = "…overflow recovery omitted older detail…";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (markerBytes >= maxBytes) return marker.slice(0, Math.max(1, tokenBudget));
  const contentBytes = maxBytes - markerBytes;
  const leftBudget = Math.floor(contentBytes / 2);
  const rightBudget = contentBytes - leftBudget;
  let prefix = "";
  let prefixBytes = 0;
  for (const character of text) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (prefixBytes + bytes > leftBudget) break;
    prefix += character;
    prefixBytes += bytes;
  }
  let suffix = "";
  let suffixBytes = 0;
  for (const character of Array.from(text).reverse()) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (suffixBytes + bytes > rightBudget) break;
    suffix = character + suffix;
    suffixBytes += bytes;
  }
  return prefix + marker + suffix;
}
function buildJustDoOverflowRecoveryArchive(archive, tokenBudget) {
  const budget = Math.max(0, Math.floor(tokenBudget));
  const records = Array.isArray(archive?.messages)
    ? archive.messages.filter((record) => record && typeof record.text === "string" && record.text.length > 0)
    : [];
  let remainingTokens = budget;
  const messages = [];
  for (let index = records.length - 1; index >= 0 && remainingTokens > 0; index -= 1) {
    const record = records[index];
    const text = sliceJustDoOverflowRecoveryText(record.text, remainingTokens);
    if (!text) break;
    messages.unshift({ ...record, text, ...(text !== record.text ? { truncated: true } : {}) });
    remainingTokens -= estimateJustDoOverflowRecoveryTokens(text);
  }
  return {
    ...(archive && typeof archive === "object" ? archive : {}),
    version: 1,
    tokenBudget: budget,
    estimatedTokens: budget - Math.max(0, remainingTokens),
    messages,
    overflowRecovery: true
  };
}`;

function transformSafeguard(content, filePath) {
  if (
    content.includes(`${MARKER}_SAFEGUARD`) ||
    (content.includes('function buildJustDoOverflowRecoveryArchive(') &&
      content.includes('preparation.justDoCompactionAttempt = invocation.attempt;') &&
      content.includes('preparation.justDoOverflowRecoveryTargetTokens'))
  )
    return content;
  let out = replaceUniquePattern(
    content,
    /function compactionSafeguardExtension/,
    `${RECOVERY_HELPERS}\nfunction compactionSafeguardExtension`,
    `${filePath}: overflow recovery helpers`,
  );
  out = replaceUniquePattern(
    out,
    /(preparation\.justDoCompactionPhase = invocation\.phase;)/,
    `$1
        preparation.justDoCompactionAttempt = invocation.attempt; // ${MARKER}_SAFEGUARD`,
    `${filePath}: receive overflow compaction attempt`,
  );
  out = replaceUniquePattern(
    out,
    /const previousRetainedUsers = (Array\.isArray\(previousArchive\?\.messages\)[\s\S]*?\s*: \[\];)/,
    'let previousRetainedUsers = $1',
    `${filePath}: mutable retained-user replay`,
  );
  out = replaceUniquePattern(
    out,
    /if \(latestCompactionIndex >= 0 && postCompactionMessages\.length === 0\) return \{ cancel: true \};/,
    `const justDoOverflowRecoveryAttempt = Number.isFinite(preparation.justDoCompactionAttempt)
        ? Math.max(0, Math.floor(preparation.justDoCompactionAttempt))
        : 0;
      const justDoRecompactUnchangedCheckpoint =
        latestCompactionIndex >= 0 &&
        postCompactionMessages.length === 0 &&
        preparation.justDoCompactionReason === "overflow";
      if (
        latestCompactionIndex >= 0 &&
        postCompactionMessages.length === 0 &&
        !justDoRecompactUnchangedCheckpoint
      ) return { cancel: true };
      const justDoAggressiveOverflowRecovery =
        preparation.justDoCompactionReason === "overflow" &&
        (justDoRecompactUnchangedCheckpoint || justDoOverflowRecoveryAttempt > 1);
      if (justDoAggressiveOverflowRecovery) {
        const recoveryInputMessages = [
          ...previousRetainedUsers,
          ...previousSummaryMessage,
          ...postCompactionMessages,
        ].map((message) => ({ role: message?.role, content: message?.content }));
        const recoveryInputTokens = Math.max(1, Math.ceil(Buffer.byteLength(
          JSON.stringify(recoveryInputMessages), "utf8",
        ) / 4));
        const aggressivePass = justDoOverflowRecoveryAttempt >= 3;
        const windowTarget = Math.floor(contextWindowTokens * (aggressivePass ? 0.25 : 0.5));
        const progressTarget = Math.floor(recoveryInputTokens * (aggressivePass ? 0.4 : 0.6));
        const recoveryTargetTokens = Math.max(512, Math.min(windowTarget, progressTarget));
        const archiveTokenBudget = Math.max(
          128,
          Math.min(aggressivePass ? 2000 : 8000, Math.floor(recoveryTargetTokens * 0.25)),
        );
        preparation.justDoRetainedUserMessages = buildJustDoOverflowRecoveryArchive(
          preparation.justDoRetainedUserMessages ?? previousArchive,
          archiveTokenBudget,
        );
        preparation.justDoOverflowRecoveryTargetTokens = recoveryTargetTokens;
        preparation.justDoOverflowRecoveryAttempt = Math.max(1, justDoOverflowRecoveryAttempt);
        previousRetainedUsers = preparation.justDoRetainedUserMessages.messages.map((record) => ({
          role: "user",
          content: record.text,
          timestamp: Number.isFinite(record.timestamp) ? record.timestamp : 0,
        }));
      }`,
    `${filePath}: unchanged checkpoint recovery and progressive budget`,
  );
  out = replaceUniquePattern(
    out,
    /const customInstructions = resolveCompactionInstructions\(eventInstructions, runtime\?\.customInstructions\);/,
    `const baseCustomInstructions = resolveCompactionInstructions(eventInstructions, runtime?.customInstructions);
    const customInstructions = preparation.justDoOverflowRecoveryTargetTokens
      ? \`${'${baseCustomInstructions ?? ""}'}\\n\\nOverflow recovery: the previous compacted prompt still exceeded the model context. Produce a concise but complete continuation handoff within approximately ${'${preparation.justDoOverflowRecoveryTargetTokens}'} tokens.\`.trim()
      : baseCustomInstructions;`,
    `${filePath}: bounded Codex recovery instruction`,
  );
  out = replaceUniquePattern(
    out,
    /(summary = justDoCodexLocal \? lastHistorySummary \|\| summary : capCompactionSummaryPreservingSuffix\(lastHistorySummary \|\| summary, suffix\);)/,
    `$1
      if (justDoCodexLocal && preparation.justDoOverflowRecoveryTargetTokens) {
        const retainedTokens = preparation.justDoRetainedUserMessages?.estimatedTokens ?? 0;
        const summaryTokenBudget = Math.max(
          256,
          preparation.justDoOverflowRecoveryTargetTokens - retainedTokens - 512,
        );
        summary = sliceJustDoOverflowRecoveryText(summary, summaryTokenBudget);
      }`,
    `${filePath}: enforce recovery checkpoint budget`,
  );
  out = replaceUniquePattern(
    out,
    /(phase: preparation\.justDoCompactionPhase \?\? "pre_turn",)/,
    `$1
                ...(preparation.justDoOverflowRecoveryAttempt ? {
                  overflowRecoveryAttempt: preparation.justDoOverflowRecoveryAttempt,
                  overflowRecoveryTargetTokens: preparation.justDoOverflowRecoveryTargetTokens
                } : {}),`,
    `${filePath}: recovery checkpoint metadata`,
  );
  return out;
}

function transformLifecycle(content, filePath) {
  if (
    content.includes(`${MARKER}_LIFECYCLE`) ||
    (content.includes('function isJustDoRecoverableContextOverflow(') &&
      /classifyFailoverReason[\s\S]{0,160}===\s*["']context_overflow["']/u.test(
        content,
      ) &&
      content.includes('const suppressJustDoOverflowTerminal ='))
  )
    return content;
  let out = replaceUniquePattern(
    content,
    /function handleAgentEnd\(ctx, evt\) \{/,
    `function isJustDoRecoverableContextOverflow(value, provider) {
  return classifyFailoverReason(typeof value === "string" ? value : "", { provider }) === 'context_overflow';
}
function handleAgentEnd(ctx, evt) {`,
    `${filePath}: recoverable overflow classifier`,
  );
  out = replaceUniquePattern(
    out,
    /const isError = isAssistantMessage\(lastAssistant\) && lastAssistant\.stopReason === "error";/,
    `const suppressJustDoOverflowTerminal =
    ctx.params.config?.agents?.defaults?.compaction?.justdoCodexLocal === true &&
    isAssistantMessage(lastAssistant) && lastAssistant.stopReason === "error" &&
    isJustDoRecoverableContextOverflow(
      lastAssistant.errorMessage,
      lastAssistant.provider,
    ); // ${MARKER}_LIFECYCLE
  const isError = isAssistantMessage(lastAssistant) && lastAssistant.stopReason === "error" && !suppressJustDoOverflowTerminal;`,
    `${filePath}: suppress transient overflow error`,
  );
  out = replaceUniquePattern(
    out,
    /(const emitLifecycleTerminal = \(\) => \{)/,
    '$1\n\t\tif (suppressJustDoOverflowTerminal) return;',
    `${filePath}: defer terminal lifecycle to recovered attempt`,
  );
  return out;
}

function applyPatch(runtimeDir) {
  const groups = [
    [
      findPatchTargets(
        runtimeDir,
        ['justDoCodexOverflowAttemptLimit', 'overflowCompactionAttempts'],
        `${MARKER}_ATTEMPT_LOOP`,
      ),
      transformAttemptLoop,
    ],
    [
      findPatchTargets(
        runtimeDir,
        ['justDoCodexExternalCompactionInvocationV1', 'justDoInvocationStore.set'],
        `${MARKER}_INVOCATION_ATTEMPT`,
      ),
      transformExternalInvocation,
    ],
    [
      findPatchTargets(
        runtimeDir,
        [
          'const justDoCodexLocal = justDoRuntime?.justdoCodexLocal === true;',
          'postCompactionMessages.length === 0',
        ],
        `${MARKER}_SAFEGUARD`,
      ),
      transformSafeguard,
    ],
    [
      findPatchTargets(
        runtimeDir,
        ['function handleAgentEnd(ctx, evt)', 'const emitLifecycleTerminal = () => {'],
        `${MARKER}_LIFECYCLE`,
      ),
      transformLifecycle,
    ],
  ];
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  for (const [matches, transform] of groups) {
    const gatewayMatches = matches.filter(
      filePath => path.basename(filePath) === 'gateway-bundle.mjs',
    );
    if (matches.length !== expected || (expected === 2 && gatewayMatches.length !== 1)) {
      throw new Error(
        `Context overflow convergence target count for ${transform.name} is ${matches.length}, expected ${expected}`,
      );
    }
  }
  const byFile = new Map();
  for (const [matches, transform] of groups) {
    for (const filePath of matches)
      byFile.set(filePath, [...(byFile.get(filePath) ?? []), transform]);
  }
  const changed = [];
  for (const [filePath, transforms] of byFile) {
    const original = fs.readFileSync(filePath, 'utf8');
    const updated = transforms.reduce((value, transform) => transform(value, filePath), original);
    if (writeIfChanged(filePath, original, updated))
      changed.push(path.relative(runtimeDir, filePath));
  }
  return changed;
}

function verifyPatch(runtimeDir) {
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  for (const contract of [
    [
      'const justDoCodexOverflowAttemptLimit =',
      'const justDoRetryCancelledCodexCompaction =',
      'overflowCompactionAttempts < MAX_OVERFLOW_COMPACTION_ATTEMPTS',
    ],
    ['justDoCodexExternalCompactionInvocationV1', 'attempt: Number.isFinite(params.attempt)'],
    ['buildJustDoOverflowRecoveryArchive', 'justDoOverflowRecoveryTargetTokens'],
    [
      'isJustDoRecoverableContextOverflow',
      'classifyFailoverReason',
      'context_overflow',
      'suppressJustDoOverflowTerminal',
    ],
  ]) {
    const matches = findFilesContaining(runtimeDir, contract);
    if (matches.length !== expected) {
      throw new Error(
        `Context overflow convergence contract ${contract.join(' + ')} is incomplete`,
      );
    }
  }
}

module.exports = {
  applyPatch,
  verifyPatch,
  transformAttemptLoop,
  transformExternalInvocation,
  transformSafeguard,
  transformLifecycle,
  recoveryHelpers: RECOVERY_HELPERS,
};
