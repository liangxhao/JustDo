import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';

const patch =
  require('../../../../scripts/patches/v2026.7.1-2/035-codex-local-compaction-semantics.cjs') as {
    transformSchema: (content: string, filePath: string) => string;
    transformRuntimeRegistration: (content: string, filePath: string) => string;
    transformPreflight: (content: string, filePath: string) => string;
    transformMidTurn: (content: string, filePath: string) => string;
    transformStrictSummaryPipeline: (content: string, filePath: string) => string;
    transformStrictSafeguardFailures: (content: string) => string;
    transformSafeguard: (content: string, filePath: string) => string;
    transformExternalInvocationMetadata: (content: string, filePath: string) => string;
    transformAgentSession: (content: string, filePath: string) => string;
    transformOverflowLimit: (content: string, filePath: string) => string;
    verifyPatch: (runtimeDir: string) => void;
  };

describe('OpenClaw v2026.7.1-2 Codex-local compaction semantics', () => {
  test('adds an explicit config flag and propagates it to safeguard runtime', () => {
    const schema = patch.transformSchema(
      `const schema = { mode: z.union([z.literal("default"), z.literal("safeguard")]).optional(),
        reserveTokensFloor: z.number().int().nonnegative().optional() };`,
      'schema.js',
    );
    expect(schema).toContain('justdoCodexLocal: z.boolean().optional()');

    const runtime = patch.transformRuntimeRegistration(
      `setCompactionSafeguardRuntime(params.sessionManager, {
      maxHistoryShare: compactionCfg?.maxHistoryShare,
      contextWindowTokens: 1
    });`,
      'extensions.js',
    );
    expect(runtime).toContain('justdoCodexLocal: compactionCfg?.justdoCodexLocal === true');
  });

  test('uses measured usage at the 90 percent pre-turn boundary', () => {
    const transformed = patch.transformPreflight(
      `function resolveMemoryFlushPlan() {}
const memoryFlushPlan = resolveMemoryFlushPlan({ cfg: params.cfg });
const reserveTokensFloor = memoryFlushPlan?.reserveTokensFloor ?? 20_000;
const threshold = Math.max(
    contextWindowTokens - reserveTokensFloor - softThresholdTokens,
    serverCompactionThreshold ?? 0,
  );
const projectedTokenCount = Math.max(usageProjectedTokenCount ?? 0, freshProjectedTokenCount ?? 0, stalePersistedPromptTokens ?? 0);
const tokenCountForCompaction =
    Number.isFinite(projectedTokenCount) && projectedTokenCount > 0
      ? projectedTokenCount
      : undefined;
const shouldCompact = shouldCompactByTokens || shouldCompactByTranscriptBytes;
const gate = shouldRunPreflightCompaction({
  reserveTokensFloor,
  softThresholdTokens,
  minimumThresholdTokens: serverCompactionThreshold
});`,
      'memory.js',
    );

    expect(transformed).toContain('Math.floor(contextWindowTokens * 0.9)');
    expect(transformed).toContain(
      'freshPersistedTokens ?? transcriptPromptTokens ?? stalePersistedPromptTokens',
    );
    expect(transformed).toContain('!justdoCodexLocalCompactionV1');
    expect(transformed).toContain(
      'minimumThresholdTokens: justdoCodexLocalCompactionV1 ? 0 : serverCompactionThreshold',
    );
  });

  test('uses a 10 percent reserve only for the mid-turn routing check', () => {
    const transformed = patch.transformMidTurn(
      `const midTurnPrecheckEnabled =
        params.config?.agents?.defaults?.compaction?.midTurnPrecheck?.enabled === true;
const options = {
  reserveTokens: () => settingsManager.getCompactionReserveTokens(),
};`,
      'attempt.js',
    );

    expect(transformed).toContain('Math.ceil(contextTokenBudgetForGuard * 0.1)');
    expect(transformed).toContain(
      'justDoCodexMidTurnReserveTokens ?? settingsManager.getCompactionReserveTokens()',
    );
  });

  test('preserves history when all safe staged summary retries fail', () => {
    const transformed = patch.transformStrictSafeguardFailures(
      `async function summarizeViaLLM(params) {
  return compactionSafeguardDeps.summarizeInStages({
    messages: params.messages,
    justDoCompactionSessionId: params.justDoCompactionSessionId
  });
}
const summary = await summarizeViaLLM({
  messages,
  justDoCompactionSessionId,
  headers
});`,
    );

    expect(transformed).toContain(
      'Codex-local compaction summarization exhausted safe staged retries',
    );
    expect(transformed).toContain('codexLocal: justDoCodexLocal');
  });

  test('retries only context overflow after dropping the oldest legal message group', async () => {
    const transformed = patch.transformStrictSafeguardFailures(
      `async function summarizeViaLLM(params) {
  return compactionSafeguardDeps.summarizeInStages({
    messages: params.messages,
    justDoCompactionSessionId: params.justDoCompactionSessionId
  });
}`,
    );
    const calls: Array<Array<{ role: string; content: string }>> = [];
    const summarizeViaLLM = new Function(
      'compactionSafeguardDeps',
      'formatErrorMessage',
      `${transformed}; return summarizeViaLLM;`,
    )(
      {
        summarizeInStages: async (params: {
          messages: Array<{ role: string; content: string }>;
        }) => {
          calls.push(params.messages);
          if (calls.length === 1) throw new Error('context length exceeded');
          return 'summary';
        },
      },
      (error: unknown) => String(error),
    ) as (params: unknown) => Promise<string>;

    await expect(
      summarizeViaLLM({
        codexLocal: true,
        messages: [
          { role: 'user', content: 'old user' },
          { role: 'assistant', content: 'old answer' },
          { role: 'user', content: 'new user' },
          { role: 'assistant', content: 'new answer' },
        ],
      }),
    ).resolves.toBe('summary');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.[0]).toEqual({ role: 'user', content: 'new user' });
  });

  test('does not turn authentication failures into a partial checkpoint summary', async () => {
    const transformed = patch.transformStrictSafeguardFailures(
      `async function summarizeViaLLM(params) {
  return compactionSafeguardDeps.summarizeInStages({
    messages: params.messages,
    justDoCompactionSessionId: params.justDoCompactionSessionId
  });
}`,
    );
    const summarizeInStages = vi.fn(async () => {
      throw new Error('401 unauthorized');
    });
    const summarizeViaLLM = new Function(
      'compactionSafeguardDeps',
      'formatErrorMessage',
      `${transformed}; return summarizeViaLLM;`,
    )({ summarizeInStages }, (error: unknown) => String(error)) as (
      params: unknown,
    ) => Promise<string>;

    await expect(
      summarizeViaLLM({ codexLocal: true, messages: [{ role: 'user', content: 'request' }] }),
    ).rejects.toThrow('401 unauthorized');
    expect(summarizeInStages).toHaveBeenCalledTimes(1);
  });

  test('keeps the Codex prompt during staged merges and rejects partial fallbacks', () => {
    const transformed = patch.transformStrictSummaryPipeline(
      `async function summarizeChunks(params) {
  try { return await run(); } catch (err) {
    if (params.signal.aborted) { throw err; }
    return "partial";
  }
}
async function summarizeWithFallback(params) {
  try { return await summarizeChunks(params); } catch (fullError) {
    if (params.signal.aborted) { throw fullError; }
    log.warn(String(fullError));
  }
}
async function summarizeInStages(params) {
  const custom = params.customInstructions?.trim();
  const mergeInstructions = custom ? \`${'${MERGE_SUMMARIES_INSTRUCTIONS}'}\\n\\n${'${custom}'}\` : MERGE_SUMMARIES_INSTRUCTIONS;
}`,
      'pipeline.js',
    );

    expect(transformed).toContain('if (params.justDoCodexLocal === true) throw err');
    expect(transformed).toContain('if (justDoCodexLocalSummaryPipelineV1) throw fullError');
    expect(transformed).toContain('params.justDoCodexLocal === true ? custom');
  });

  test('bypasses OpenClaw structure, suffix cap and previous-summary duplication', () => {
    const transformed = patch.transformSafeguard(
      `function buildJustDoEmergencyHandoffSummary() {}
function compactionSafeguardExtension(api) {
  api.on("session_before_compact", async (event, ctx) => {
    try {
    const { preparation, customInstructions: eventInstructions, signal } = event;
    const rawTurnPrefixMessages = preparation.turnPrefixMessages ?? [];
    let baseMessagesToSummarize = stripRuntimeContextCustomMessages(preparation.messagesToSummarize);
    let baseTurnPrefixMessages = stripRuntimeContextCustomMessages(rawTurnPrefixMessages);
    let hasRealSummarizable = containsRealConversation(baseMessagesToSummarize);
    let hasRealTurnPrefix = containsRealConversation(baseTurnPrefixMessages);
    setCompactionSafeguardCancelReason(ctx.sessionManager, undefined);
    if (!hasRealSummarizable && !hasRealTurnPrefix) {
      return { compaction: { summary: buildStructuredFallbackSummary() } };
    }
    const runtime = getCompactionSafeguardRuntime(ctx.sessionManager);
    const customInstructions = resolveCompactionInstructions(eventInstructions, runtime?.customInstructions);
    const summarizationInstructions = {};
    const turnPrefixMessages = baseTurnPrefixMessages;
    const recentTurnsPreserve = resolveRecentTurnsPreserve(runtime?.recentTurnsPreserve);
    const structuredInstructions = buildCompactionStructureInstructions(
      customInstructions,
      summarizationInstructions,
    );
    const qualityGuardEnabled = runtime?.qualityGuardEnabled ?? false;
    const tokensBefore = preparation.tokensBefore;
    let droppedSummary;
    if (tokensBefore !== undefined) { droppedSummary = "d"; }
    const effectivePreviousSummary = droppedSummary ?? preparation.previousSummary;
    let summary = "summary";
    const lastHistorySummary = summary;
    const suffix = "suffix";
    const bodyToCap = lastHistorySummary || summary;
    summary = capCompactionSummaryPreservingSuffix(bodyToCap, suffix);
    return {
      compaction: {
        summary,
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        details: { readFiles, modifiedFiles },
      },
    };
  } catch (error) { return { cancel: true }; }
  });
}`,
      'safeguard.js',
    );

    expect(transformed).toContain('preparation.justDoCodexLocal = true');
    expect(transformed).toContain('latestCompactionIndex');
    expect(transformed).toContain('previousArchive?.messages');
    expect(transformed).toContain('branch.slice(latestCompactionIndex + 1)');
    expect(transformed).toContain('justDoCodexSummaryPrefix');
    expect(transformed).toContain('postCompactionMessages.length === 0');
    expect(transformed).toContain('if (justDoCodexLocal) return { cancel: true }');
    expect(transformed).toContain('? undefined');
    expect(transformed).toContain('? undefined');
    expect(transformed).toContain('summary = justDoCodexLocal ? bodyToCap');
    expect(transformed).toContain('semantics: "codex-local"');
    expect(transformed).toContain('justDoCodexTokensAfter');
    expect(transformed).toContain('Codex-local compaction made no safe progress');
  });

  test('records authoritative trigger metadata and limits unchanged-prompt overflow recovery', () => {
    const session = patch.transformAgentSession(
      `class AgentSession {
  async manual(customInstructions) {
    return this.runCompactionWork({
        customInstructions,
        mode: "manual",
        settings,
    });
  }
  async auto(reason) {
    return this.runCompactionWork({
        mode: "auto",
        settings,
    });
  }
  async runCompactionWork(options) {
    let compactionResult = {};
    const preparation = {};
    this.sessionManager.appendCompaction(
      compactionResult.summary
    );
  }
}`,
      'agent-session.js',
    );
    expect(session).toContain('reason: "manual"');
    expect(session).toContain('reason,');
    expect(session).toContain('justDoCodexCompactionDetails');
    expect(session).toContain('options.reason === "overflow"');

    const overflow = patch.transformOverflowLimit(
      `function run() {
      const MAX_OVERFLOW_COMPACTION_ATTEMPTS = 3;
      let overflowCompactionAttempts = 0;
}`,
      'run.js',
    );
    expect(overflow).toContain('? 1 : 3');
  });

  test('propagates the real outer automatic phase through Session.compact', () => {
    const transformed = patch.transformExternalInvocationMetadata(
      `const activeSession = session;
const result = await compactWithSafetyTimeout(() => {
  setCompactionSafeguardCancelReason(compactionSessionManager, void 0);
  return activeSession.compact(params.customInstructions);
}, timeout);`,
      'compact.js',
    );
    expect(transformed).toContain('justDoCodexExternalCompactionInvocationV1');
    expect(transformed).toContain('justDoExternalTrigger === "budget"');
    expect(transformed).toContain('return await activeSession.compact');
  });

  test('requires every Codex-local contract in both dist and gateway bundle', () => {
    const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-codex-local-verify-'));
    const contracts = [
      'justdoCodexLocal: boolean().optional()',
      'justdoCodexLocal: compactionCfg?.justdoCodexLocal === true',
      'const justdoCodexLocalCompactionV1 = Math.floor(contextWindowTokens * 0.9)',
      'justDoCodexMidTurnReserveTokens',
      'justDoCodexLocalSummaryPipelineV1',
      'justDoCodexTokensAfter Codex-local compaction summarization exhausted safe staged retries',
      'justDoCodexExternalCompactionInvocationV1',
      'justDoCodexCompactionDetails',
      'justDoCodexOverflowAttemptLimit',
    ].join('\n');
    try {
      fs.mkdirSync(path.join(runtimeDir, 'dist'));
      fs.writeFileSync(path.join(runtimeDir, 'dist', 'runtime.js'), contracts);
      fs.writeFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), contracts);
      expect(() => patch.verifyPatch(runtimeDir)).not.toThrow();

      fs.writeFileSync(
        path.join(runtimeDir, 'gateway-bundle.mjs'),
        contracts.replace('justDoCodexLocalSummaryPipelineV1', ''),
      );
      expect(() => patch.verifyPatch(runtimeDir)).toThrow(/expected 2/u);
    } finally {
      fs.rmSync(runtimeDir, { recursive: true, force: true });
    }
  });
});
