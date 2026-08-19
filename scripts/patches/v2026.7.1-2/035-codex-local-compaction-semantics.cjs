'use strict';

// Capability: select Codex-local compaction explicitly and align its trigger/checkpoint lifecycle.
// Target: patched openclaw@2026.7.1-2 after 029-034.
// Scope: managed config schema, 90%-window preflight/mid-turn triggers, safeguard prompt flow,
// checkpoint metadata and a single overflow compact-and-retry for an unchanged prompt.
// Safety: every behavioral branch is gated by agents.defaults.compaction.justdoCodexLocal=true;
// non-Codex OpenClaw behavior is byte-for-byte unchanged outside the schema extension.
// Remove when: upstream exposes an equivalent local-compaction strategy and metadata contract.

const fs = require('fs');
const path = require('path');
const { findFilesContaining, replaceUniquePattern, writeIfChanged } = require('./_patch-utils.js');
const {
  transformAgentSession,
  transformExternalInvocationMetadata,
  transformOverflowLimit,
  transformStrictSafeguardFailures,
  transformStrictSummaryPipeline,
} = require('./_codex-local-compaction-helpers.js');

const MARKER = 'justdoCodexLocalCompactionV1';
function findPatchTargets(runtimeDir, pristineAnchors, appliedAnchor) {
  const files = new Set(findFilesContaining(runtimeDir, pristineAnchors));
  for (const filePath of findFilesContaining(runtimeDir, [appliedAnchor])) files.add(filePath);
  return [...files];
}
function transformSchema(content, filePath) {
  if (/justdoCodexLocal: (?:z\.)?boolean\(\)\.optional\(\)/.test(content)) return content;
  let out = replaceUniquePattern(
    content,
    /(mode: (z\.)?union\(\[(z\.)?literal\("default"\), (z\.)?literal\("safeguard"\)\]\)\.optional\(\),)/,
    (_match, modeLine, zPrefix) =>
      `${modeLine}\n        justdoCodexLocal: ${zPrefix ?? ''}boolean().optional(),`,
    `${filePath}: Codex-local config schema`,
  );
  return out;
}
function transformRuntimeRegistration(content, filePath) {
  if (content.includes('justdoCodexLocal: compactionCfg?.justdoCodexLocal === true'))
    return content;
  let out = replaceUniquePattern(
    content,
    /(setCompactionSafeguardRuntime\(params\.sessionManager, \{\s*maxHistoryShare: compactionCfg\?\.maxHistoryShare,)/,
    '$1\n      justdoCodexLocal: compactionCfg?.justdoCodexLocal === true,',
    `${filePath}: safeguard runtime Codex-local flag`,
  );
  return out;
}
function transformPreflight(content, filePath) {
  if (content.includes('const justdoCodexLocalCompactionV1 =')) return content;
  let out = replaceUniquePattern(
    content,
    /(const memoryFlushPlan = resolveMemoryFlushPlan\(\{ cfg: params\.cfg \}\);)(?=\s*const reserveTokensFloor = memoryFlushPlan\?\.reserveTokensFloor)/,
    `$1
  const ${MARKER} = params.cfg.agents?.defaults?.compaction?.justdoCodexLocal === true;`,
    `${filePath}: preflight Codex-local flag`,
  );
  out = replaceUniquePattern(
    out,
    /const threshold = Math\.max\(\s*contextWindowTokens - reserveTokensFloor - softThresholdTokens,\s*serverCompactionThreshold \?\? 0,?\s*\);/,
    `const threshold = ${MARKER}
    ? Math.floor(contextWindowTokens * 0.9)
    : Math.max(
        contextWindowTokens - reserveTokensFloor - softThresholdTokens,
        serverCompactionThreshold ?? 0,
      );`,
    `${filePath}: 90 percent Codex-local threshold`,
  );
  out = replaceUniquePattern(
    out,
    /const tokenCountForCompaction =\s*Number\.isFinite\(projectedTokenCount\) && projectedTokenCount > 0\s*\? projectedTokenCount\s*: (?:undefined|void 0);/,
    `const justDoMeasuredTokenCount = freshPersistedTokens ?? transcriptPromptTokens ?? stalePersistedPromptTokens;
  const tokenCountForCompaction = ${MARKER}
    ? typeof justDoMeasuredTokenCount === "number" && Number.isFinite(justDoMeasuredTokenCount) && justDoMeasuredTokenCount > 0
      ? justDoMeasuredTokenCount
      : undefined
    : Number.isFinite(projectedTokenCount) && projectedTokenCount > 0
      ? projectedTokenCount
      : undefined;`,
    `${filePath}: measured usage precedence`,
  );
  if (
    out.includes('const shouldCompact = shouldCompactByTokens || shouldCompactByTranscriptBytes;')
  ) {
    out = out.replace(
      'const shouldCompact = shouldCompactByTokens || shouldCompactByTranscriptBytes;',
      `const shouldCompact = shouldCompactByTokens || (!${MARKER} && shouldCompactByTranscriptBytes);`,
    );
  } else {
    out = replaceUniquePattern(
      out,
      /(shouldRunPreflightCompaction\(\{[\s\S]*?minimumThresholdTokens: serverCompactionThreshold\s*\}\) \|\| )shouldCompactByTranscriptBytes/,
      `$1(!${MARKER} && shouldCompactByTranscriptBytes)`,
      `${filePath}: token-only Codex-local trigger`,
    );
  }
  out = out.replace(
    /reserveTokensFloor,\s*softThresholdTokens,\s*minimumThresholdTokens: serverCompactionThreshold/,
    `reserveTokensFloor: ${MARKER} ? Math.ceil(contextWindowTokens * 0.1) : reserveTokensFloor,
      softThresholdTokens: ${MARKER} ? 0 : softThresholdTokens,
      minimumThresholdTokens: ${MARKER} ? 0 : serverCompactionThreshold`,
  );
  out = out.replace(
    'const compactionTrigger = shouldCompactByTranscriptBytes ? "transcript_bytes" : "tokens";',
    `const compactionTrigger = !${MARKER} && shouldCompactByTranscriptBytes ? "transcript_bytes" : "tokens";`,
  );
  return out;
}
function transformMidTurn(content, filePath) {
  if (content.includes('justDoCodexMidTurnReserveTokens')) return content;
  let out = replaceUniquePattern(
    content,
    /(const midTurnPrecheckEnabled =\s*params\.config\?\.agents\?\.defaults\?\.compaction\?\.midTurnPrecheck\?\.enabled === true;)/,
    `$1
      const justDoCodexMidTurnReserveTokens =
        params.config?.agents?.defaults?.compaction?.justdoCodexLocal === true
          ? Math.max(1, Math.ceil(contextTokenBudgetForGuard * 0.1))
          : undefined;`,
    `${filePath}: Codex-local mid-turn reserve`,
  );
  out = replaceUniquePattern(
    out,
    /reserveTokens: \(\) => settingsManager\.getCompactionReserveTokens\(\),/,
    'reserveTokens: () => justDoCodexMidTurnReserveTokens ?? settingsManager.getCompactionReserveTokens(),',
    `${filePath}: apply Codex-local mid-turn reserve`,
  );
  return out;
}
function transformSafeguard(content, filePath) {
  if (/const justDoCodexLocal = \w+\?\.justdoCodexLocal === true;/.test(content)) {
    return transformStrictSafeguardFailures(content);
  }
  let out = replaceUniquePattern(
    content,
    /(const \{ preparation, customInstructions: eventInstructions, signal \} = event;)/,
    `$1
    const justDoRuntime = getCompactionSafeguardRuntime(ctx.sessionManager);
    const justDoCodexLocal = justDoRuntime?.justdoCodexLocal === true;
    if (justDoCodexLocal) {
      preparation.justDoCodexLocal = true;
      const invocationStore = globalThis[Symbol.for("justdo.codex-compaction-invocation")];
      const invocation = invocationStore instanceof Map
        ? invocationStore.get(ctx.sessionManager.getSessionId())
        : undefined;
      if (invocation) {
        preparation.justDoCompactionTrigger = invocation.trigger;
        preparation.justDoCompactionReason = invocation.reason;
        preparation.justDoCompactionPhase = invocation.phase;
      }
    }`,
    `${filePath}: early safeguard Codex-local selection`,
  );
  out = replaceUniquePattern(
    out,
    /(let hasRealSummarizable = containsRealConversation\(baseMessagesToSummarize\);)/,
    `if (justDoCodexLocal) {
      const branch = ctx.sessionManager?.getBranch?.() ?? [];
      let latestCompactionIndex = -1;
      for (let index = branch.length - 1; index >= 0; index -= 1) {
        if (branch[index]?.type === "compaction") {
          latestCompactionIndex = index;
          break;
        }
      }
      const latestCompaction = latestCompactionIndex >= 0 ? branch[latestCompactionIndex] : undefined;
      const previousArchive = latestCompaction?.details?.justdoRetainedUserMessages;
      const previousRetainedUsers = Array.isArray(previousArchive?.messages)
        ? previousArchive.messages
            .filter((record) => record && typeof record.text === "string" && record.text.length > 0)
            .map((record) => ({
              role: "user",
              content: record.text,
              timestamp: Number.isFinite(record.timestamp) ? record.timestamp : 0,
            }))
        : [];
      const justDoCodexSummaryPrefix = "Another language model started " +
        "to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";
      const previousSummaryMessage = latestCompaction?.summary
        ? [{
            role: "user",
            content: \`${'${justDoCodexSummaryPrefix}'}\\n${'${latestCompaction.summary}'}\`,
            timestamp: coerceTimestamp(latestCompaction.timestamp),
          }]
        : [];
      const postCompactionMessages = latestCompactionIndex >= 0
        ? branch.slice(latestCompactionIndex + 1)
            .map((entry) => sessionBranchEntryToMessage(entry))
            .filter((message) => Boolean(message))
        : collectSessionBranchMessages(ctx.sessionManager);
      if (latestCompactionIndex >= 0 && postCompactionMessages.length === 0) return { cancel: true };
      const installedContext = stripRuntimeContextCustomMessages(
        latestCompactionIndex >= 0
          ? [...previousRetainedUsers, ...previousSummaryMessage, ...postCompactionMessages]
          : postCompactionMessages,
      );
      if (containsRealConversation(installedContext)) baseMessagesToSummarize = installedContext;
      baseTurnPrefixMessages = [];
    }
    $1`,
    `${filePath}: installed Codex-local compaction context`,
  );
  out = replaceUniquePattern(
    out,
    /(setCompactionSafeguardCancelReason\(ctx\.sessionManager, (?:undefined|void 0)\);\s*if \(!hasRealSummarizable && !hasRealTurnPrefix\) \{)/,
    '$1\n      if (justDoCodexLocal) return { cancel: true };',
    `${filePath}: no-transcript Codex-local progress guard`,
  );
  out = out.replace(
    'const turnPrefixMessages = baseTurnPrefixMessages;',
    'const turnPrefixMessages = justDoCodexLocal ? [] : baseTurnPrefixMessages;',
  );
  out = out.replace(
    'const recentTurnsPreserve = resolveRecentTurnsPreserve(runtime?.recentTurnsPreserve);',
    'const recentTurnsPreserve = justDoCodexLocal ? 0 : resolveRecentTurnsPreserve(runtime?.recentTurnsPreserve);',
  );
  out = out.replace(
    'const structuredInstructions = buildCompactionStructureInstructions(\n      customInstructions,\n      summarizationInstructions,\n    );',
    'const structuredInstructions = justDoCodexLocal\n      ? undefined\n      : buildCompactionStructureInstructions(customInstructions, summarizationInstructions);',
  );
  out = out.replace(
    'const structuredInstructions = buildCompactionStructureInstructions(customInstructions, summarizationInstructions);',
    'const structuredInstructions = justDoCodexLocal ? undefined : buildCompactionStructureInstructions(customInstructions, summarizationInstructions);',
  );
  out = out.replace('if (providerId) {', 'if (providerId && !justDoCodexLocal) {');
  out = out.replace(
    'const qualityGuardEnabled = runtime?.qualityGuardEnabled ?? false;',
    'const qualityGuardEnabled = justDoCodexLocal ? false : runtime?.qualityGuardEnabled ?? false;',
  );
  out = out.replace(
    'if (tokensBefore !== undefined) {',
    'if (tokensBefore !== undefined && !justDoCodexLocal) {',
  );
  out = out.replace(
    'if (tokensBefore !== void 0) {',
    'if (tokensBefore !== void 0 && !justDoCodexLocal) {',
  );
  out = out.replace(
    'const effectivePreviousSummary = droppedSummary ?? preparation.previousSummary;',
    'const effectivePreviousSummary = justDoCodexLocal\n        ? undefined\n        : droppedSummary ?? preparation.previousSummary;',
  );
  out = transformStrictSafeguardFailures(out);
  if (/const bodyToCap = lastHistorySummary \|\| summary;/.test(out)) {
    out = replaceUniquePattern(
      out,
      /const bodyToCap = lastHistorySummary \|\| summary;\s*summary = capCompactionSummaryPreservingSuffix\(bodyToCap, suffix\);/,
      `const bodyToCap = lastHistorySummary || summary;
      summary = justDoCodexLocal ? bodyToCap : capCompactionSummaryPreservingSuffix(bodyToCap, suffix);`,
      `${filePath}: no structural suffix or char cap in Codex-local mode`,
    );
  } else {
    out = replaceUniquePattern(
      out,
      /summary = capCompactionSummaryPreservingSuffix\(lastHistorySummary \|\| summary, suffix\);/,
      'summary = justDoCodexLocal ? lastHistorySummary || summary : capCompactionSummaryPreservingSuffix(lastHistorySummary || summary, suffix);',
      `${filePath}: no structural suffix or char cap in Codex-local mode`,
    );
  }
  out = replaceUniquePattern(
    out,
    /(summary = justDoCodexLocal \?[^;]+;\s*)(return\s*\{\s*compaction:)/,
    `$1const justDoSummaryContent =
        "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:\\n" + summary;
      const justDoComparableMessagesBefore = [...baseMessagesToSummarize, ...baseTurnPrefixMessages]
        .map((message) => ({ role: message?.role, content: message?.content }));
      const justDoComparableMessagesAfter = [
        ...(preparation.justDoRetainedUserMessages?.messages ?? []).map((record) => ({
          role: "user",
          content: record.text,
        })),
        { role: "user", content: justDoSummaryContent },
      ];
      const justDoComparableTokensBefore = Math.ceil(Buffer.byteLength(
        JSON.stringify(justDoComparableMessagesBefore), "utf8",
      ) / 4);
      const justDoCodexTokensAfter = Math.ceil(Buffer.byteLength(
        JSON.stringify(justDoComparableMessagesAfter), "utf8",
      ) / 4);
      if (justDoCodexLocal) {
        const madeProgress = justDoCodexTokensAfter < justDoComparableTokensBefore;
        const belowTrigger = justDoCodexTokensAfter < Math.floor(contextWindowTokens * 0.9);
        const enforceAutoThreshold = preparation.justDoCompactionTrigger !== "manual";
        if (!madeProgress || (enforceAutoThreshold && !belowTrigger)) {
          throw new Error(
            \`Codex-local compaction made no safe progress: before=${'${justDoComparableTokensBefore}'} after=${'${justDoCodexTokensAfter}'} threshold=${'${Math.floor(contextWindowTokens * 0.9)}'}\`,
          );
        }
      }
      $2`,
    `${filePath}: Codex-local compaction progress guard`,
  );
  out = replaceUniquePattern(
    out,
    /details:\s*\{\s*readFiles,\s*modifiedFiles\s*\},?\s*\},?\s*\};\s*\} catch \(error\)/,
    `details: {
            readFiles,
            modifiedFiles,
            ...(justDoCodexLocal ? {
              justdoRetainedUserMessages: preparation.justDoRetainedUserMessages,
              justdoCompaction: {
                version: 1,
                semantics: "codex-local",
                generation: preparation.justDoCompactionGeneration ?? 1,
                trigger: preparation.justDoCompactionTrigger ?? "auto",
                reason: preparation.justDoCompactionReason ?? "context_limit",
                phase: preparation.justDoCompactionPhase ?? "pre_turn",
                tokensBefore: justDoComparableTokensBefore,
                tokensAfter: justDoCodexTokensAfter
              }
            } : {})
          },
        },
      };
    } catch (error)`,
    `${filePath}: Codex-local checkpoint metadata`,
  );
  return out;
}

function applyPatch(runtimeDir) {
  const groups = [
    [
      findPatchTargets(
        runtimeDir,
        [
          'mode: union([literal("default"), literal("safeguard")]).optional()',
          'reserveTokensFloor: number().int().nonnegative().optional()',
        ],
        'justdoCodexLocal: boolean().optional()',
      ),
      transformSchema,
    ],
    [
      findPatchTargets(
        runtimeDir,
        [
          'setCompactionSafeguardRuntime(params.sessionManager, {',
          'maxHistoryShare: compactionCfg?.maxHistoryShare',
        ],
        'justdoCodexLocal: compactionCfg?.justdoCodexLocal === true',
      ),
      transformRuntimeRegistration,
    ],
    [
      findPatchTargets(
        runtimeDir,
        [
          'const memoryFlushPlan = resolveMemoryFlushPlan({ cfg: params.cfg });',
          'shouldRunPreflightCompaction({',
          'shouldCompactByTranscriptBytes',
        ],
        `const ${MARKER} =`,
      ),
      transformPreflight,
    ],
    [
      findPatchTargets(
        runtimeDir,
        [
          'const midTurnPrecheckEnabled =',
          'reserveTokens: () => settingsManager.getCompactionReserveTokens(),',
        ],
        'justDoCodexMidTurnReserveTokens',
      ),
      transformMidTurn,
    ],
    [
      findPatchTargets(
        runtimeDir,
        [
          'async function summarizeWithFallback(params)',
          'async function summarizeInStages(params)',
          'const mergeInstructions =',
        ],
        'justDoCodexLocalSummaryPipelineV1',
      ),
      transformStrictSummaryPipeline,
    ],
    [
      findPatchTargets(
        runtimeDir,
        [
          'function compactionSafeguardExtension(api)',
          'buildCompactionStructureInstructions(',
          'buildJustDoEmergencyHandoffSummary',
        ],
        'const justDoCodexLocal = runtime?.justdoCodexLocal === true;',
      ),
      transformSafeguard,
    ],
    [
      findPatchTargets(
        runtimeDir,
        [
          'const activeSession = session;',
          'return activeSession.compact(params.customInstructions);',
        ],
        'justDoCodexExternalCompactionInvocationV1',
      ),
      transformExternalInvocationMetadata,
    ],
    [
      findPatchTargets(
        runtimeDir,
        ['async runCompactionWork(options)', 'this.sessionManager.appendCompaction('],
        'justDoCodexCompactionDetails',
      ),
      transformAgentSession,
    ],
    [
      findPatchTargets(
        runtimeDir,
        ['const MAX_OVERFLOW_COMPACTION_ATTEMPTS = 3;', 'overflowCompactionAttempts'],
        'justDoCodexOverflowAttemptLimit',
      ),
      transformOverflowLimit,
    ],
  ];
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  for (const [matches, transform] of groups) {
    const gatewayMatches = matches.filter(
      filePath => path.basename(filePath) === 'gateway-bundle.mjs',
    );
    const invalidPlacement =
      expected === 2 &&
      (gatewayMatches.length !== 1 || matches.length - gatewayMatches.length !== 1);
    if (matches.length !== expected || invalidPlacement) {
      throw new Error(
        `Codex-local compaction target count for ${transform.name} is ${matches.length}, expected ${expected}`,
      );
    }
  }
  const transforms = groups.flatMap(([matches, transform]) =>
    matches.map(filePath => [filePath, transform]),
  );
  const byFile = new Map();
  for (const [filePath, transform] of transforms) {
    byFile.set(filePath, [...(byFile.get(filePath) ?? []), transform]);
  }
  const changed = [];
  for (const [filePath, fileTransforms] of byFile) {
    const original = fs.readFileSync(filePath, 'utf8');
    const updated = fileTransforms.reduce(
      (value, transform) => transform(value, filePath),
      original,
    );
    if (writeIfChanged(filePath, original, updated))
      changed.push(path.relative(runtimeDir, filePath));
  }
  return changed;
}

function verifyPatch(runtimeDir) {
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  const contracts = [
    ['justdoCodexLocal: boolean().optional()'],
    ['justdoCodexLocal: compactionCfg?.justdoCodexLocal === true'],
    [`const ${MARKER} =`, 'Math.floor(contextWindowTokens * 0.9)'],
    ['justDoCodexMidTurnReserveTokens'],
    ['justDoCodexLocalSummaryPipelineV1'],
    [
      'justDoCodexTokensAfter',
      'Codex-local compaction summarization exhausted safe staged retries',
    ],
    ['justDoCodexExternalCompactionInvocationV1'],
    ['justDoCodexCompactionDetails'],
    ['justDoCodexOverflowAttemptLimit'],
  ];
  for (const anchors of contracts) {
    const matches = findFilesContaining(runtimeDir, anchors);
    const gatewayMatches = matches.filter(
      filePath => path.basename(filePath) === 'gateway-bundle.mjs',
    );
    const invalidPlacement =
      expected === 2 &&
      (gatewayMatches.length !== 1 || matches.length - gatewayMatches.length !== 1);
    if (matches.length !== expected || invalidPlacement) {
      throw new Error(
        `Codex-local compaction contract count for ${anchors.join(' + ')} is ${matches.length}, expected ${expected}`,
      );
    }
  }
}

module.exports = {
  applyPatch,
  verifyPatch,
  transformSchema,
  transformRuntimeRegistration,
  transformPreflight,
  transformMidTurn,
  transformStrictSummaryPipeline,
  transformStrictSafeguardFailures,
  transformSafeguard,
  transformExternalInvocationMetadata,
  transformAgentSession,
  transformOverflowLimit,
};
