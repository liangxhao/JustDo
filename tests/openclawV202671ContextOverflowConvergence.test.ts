import { expect, test } from 'vitest';

const patch = require('../scripts/patches/v2026.7.1-2/037-context-overflow-convergence.cjs') as {
  transformAttemptLoop: (content: string, filePath: string) => string;
  transformExternalInvocation: (content: string, filePath: string) => string;
  transformSafeguard: (content: string, filePath: string) => string;
  transformLifecycle: (content: string, filePath: string) => string;
  recoveryHelpers: string;
};

test('keeps normal Codex compaction and adds three bounded overflow recovery passes', () => {
  const transformed = patch.transformAttemptLoop(
    `async function run() {
  const justDoCodexOverflowAttemptLimit =
    params.config?.agents?.defaults?.compaction?.justdoCodexLocal === true ? 1 : 3;
  const MAX_OVERFLOW_COMPACTION_ATTEMPTS = justDoCodexOverflowAttemptLimit;
  let overflowCompactionAttempts = 0;
  log$1.warn(\`auto-compaction failed for \${provider}/\${modelId}: \${compactResult.reason ?? "nothing to compact"}\`);
}`,
    'attempt.js',
  );

  expect(transformed).toContain('justdoCodexLocal === true ? 3 : 3');
  expect(transformed).toContain('const justDoRetryCancelledCodexCompaction =');
  expect(transformed).toContain('!params.abortSignal?.aborted');
  expect(transformed).toContain('overflowCompactionAttempts < MAX_OVERFLOW_COMPACTION_ATTEMPTS');
  expect(transformed).toContain('continueFromCurrentTranscript()');

  const markerless = transformed.replace(
    /JUSTDO_CONTEXT_OVERFLOW_CONVERGENCE_V2026_7_1_2_ATTEMPT_LOOP/gu,
    '',
  );
  expect(patch.transformAttemptLoop(markerless, 'attempt.js')).toBe(markerless);
});

test('forwards the outer overflow pass into Codex checkpoint preparation', () => {
  const invocation = patch.transformExternalInvocation(
    `const justDoCodexExternalCompactionInvocationV1 = Symbol.for("justdo.codex-compaction-invocation");
justDoInvocationStore.set(params.sessionId, {
  trigger: justDoManual ? "manual" : "auto",
  reason: String(justDoExternalTrigger).includes("overflow") ? "overflow" : "context_limit",
  phase: justDoManual || params.forcePreflight === true || params.preflightRequired === true || justDoExternalTrigger === "budget"
    ? "pre_turn"
    : "mid_turn"
});`,
    'compact.js',
  );

  expect(invocation).toContain('attempt: Number.isFinite(params.attempt)');
  expect(invocation).toContain('Math.max(1, Math.floor(params.attempt))');
});

test('builds a Unicode-safe recent-user archive within the emergency budget', () => {
  const buildArchive = new Function(
    `${patch.recoveryHelpers}; return buildJustDoOverflowRecoveryArchive;`,
  )() as (
    archive: { messages: Array<{ sourceEntryId: string; text: string }> },
    tokenBudget: number,
  ) => { estimatedTokens: number; messages: Array<{ sourceEntryId: string; text: string }> };
  const archive = buildArchive(
    {
      messages: [
        { sourceEntryId: 'old', text: `旧内容🙂${'甲'.repeat(500)}` },
        { sourceEntryId: 'new', text: `最新请求🚀${'乙'.repeat(500)}` },
      ],
    },
    120,
  );

  expect(archive.estimatedTokens).toBeLessThanOrEqual(120);
  expect(archive.messages.at(-1)?.sourceEntryId).toBe('new');
  expect(archive.messages.at(-1)?.text).toContain('最新请求🚀');
  expect(archive.messages.at(-1)?.text).not.toContain('\uFFFD');
});

test('allows overflow recompaction without new transcript and enforces a smaller handoff', () => {
  const transformed = patch.transformSafeguard(
    `function compactionSafeguardExtension(api) {
  preparation.justDoCompactionPhase = invocation.phase;
  const justDoCodexLocal = justDoRuntime?.justdoCodexLocal === true;
  const previousArchive = latestCompaction?.details?.justdoRetainedUserMessages;
  const previousRetainedUsers = Array.isArray(previousArchive?.messages)
    ? previousArchive.messages
        .filter((record) => record && typeof record.text === "string" && record.text.length > 0)
        .map((record) => ({ role: "user", content: record.text }))
    : [];
  const previousSummaryMessage = [];
  const postCompactionMessages = [];
  if (latestCompactionIndex >= 0 && postCompactionMessages.length === 0) return { cancel: true };
  const customInstructions = resolveCompactionInstructions(eventInstructions, runtime?.customInstructions);
  summary = justDoCodexLocal ? lastHistorySummary || summary : capCompactionSummaryPreservingSuffix(lastHistorySummary || summary, suffix);
  const details = {
    phase: preparation.justDoCompactionPhase ?? "pre_turn",
  };
}`,
    'safeguard.js',
  );

  expect(transformed).toContain('justDoRecompactUnchangedCheckpoint');
  expect(transformed).toContain('buildJustDoOverflowRecoveryArchive');
  expect(transformed).toContain('preparation.justDoRetainedUserMessages ?? previousArchive');
  expect(transformed).toContain('contextWindowTokens * (aggressivePass ? 0.25 : 0.5)');
  expect(transformed).toContain('summary = sliceJustDoOverflowRecoveryText');
  expect(transformed).toContain('overflowRecoveryTargetTokens');
});

test.each(['request_too_large', 'context_window_exceeded', '上下文过长'])(
  'does not publish recoverable %s as a terminal lifecycle error',
  errorMessage => {
    const transformed = patch.transformLifecycle(
      `function classifyFailoverReason(raw) {
  return raw === "rate limit" ? "rate_limit" : "context_overflow";
}
function isAssistantMessage(value) {
  return value?.role === "assistant";
}
function handleAgentEnd(ctx, evt) {
  const lastAssistant = ctx.state.lastAssistant;
  const isError = isAssistantMessage(lastAssistant) && lastAssistant.stopReason === "error";
  const emitLifecycleTerminal = () => {
    ctx.sendTerminal();
  };
  emitLifecycleTerminal();
  return isError;
}`,
      'lifecycle.js',
    );

    expect(transformed).toContain('isJustDoRecoverableContextOverflow');
    expect(transformed).toContain('justdoCodexLocal === true');
    expect(transformed).toContain('if (suppressJustDoOverflowTerminal) return');
    expect(transformed).toContain("=== 'context_overflow'");

    const handleAgentEnd = new Function(`${transformed}; return handleAgentEnd;`)() as (
      ctx: Record<string, unknown>,
      evt: unknown,
    ) => boolean;
    let terminalCount = 0;
    expect(
      handleAgentEnd(
        {
          params: {
            config: { agents: { defaults: { compaction: { justdoCodexLocal: true } } } },
          },
          state: {
            lastAssistant: {
              role: 'assistant',
              stopReason: 'error',
              errorMessage,
              provider: 'test',
            },
          },
          sendTerminal: () => {
            terminalCount += 1;
          },
        },
        {},
      ),
    ).toBe(false);
    expect(terminalCount).toBe(0);
  },
);

test('still publishes non-overflow failures as terminal lifecycle errors', () => {
  const transformed = patch.transformLifecycle(
    `function classifyFailoverReason() { return "rate_limit"; }
function isAssistantMessage(value) { return value?.role === "assistant"; }
function handleAgentEnd(ctx, evt) {
  const lastAssistant = ctx.state.lastAssistant;
  const isError = isAssistantMessage(lastAssistant) && lastAssistant.stopReason === "error";
  const emitLifecycleTerminal = () => { ctx.sendTerminal(); };
  emitLifecycleTerminal();
  return isError;
}`,
    'lifecycle.js',
  );
  const handleAgentEnd = new Function(`${transformed}; return handleAgentEnd;`)() as (
    ctx: Record<string, unknown>,
    evt: unknown,
  ) => boolean;
  let terminalCount = 0;
  const isError = handleAgentEnd(
    {
      params: {
        config: { agents: { defaults: { compaction: { justdoCodexLocal: true } } } },
      },
      state: {
        lastAssistant: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: 'rate limit',
          provider: 'test',
        },
      },
      sendTerminal: () => {
        terminalCount += 1;
      },
    },
    {},
  );
  expect(isError).toBe(true);
  expect(terminalCount).toBe(1);
});
