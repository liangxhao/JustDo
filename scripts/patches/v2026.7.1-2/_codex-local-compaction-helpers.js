'use strict';

const { replaceUniquePattern } = require('./_patch-utils.js');

function transformStrictSummaryPipeline(content, filePath) {
  if (content.includes('justDoCodexLocalSummaryPipelineV1')) return content;
  let out = replaceUniquePattern(
    content,
    /(async function summarizeWithFallback\(params\) \{)/,
    '$1\n\tconst justDoCodexLocalSummaryPipelineV1 = params.justDoCodexLocal === true;',
    `${filePath}: strict Codex-local summary pipeline marker`,
  );
  out = replaceUniquePattern(
    out,
    /(catch \(err\) \{\s*if \(params\.signal\.aborted\) (?:\{\s*throw err;\s*\}|throw err;))/,
    '$1\n\t\tif (params.justDoCodexLocal === true) throw err;',
    `${filePath}: reject partial Codex-local chunk summaries`,
  );
  out = replaceUniquePattern(
    out,
    /(catch \(fullError\) \{\s*if \(params\.signal\.aborted\) (?:\{\s*throw fullError;\s*\}|throw fullError;))/,
    '$1\n\t\tif (justDoCodexLocalSummaryPipelineV1) throw fullError;',
    `${filePath}: reject generic Codex-local fallback summaries`,
  );
  if (out.includes('shouldRetry: (err) => {')) {
    out = replaceUniquePattern(
      out,
      /(shouldRetry: \(err\) => \{\s*if \(params\.signal\.aborted\) return false;)/,
      '$1\n\t\t\t\tif (params.justDoCodexLocal === true) return false;',
      `${filePath}: let Codex-local classify provider failures`,
    );
  }
  out = out.replace(
    'const mergeInstructions = custom\n\t\t? `${MERGE_SUMMARIES_INSTRUCTIONS}\\n\\n${custom}`\n\t\t: MERGE_SUMMARIES_INSTRUCTIONS;',
    'const mergeInstructions = params.justDoCodexLocal === true\n\t\t? custom\n\t\t: custom\n\t\t\t? `${MERGE_SUMMARIES_INSTRUCTIONS}\\n\\n${custom}`\n\t\t\t: MERGE_SUMMARIES_INSTRUCTIONS;',
  );
  out = out.replace(
    'const mergeInstructions = custom ? `${MERGE_SUMMARIES_INSTRUCTIONS}\\n\\n${custom}` : MERGE_SUMMARIES_INSTRUCTIONS;',
    'const mergeInstructions = params.justDoCodexLocal === true ? custom : custom ? `${MERGE_SUMMARIES_INSTRUCTIONS}\\n\\n${custom}` : MERGE_SUMMARIES_INSTRUCTIONS;',
  );
  if (!out.includes('params.justDoCodexLocal === true ? custom')) {
    throw new Error(`${filePath}: Codex-local merge prompt target missing`);
  }
  return out;
}

function transformStrictSafeguardFailures(content) {
  if (content.includes('Codex-local compaction summarization exhausted safe staged retries')) {
    return content.replace(
      'tokensBefore: preparation.tokensBefore,\n                tokensAfter: justDoCodexTokensAfter',
      'tokensBefore: justDoComparableTokensBefore,\n                tokensAfter: justDoCodexTokensAfter',
    );
  }
  let out = content.replace(
    /return compactionSafeguardDeps\.summarizeInStages\(\{\s*(?:messages|messages:\s*params\.messages),([\s\S]*?justDoCompactionSessionId: params\.justDoCompactionSessionId\s*)\}\);/,
    `const isJustDoContextOverflowError = (error) => {
    const message = formatErrorMessage(error);
    const lower = message.toLowerCase();
    if (/\\b(?:tpm|429)\\b|tokens per minute|rate limit|quota|billing|unauthori[sz]ed|forbidden/.test(lower)) return false;
    return lower.includes("context length exceeded") ||
      lower.includes("maximum context length") ||
      lower.includes("prompt is too long") ||
      lower.includes("prompt too long") ||
      lower.includes("exceeds model context window") ||
      lower.includes("context_window_exceeded") ||
      lower.includes("context overflow:") ||
      lower.includes("上下文过长") || lower.includes("上下文超出") ||
      lower.includes("上下文长度超") || lower.includes("超出最大上下文");
  };
  let remainingMessages = params.messages;
  while (true) {
    try {
      const summary = await compactionSafeguardDeps.summarizeInStages({$1,
        messages: remainingMessages,
        justDoCodexLocal: params.codexLocal === true
      });
      if (
        params.codexLocal === true &&
        /^Context contained \\d+ messages .*Summary unavailable due to size limits\\.$/.test(summary)
      ) throw new Error('Codex-local compaction summarization exhausted safe staged retries');
      return summary;
    } catch (error) {
      if (params.codexLocal !== true || !isJustDoContextOverflowError(error)) throw error;
      if (remainingMessages.length <= 1) throw error;
      const firstUserIndex = remainingMessages.findIndex((message) => message?.role === "user");
      if (firstUserIndex < 0) throw error;
      const nextUserIndex = remainingMessages.findIndex(
        (message, index) => index > firstUserIndex && message?.role === "user",
      );
      const dropCount = firstUserIndex > 0 ? firstUserIndex : nextUserIndex;
      if (dropCount <= 0) throw error;
      const trimmedMessages = remainingMessages.slice(dropCount);
      if (trimmedMessages.length >= remainingMessages.length) throw error;
      remainingMessages = trimmedMessages;
    }
  }`,
  );
  out = out.replace(
    /summarizeViaLLM\(\{\s*/g,
    'summarizeViaLLM({\n              codexLocal: justDoCodexLocal,\n              ',
  );
  out = out.replace(
    'summarizationInstructions: params.summarizationInstructions,',
    'summarizationInstructions: params.codexLocal === true ? undefined : params.summarizationInstructions,',
  );
  return out;
}

function transformOverflowLimit(content, filePath) {
  if (content.includes('justDoCodexOverflowAttemptLimit')) return content;
  return replaceUniquePattern(
    content,
    /const MAX_OVERFLOW_COMPACTION_ATTEMPTS = 3;/,
    `const justDoCodexOverflowAttemptLimit =
        params.config?.agents?.defaults?.compaction?.justdoCodexLocal === true ? 1 : 3;
      const MAX_OVERFLOW_COMPACTION_ATTEMPTS = justDoCodexOverflowAttemptLimit;`,
    `${filePath}: one unchanged-prompt overflow retry`,
  );
}

function transformExternalInvocationMetadata(content, filePath) {
  if (content.includes('justDoCodexExternalCompactionInvocationV1')) return content;
  return replaceUniquePattern(
    content,
    /(const activeSession = session;\s*const result = await compactWithSafetyTimeout\()\(\) => \{([\s\S]*?setCompactionSafeguardCancelReason\(compactionSessionManager, (?:void 0|undefined)\);\s*)return activeSession\.compact\(params\.customInstructions\);/,
    `$1async () => {$2const justDoCodexExternalCompactionInvocationV1 = Symbol.for("justdo.codex-compaction-invocation");
            const justDoInvocationStore = globalThis[justDoCodexExternalCompactionInvocationV1] instanceof Map
              ? globalThis[justDoCodexExternalCompactionInvocationV1]
              : new Map();
            globalThis[justDoCodexExternalCompactionInvocationV1] = justDoInvocationStore;
            const justDoExternalTrigger = params.trigger ?? "manual";
            const justDoManual = justDoExternalTrigger === "manual" || justDoExternalTrigger === "user";
            justDoInvocationStore.set(params.sessionId, {
              trigger: justDoManual ? "manual" : "auto",
              reason: String(justDoExternalTrigger).includes("overflow") ? "overflow" : "context_limit",
              phase: justDoManual || params.forcePreflight === true || params.preflightRequired === true || justDoExternalTrigger === "budget"
                ? "pre_turn"
                : "mid_turn"
            });
            try {
              return await activeSession.compact(params.customInstructions);
            } finally {
              justDoInvocationStore.delete(params.sessionId);
            }`,
    `${filePath}: external automatic compaction invocation metadata`,
  );
}

function transformAgentSession(content, filePath) {
  if (content.includes('justDoCodexCompactionDetails')) return content;
  let out = content.replace(
    /(customInstructions,\s*mode: "manual",)/,
    '$1\n        reason: "manual",',
  );
  out = out.replace(/(mode: "auto",\s*)(settings,)/, '$1reason,\n        $2');
  const preparationAnchor = out.includes('const pathEntries = this.sessionManager.getBranch();')
    ? /(const pathEntries = this\.sessionManager\.getBranch\(\);\s*const preparation = [^;]+;)/
    : /(const preparation = [^;]+;)/;
  out = replaceUniquePattern(
    out,
    preparationAnchor,
    `$1
    if (preparation) {
      preparation.justDoCompactionTrigger = options.mode === "manual" ? "manual" : "auto";
      preparation.justDoCompactionReason = options.reason === "overflow" ? "overflow" : "context_limit";
      preparation.justDoCompactionPhase = options.mode === "manual" ? "pre_turn" : "mid_turn";
    }`,
    `${filePath}: default compaction invocation metadata`,
  );
  out = replaceUniquePattern(
    out,
    /(\s*this\.sessionManager\.appendCompaction\()/,
    `
    const justDoCodexCompactionDetails = compactionResult.details?.justdoCompaction;
    if (justDoCodexCompactionDetails?.semantics === "codex-local") {
      compactionResult.details.justdoCompaction = {
        ...justDoCodexCompactionDetails,
        trigger: preparation.justDoCompactionTrigger ?? (options.mode === "manual" ? "manual" : "auto"),
        reason: preparation.justDoCompactionReason ?? (options.reason === "overflow" ? "overflow" : "context_limit"),
        phase: preparation.justDoCompactionPhase ?? "pre_turn"
      };
    }
$1`,
    `${filePath}: authoritative trigger metadata`,
  );
  return out;
}

module.exports = {
  transformAgentSession,
  transformExternalInvocationMetadata,
  transformOverflowLimit,
  transformStrictSafeguardFailures,
  transformStrictSummaryPipeline,
};
