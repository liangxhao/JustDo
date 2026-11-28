import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

import { transformSync } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';

const { TARGETS, OWNERS, NOTICE, transform, verifyCurrent } = require('../../../../scripts/patches/v2026.10.7/048-settled-finalization-output-cutoff.cjs').__testing;
const { functionRange } = require('../../../../scripts/patches/v2026.10.7/prepared-read-patch-shapes.js');
const runtime = process.env.OPENCLAW_PRISTINE_DIR ?? 'vendor/openclaw-runtime/current';
const textOwner = path.join(runtime, TARGETS.text);
const displayOwner = path.join(runtime, TARGETS.display);
const runnerOwner = path.join(runtime, TARGETS.runner);
const required = process.env.OPENCLAW_RUNTIME_CONTRACT_REQUIRED === '1';

async function loadToolCallSanitizer() {
  const source = transform(fs.readFileSync(textOwner, 'utf8'), 'text');
  const resolved = source.replace(/((?:from|import) ")(\.[^"]+)"/gu, (_match: string, prefix: string, target: string) =>
    `${prefix}${pathToFileURL(path.resolve(path.dirname(textOwner), target)).href}"`);
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(resolved).toString('base64')}`;
  return (await import(/* @vite-ignore */ moduleUrl)).f as (text: string) => string;
}

function finalizerCase(outcome: 'answered' | 'empty', cancelBeforeDelivery = false) {
  const scoped = transform(fs.readFileSync(runnerOwner, 'utf8'), 'runner');
  const original = { currentAttemptCompletedAssistant: { stopReason: 'length' }, assistantTexts: [] };
  const finalAssistant = { stopReason: 'stop', text: 'Verified the saved receipt only.' };
  // Exercise the native current assistant fallback when an adapted result omits the completed slot.
  const result = outcome === 'answered'
    ? { currentAttemptAssistant: finalAssistant, assistantTexts: [finalAssistant.text] }
    : { currentAttemptCompletedAssistant: { stopReason: 'stop' }, assistantTexts: [] };
  const run = vi.fn(async () => ({ outcome, attempt: result }));
  const signal = new AbortController();
  const observe = vi.fn(async () => 'missing').mockImplementationOnce(async () => 'missing');
  if (cancelBeforeDelivery) observe.mockImplementationOnce(async () => { signal.abort(); return 'missing'; });
  const fallback = vi.fn();
  const owner = runInNewContext(`async ${functionRange(scoped, OWNERS.finalizer).text}; ${OWNERS.finalizer}`, {
    MAX_EMPTY_SETTLED_FINALIZATION_ATTEMPTS: 2,
    log$3: { warn: vi.fn() },
    observeReplyDelivery: observe,
    prepareEmbeddedRunTerminal: ({ attempt }: { attempt: { assistantTexts: string[] } }) => ({
      replyDeliveryState: 'missing', payloadsWithToolMedia: attempt.assistantTexts.map(text => ({ text })),
    }),
    resolveSettledTurnFinalizationRequest: () => 'Native tool-free instruction.',
    resolveAdmittedRunActiveAssertion: () => vi.fn(),
    resolveSessionWriterDeliveryAuthority: () => undefined,
    isEmbeddedRunTerminalTimeout: () => false,
    classifyAgentRunTerminalOutcome: () => 'success',
    runPreparedSettledTurnFinalization: run,
    mergeUsageIntoAccumulator: vi.fn(),
    mergeAttemptRunStatsIntoAccumulator: vi.fn(),
    buildSettledToolFallbackAttemptResult: fallback,
    buildAgentRunTerminalOutcome: (input: object) => ({ ...input, reason: 'failed' }),
    resolveFinalAssistantVisibleText: (assistant: { text?: string } | undefined) => assistant?.text,
    isSilentReplyText: (text: string) => text === 'NO_REPLY',
    setReplyPayloadMetadata: (payload: object, metadata: object) => ({ ...payload, metadata }),
    markReplyPayloadForSourceSuppressionDelivery: vi.fn(),
  });
  const completion = owner({
    initial: { attempt: original, terminalState: { outcome: { status: 'ok', stopReason: 'length' } } },
    finalization: { preparedAttempt: {}, abortSignal: signal.signal, harness: { finalizeSettledTurn: vi.fn() } },
    terminalBase: { runParams: {}, activeErrorContext: {}, usageAccumulator: {} },
  });
  return { completion, run, fallback, finalAssistant };
}

describe.skipIf(!required && ![textOwner, displayOwner, runnerOwner].every(fs.existsSync))('native settled output cutoff', () => {
  it('removes a standalone transport opener while retaining Markdown code and explanatory text', async () => {
    const sanitize = await loadToolCallSanitizer();
    expect(sanitize(' <tool_call>\n')).toBe('');
    for (const literal of ['`<tool_call>`', '```xml\n<tool_call>\n```', '    <tool_call>', '\t<tool_call>',
      'Use this tag: <tool_call>', '"<tool_call>"']) expect(sanitize(literal)).toBe(literal);
  });

  it('does not certify the unadorned cutoff marker as visible delivery', async () => {
    const sanitize = await loadToolCallSanitizer();
    const source = transform(fs.readFileSync(displayOwner, 'utf8'), 'display');
    const shouldDrop = runInNewContext(`${functionRange(source, OWNERS.display).text}; ${OWNERS.display}`, {
      asOptionalObjectRecord: (value: unknown) => value,
      isProjectedForwardedMessage: () => false,
      resolveAssistantMessagePhase: () => 'final_answer',
      extractAssistantTextForSilentCheck: (message: { content: string }) => message.content,
      isSuppressedControlReplyText: () => false,
      stripToolCallXmlTags: sanitize,
      hasAssistantDisplayableNonTextContent: (message: { image?: boolean }) => message.image === true,
      hasTranscriptMediaFacts: (message: { media?: boolean }) => message.media === true,
    });
    const marker = { role: 'assistant', stopReason: 'length', content: '<tool_call>' };
    expect(shouldDrop(marker)).toBe(true);
    for (const control of [{ stopReason: 'stop' }, { content: '    <tool_call>' },
      { content: 'Already finished: <tool_call>' }, { image: true }, { media: true }]) {
      expect(shouldDrop({ ...marker, ...control })).toBe(false);
    }
    expect(marker.content).toBe('<tool_call>');
  });

  it('uses the settled evidence for one summary without changing the incomplete result to success', async () => {
    const { completion, run, fallback, finalAssistant } = finalizerCase('answered');
    const result = await completion;
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ prompt: expect.stringContaining('what remains unfinished') }));
    expect(fallback).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      finalizationOutcome: 'answered',
      terminalState: { outcome: { status: 'error', stopReason: 'length' } },
      prepared: { payloadsWithToolMedia: [
        { text: finalAssistant.text }, { text: NOTICE, isError: true, isStatusNotice: true, metadata: { hostNotice: true } },
      ] },
    });
  });

  it('keeps the cutoff after two empty summaries and does not publish a success fallback', async () => {
    const { completion, run, fallback } = finalizerCase('empty');
    expect(await completion).toMatchObject({
      finalizationOutcome: 'failed', terminalState: { outcome: { status: 'error', stopReason: 'length' } },
      prepared: { payloadsWithToolMedia: [{ text: NOTICE, isError: true, isStatusNotice: true }] },
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('leaves native cancellation ownership in place if Stop arrives during summary delivery checks', async () => {
    const { completion, fallback } = finalizerCase('answered', true);
    expect(await completion).toMatchObject({ finalizationOutcome: 'failed', prepared: { payloadsWithToolMedia: [] } });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('verifies compiled source and rejects a partial cutoff projection', () => {
    for (const [kind, owner] of [['text', textOwner], ['display', displayOwner], ['runner', runnerOwner]]) {
      const patched = transform(fs.readFileSync(owner, 'utf8'), kind);
      expect(transform(patched, kind)).toBe(patched);
      expect(() => verifyCurrent(transformSync(patched, { format: 'esm', target: 'node24' }).code, kind, false)).not.toThrow();
    }
    const patched = transform(fs.readFileSync(runnerOwner, 'utf8'), 'runner');
    const partial = patched.replace('terminalState: outputLimitTerminal ?? (', 'terminalState: undefined ?? (');
    expect(partial).not.toBe(patched);
    expect(() => transform(partial, 'runner')).toThrow('does not preserve its failed outcome');
    const noAuthoredSummaryGuard = patched.replace('(!cutoffSummary || isSilentReplyText(cutoffSummary))', '!cutoffSummary');
    expect(noAuthoredSummaryGuard).not.toBe(patched);
    expect(() => transform(noAuthoredSummaryGuard, 'runner')).toThrow('does not preserve its failed outcome');
  });
});
