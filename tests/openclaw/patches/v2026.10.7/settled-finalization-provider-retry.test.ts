import fs from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

const { TARGETS, OWNER, transform, verifyCurrent } = require('../../../../scripts/patches/v2026.10.7/046-settled-finalization-provider-retry.cjs').__testing;
const { transform: transformCutoff } = require('../../../../scripts/patches/v2026.10.7/048-settled-finalization-output-cutoff.cjs').__testing;
const { functionRange } = require('../../../../scripts/patches/v2026.10.7/prepared-read-patch-shapes.js');
const runtime = process.env.OPENCLAW_PRISTINE_DIR ?? 'vendor/openclaw-runtime/current';
const projection = path.join(runtime, TARGETS.projection);
const required = process.env.OPENCLAW_RUNTIME_CONTRACT_REQUIRED === '1';

const baseResult = {
  terminal: { kind: 'ok' },
  toolMetas: [],
  itemLifecycle: { startedCount: 0, activeCount: 0, completedCount: 0 },
  replayMetadata: { replaySafe: true },
  messagingToolSentTexts: [],
  messagingToolSentMediaUrls: [],
  messagingToolSentTargets: [],
};
const transportReceipt = {
  type: 'provider_transport_failure',
  details: { phase: 'before_message_stream_start', eventsEmitted: false },
};

function project(status?: number, retryAfterMs?: number) {
  const source = transform(fs.readFileSync(projection, 'utf8'), 'projection');
  const result = runInNewContext(`${functionRange(source, OWNER.projection).text}; ${OWNER.projection}`, {
    extractFailoverHttpStatus: () => status,
    isRetryableAssistantError: () => true,
    isAuthAssistantError: (message: { errorMessage: string }) => message.errorMessage.includes('invalid API key'),
    isBillingAssistantError: (message: { errorMessage: string }) => message.errorMessage.includes('insufficient quota'),
    isRateLimitAssistantError: () => false,
    resolveRetryAfterMs: () => retryAfterMs,
    assertSettledTurnFinalizationResult: () => { throw new Error('existing native validation'); },
  });
  return (assistant: Record<string, unknown>, options: {
    builtIn?: boolean;
    attempt?: Partial<typeof baseResult>;
  } = {}) => result({
    ...baseResult, ...options.attempt,
    currentAttemptCompletedAssistant: { errorMessage: 'temporary model failure', stopReason: 'error', content: [], ...assistant },
  }, options.builtIn !== false);
}

function runFinalizer(
  outcomes: readonly ('empty' | 'temporary' | 'permanent' | 'answered')[],
  options: { builtIn?: boolean; cutoff?: boolean; delivery?: string } = {},
) {
  let source = transform(fs.readFileSync(path.join(runtime, TARGETS.loop), 'utf8'), 'loop');
  if (options.cutoff) source = transformCutoff(source, 'runner');
  const original = { assistantTexts: [], currentAttemptCompletedAssistant: { stopReason: options.cutoff ? 'length' : 'stop' } };
  const answer = { text: 'Verified the saved tool evidence.', stopReason: 'stop' };
  let index = 0;
  const run = vi.fn(async () => {
    const outcome = outcomes[index++];
    if (outcome === 'temporary') throw new Error('temporary provider failure', {
      cause: { kind: 'settled-finalization-provider-retry', delayMs: 750 },
    });
    if (outcome === 'permanent') throw new Error('invalid API key');
    return outcome === 'answered'
      ? { outcome, attempt: { currentAttemptCompletedAssistant: answer, assistantTexts: [answer.text] } }
      : { outcome, attempt: original };
  });
  const delay = vi.fn(async () => {});
  const fallback = vi.fn(() => original);
  const owner = runInNewContext(`async ${functionRange(source, OWNER.loop).text}; ${OWNER.loop}`, {
    Error,
    MAX_EMPTY_SETTLED_FINALIZATION_ATTEMPTS: 2,
    SETTLED_TOOL_FINALIZATION_FALLBACK_TEXT: 'The tool run finished, but no final summary was produced.',
    log$3: { warn: vi.fn() },
    formatErrorMessage: String,
    observeReplyDelivery: vi.fn(async () => options.delivery ?? 'missing').mockResolvedValueOnce('missing'),
    prepareEmbeddedRunTerminal: ({ attempt, replyDeliveryState }: { attempt: typeof original; replyDeliveryState: string }) => ({
      replyDeliveryState, payloadsWithToolMedia: attempt.assistantTexts.map(text => ({ text })),
    }),
    resolveSettledTurnFinalizationRequest: () => 'Native tool-free instruction.',
    resolveAdmittedRunActiveAssertion: () => vi.fn(),
    resolveSessionWriterDeliveryAuthority: () => undefined,
    isEmbeddedRunTerminalTimeout: () => false,
    isBuiltInOpenClawAgentHarness: () => options.builtIn !== false,
    classifyAgentRunTerminalOutcome: () => 'success',
    runPreparedSettledTurnFinalization: run,
    sleepWithAbort: delay,
    resolveSourceReplyDelivery: (_: unknown, state: string) => state,
    mergeUsageIntoAccumulator: vi.fn(),
    mergeAttemptRunStatsIntoAccumulator: vi.fn(),
    buildSettledToolFallbackAttemptResult: fallback,
    persistSettledToolFallbackTranscript: async () => undefined,
    resolveEmbeddedRunAttemptTerminalOutcome: () => ({ status: 'ok' }),
    buildAgentRunTerminalOutcome: (outcome: object) => outcome,
    resolveFinalAssistantVisibleText: (assistant?: { text?: string }) => assistant?.text,
    isSilentReplyText: () => false,
    isReplyPayloadTerminalContent: () => true,
    setReplyPayloadMetadata: (payload: object) => payload,
    markReplyPayloadForSourceSuppressionDelivery: vi.fn(),
  });
  const completion = owner({
    initial: { attempt: original, terminalState: { outcome: { status: 'ok', stopReason: original.currentAttemptCompletedAssistant.stopReason } } },
    finalization: { preparedAttempt: {}, abortSignal: new AbortController().signal, harness: { finalizeSettledTurn: vi.fn() } },
    terminalBase: { runParams: {}, activeErrorContext: {}, usageAccumulator: {} },
  });
  return { completion, run, delay, fallback, answer };
}

describe.skipIf(!required && !fs.existsSync(projection))('native tool-free finalizer provider recovery', () => {
  it('retains a retry receipt for temporary provider failures before output', () => {
    for (const operation of [
      () => project(503, 1_000)({}),
      () => project()({ diagnostics: [transportReceipt] }),
    ]) {
      let evidence: unknown;
      try { operation(); } catch (error) { evidence = (error as Error).cause; }
      expect(evidence).toMatchObject({ kind: 'settled-finalization-provider-retry', delayMs: expect.any(Number) });
    }
  });

  it('preserves delivery, scope, provider and timeout guards', () => {
    expect(() => project(503)({}, { builtIn: false })).toThrow('existing native validation');
    expect(() => project(503, 30_000)({})).toThrow('existing native validation');
    expect(() => project(429)({})).toThrow('existing native validation');
    expect(() => project(503)({ errorMessage: '503 invalid API key' })).toThrow('existing native validation');
    expect(() => project(503)({ content: [{ type: 'text', text: 'partial result' }] })).toThrow('existing native validation');
    expect(() => project()({ diagnostics: [{ ...transportReceipt, details: { eventsEmitted: true } }] }))
      .toThrow('existing native validation');
    expect(() => project(503)({}, { attempt: { terminal: { kind: 'aborted' } } }))
      .toThrow('did not complete successfully');
    expect(() => project(503)({}, { attempt: { toolMetas: [{}] } })).toThrow('reported capability activity');
  });

  it('shares one initial request and three retries across empty and temporary results', async () => {
    const f = runFinalizer(['temporary', 'empty', 'temporary', 'answered']);
    expect(await f.completion).toMatchObject({ finalizationOutcome: 'answered' });
    expect(f.run).toHaveBeenCalledTimes(4);
    expect(f.delay).toHaveBeenCalledTimes(2);
    expect(f.fallback).not.toHaveBeenCalled();
  });

  it('preserves the cutoff after four empty results and never sends a fifth request', async () => {
    const f = runFinalizer(['empty', 'empty', 'empty', 'empty', 'answered'], { cutoff: true });
    expect(await f.completion).toMatchObject({
      finalizationOutcome: 'failed', terminalState: { outcome: { status: 'error', stopReason: 'length' } },
    });
    expect(f.run).toHaveBeenCalledTimes(4);
    expect(f.fallback).not.toHaveBeenCalled();
  });

  it('keeps the custom empty limit and does not repeat a permanent provider failure', async () => {
    const custom = runFinalizer(['empty', 'empty', 'answered'], { builtIn: false });
    const permanent = runFinalizer(['permanent', 'answered']);
    await Promise.all([custom.completion, permanent.completion]);
    expect(custom.run).toHaveBeenCalledTimes(2);
    expect(permanent.run).toHaveBeenCalledOnce();
  });

  it.each(['empty', 'temporary'] as const)('stops retrying when delivery appears after a %s result', async outcome => {
    const f = runFinalizer([outcome, 'answered'], { delivery: 'delivered' });
    expect(await f.completion).toMatchObject({ finalizationOutcome: 'failed', prepared: { replyDeliveryState: 'delivered' } });
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.fallback).not.toHaveBeenCalled();
  });

  it('keeps each locked source transformation idempotent', () => {
    for (const [kind, target] of Object.entries(TARGETS) as [string, string][]) {
      const source = fs.readFileSync(path.join(runtime, target), 'utf8');
      const patched = transform(source, kind);
      expect(transform(patched, kind)).toBe(patched);
    }
  });

  it('follows the native reply projection binding when bundling renames it', () => {
    const source = transform(fs.readFileSync(path.join(runtime, TARGETS.loop), 'utf8'), 'loop');
    const { start, end, text } = functionRange(source, OWNER.loop);
    const renamed = source.slice(0, start) + text.replace(/\bprepared\b/gu, 'prepared2') + source.slice(end);
    expect(() => verifyCurrent(renamed, 'loop')).not.toThrow();
    expect(() => verifyCurrent(renamed.replace('prepared2 = { ...prepared2, replyDeliveryState:', 'other = { ...prepared2, replyDeliveryState:'), 'loop'))
      .toThrow('isolated finalization retry owner changed');
  });
});
