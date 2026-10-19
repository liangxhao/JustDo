/* eslint-disable @typescript-eslint/no-explicit-any -- Native VM fixtures exercise the locked JavaScript runtime's heterogeneous internal records. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

import { beforeAll, describe, expect, it, vi } from 'vitest';

const patch = require('../../../../scripts/patches/v2026.10.4/030-tool-call-format-recovery.cjs');
const { extractFunction } = patch.__testing;
const root = path.resolve(__dirname, '../../../..');
const dist = path.join(
  process.env.OPENCLAW_PRISTINE_DIR ?? path.join(root, 'vendor/openclaw-runtime/current'),
  'dist',
);
const nativeFile =
  fs.existsSync(dist) &&
  fs
    .readdirSync(dist)
    .find(
      name =>
        /^embedded-agent-.*\.mjs$/.test(name) &&
        fs
          .readFileSync(path.join(dist, name), 'utf8')
          .includes('function runPreparedEmbeddedLoop('),
    );
const nativeSource = nativeFile ? fs.readFileSync(path.join(dist, nativeFile), 'utf8') : '';
let policy: any;
let facts: any;
let loop: any;
beforeAll(async () => {
  loop = await import(pathToFileURL(path.join(root, 'openclaw-extensions/runtime-services/tool-call-recovery/loop.mjs')).href);
  policy = await import(
    pathToFileURL(
      path.join(root, 'openclaw-extensions/runtime-services/tool-call-recovery/policy.mjs'),
    ).href
  );
  facts = await import(
    pathToFileURL(
      path.join(root, 'openclaw-extensions/runtime-services/tool-call-recovery/facts.mjs'),
    ).href
  );
});

const failure = (text = '') => ({
  role: 'assistant',
  stopReason: 'error',
  errorCode: 'malformed_tool_call_arguments',
  errorMessage: 'Provider returned an incomplete or malformed tool call',
  content: text
    ? [{ type: 'text', text, textSignature: JSON.stringify({ v: 1, phase: 'commentary' }) }]
    : [],
  diagnostics: [
    {
      type: 'tool_call_pre_dispatch_rejection',
      timestamp: 1,
      details: { batchRejected: true, streamComplete: true, dispatchCount: 0 },
    },
  ],
});
function attempt(assistant = failure(), extras = {}) {
  return {
    currentAttemptAssistant: assistant,
    currentAttemptCompletedAssistant: assistant,
    messagesSnapshot: [{ role: 'user', content: 'inspect' }, assistant],
    toolMetas: [],
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    didSendViaMessagingTool: false,
    assistantTexts: [],
    replayMetadata: { replaySafe: true, hadPotentialSideEffects: false },
    terminal: { kind: 'ok' },
    ...extras,
  };
}

function harness(responses: any[], stage: string | null = 'initial', options: any = {}) {
  const signal = new AbortController();
  const recordedStops = new WeakSet();
  const event = vi.fn(options.onEvent);
  const decisions = vi.fn();
  const prompts: string[] = [];
  const session = {
    sessionId: 'native-session',
    sessionFile: 'native.jsonl',
    sessionTarget: {},
    activePrompt: { persisted: true },
    withSessionWriterContext: (fn: any) => fn(),
    markOwnedTranscriptRetry: vi.fn(),
    activateInternalPrompt: (text: string) => {
      prompts.push(text);
    },
    continueFromCurrentTranscript: vi.fn(),
    clearCompactionContinuation: vi.fn(),
  };
  const snapshot = {
    agentHarness: {},
    effectiveModel: { id: 'model', provider: 'provider', api: options.modelApi ?? 'openai-completions' },
    outerContextTokenMeta: {},
    pluginHarnessOwnsTransport: options.pluginHarnessOwnsTransport ?? false,
    providerRuntimeHandle: {},
    activePreparedAuthPlan: {},
  };
  const runtime = {
    provider: 'provider',
    modelId: 'model',
    admittedRunContext: {},
    model: { id: 'model', api: 'openai-completions' },
    profileCandidates: ['profile'],
    attemptedThinking: new Set(),
    snapshot: () => snapshot,
    setThinkLevel: vi.fn(),
    getApiKeyInfo: () => ({}),
  };
  const review = {
    admit: vi.fn(),
    beginAttempt: vi.fn(),
    settle: vi.fn(),
    failure: vi.fn(),
    finish: (result: any) => result,
  };
  const failover = {
    observeAttempt: vi.fn(),
    recoverThrownHarnessAuthFailure: vi.fn(),
    maybeMarkAuthProfileFailure: vi.fn(),
  };
  let cursor = 0;
  const replayInputs: any[] = [];
  const dispatch = vi.fn(async (input: any) => {
    replayInputs.push({ ...input.replayState });
    let effects = false;
    while (true) {
      const response = responses[cursor++];
      if (response instanceof Error || typeof response === 'string') throw response;
      if (!response) throw new Error('Unexpected extra model request');
      effects ||= response.replayMetadata.hadPotentialSideEffects;
      const feedback = await input.runInput.runParams.toolCallRecovery?.(response.currentAttemptCompletedAssistant, {
        model: snapshot.effectiveModel, executedCount: 0, committedCount: 0, batchCount: 0, aborted: false,
      });
      if (feedback) { prompts.push(feedback.content); continue; }
      response.replayMetadata.hadPotentialSideEffects = effects;
      return { dispatchedAttempt: { rawAttempt: response, preparedAttempt: {} }, runtimePlan: {} };
    }
  });
  const recover = vi.fn(async (input: any) =>
    input.normalizedAttempt.attempt.terminal.source === 'hook:before_agent_run'
      ? { action: 'complete', result: { meta: { error: { kind: 'hook_block' } } } }
      : { action: 'proceed' },
  );
  const assistantFailure = vi.fn(async () => {
    throw new Error('Generic assistant retry must be exclusive');
  });
  const terminal = vi.fn(options.terminal ?? (async (input: any) => ({
    action: 'complete',
    result: {
      meta: {
        error:
          input.attemptAssistant?.stopReason === 'error'
            ? { kind: 'incomplete_turn', fallbackSafe: false }
            : undefined,
      },
    },
  })));
  const settle = vi.fn(() => {
    if (options.settleError) throw options.settleError;
  });
  const context: any = {
    ...policy,
    ...facts,
    ...loop,
    Error,
    Date,
    Boolean,
    String,
    OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST: 'native',
    log: { error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    measureEmbeddedAgentPreparation: (_name: any, fn: any) => fn(),
    withClaimingHookAdmission: (hookContext: any) => hookContext,
    prepareEmbeddedRunRuntime: async () => runtime,
    getAdmittedRunDelegatedAuthority: () => ({}),
    resolveAdmittedRunActiveAssertion: () => () => signal.signal.throwIfAborted(),
    resolveSessionAgentIds: () => ({ sessionAgentId: 'agent' }),
    isStrictAgenticExecutionContractActive: () => false,
    resolveMaxRunRetryIterations: () => options.maxAttempts ?? 100,
    createRunRetryBudget: (maxAttempts: number) => ({
      attemptsCounted: 0,
      attemptsDispatched: 0,
      maxAttempts,
    }),
    beginRunAttempt: (budget: any) => {
      budget.attemptsCounted++;
      budget.attemptsDispatched++;
    },
    isRunRetryBudgetExhausted: (budget: any) => budget.attemptsCounted >= budget.maxAttempts,
    recordRunRetry: vi.fn(),
    createEmbeddedRunContextRecoveryState: () => ({ restoreTimeoutRecoveryAbandonment: vi.fn() }),
    createUsageAccumulator: () => ({}),
    createEmbeddedRunTerminalRetryState: () => ({}),
    resolveToolLoopDetectionConfig: () => ({}),
    createPostCompactionLoopGuard: () => ({ observe: () => ({}), armPostCompaction: vi.fn() }),
    createTerminalToolPresentationTracker: () => ({
      observe: vi.fn(),
      read: () => undefined,
      allocateOrdinal: () => 0,
    }),
    createAgentTurnTaintState: () => ({ observe: vi.fn(), isTainted: () => false }),
    createEmbeddedRunSessionPromptState: async () => session,
    createProviderReviewRun: () => review,
    createEmbeddedRunPermissionChanges: () => ({
      forAttempt: () => ({}),
      prepareRestart: () => false,
      close: vi.fn(),
    }),
    createEmbeddedRunFailoverRetryController: () => failover,
    admitEmbeddedContextEngine: async () => ({
      contextEngine: { info: {} },
      contextEngineLogicalTurnLease: {},
    }),
    createEmbeddedRunCompactionRuntime: () => ({}),
    createEmbeddedRunReplayState: () => ({ replayInvalid: false, hadPotentialSideEffects: false }),
    createAttemptCarryover: () => ({ apply: vi.fn() }),
    prepareAndDispatchEmbeddedRunAttempt: dispatch,
    hasCodexAppServerRecoveryRetryBudget: () => false,
    normalizeEmbeddedRunAttempt: async (input: any) => {
      const raw = input.dispatchedAttempt.rawAttempt;
      return {
        action: raw.normalizedAction ?? 'proceed',
        retryKind: 'recovery',
        attempt: raw,
        sessionIdUsed: 'native-session',
        bootstrapPromptWarningSignaturesSeen: ['kept'],
        lastRunPromptUsage: { output: 7 },
        replayState: {
          ...input.replayState,
          hadPotentialSideEffects:
            input.replayState.hadPotentialSideEffects || raw.replayMetadata.hadPotentialSideEffects,
        },
        currentAttemptAssistant: raw.currentAttemptAssistant,
        currentAttemptCompletedAssistant: raw.currentAttemptCompletedAssistant,
        attemptAssistant: raw.currentAttemptCompletedAssistant,
        terminalState: { outcome: { status: 'failed' }, signalOwnedInterruption: false },
        resolveReplayInvalidForAttempt: () => false,
        setTerminalLifecycleMeta: vi.fn(),
        activeErrorContext: {},
      };
    },
    isEmbeddedRunTerminalInterrupted: () => false,
    recoverEmbeddedRunAttempt: recover,
    handleEmbeddedAssistantFailure: assistantFailure,
    prepareTerminalWithSettledTurnFinalization: async (input: any) => {
      expect(input.toolCallRecoveryHandled).toBe(true);
      return {
        ...input.initial,
        prepared: { agentMeta: {}, reportedModelRef: {} },
        finalizationOutcome: 'not-attempted',
      };
    },
    resolveEmbeddedRunTerminalTimeout: () => undefined,
    resolveEmbeddedRunTerminal: terminal,
    emitAgentEvent: event,
    emitDiagnosticsTimelineEvent: decisions,
    settleEmbeddedRun: settle,
    recordModelFallbackStop: (error: Error) => recordedStops.add(error),
    resolveRunFailoverDecision: vi.fn(),
    handleRetryLimitExhaustion: vi.fn(),
  };
  context.log$3 = context.log;
  const part = extractFunction(nativeSource, 'runPreparedEmbeddedLoop');
  const code = patch.__testing.transformRunner('async ' + part.body, 'native-loop-fixture.mjs');
  patch.__testing.transformRunner(code, 'native-loop-fixture.mjs', { verifyOnly: true });
  const run = vm.runInNewContext(code + '; runPreparedEmbeddedLoop', context);
  const refresh = { applyDeliveryState: (raw: any) => raw, continueAfterAttempt: vi.fn() };
  const input = {
    runParams: {
      runId: 'native-run',
      sessionId: 'native-session',
      modelRoutingProvenance: stage ? { stage } : undefined,
    },
    provider: 'provider',
    modelId: 'model',
    startedAtMs: 1,
    preReplyGeneration: options.preReplyGeneration,
    startupStages: { mark: vi.fn() },
    progressController: { notifyExecutionPhase: vi.fn() },
    onInitialWriterPrepared: vi.fn(),
    laneController: {
      abortSignal: signal.signal,
      throwIfAborted: () => signal.signal.throwIfAborted(),
    },
  };
  return {
    run: () => run(refresh, input),
    dispatch,
    recover,
    assistantFailure,
    terminal,
    event,
    prompts,
    session,
    settle,
    failover,
    recordedStops,
    refresh,
    replayInputs,
    decisions,
    signal,
  };
}

describe.skipIf(!nativeFile)('format recovery through the locked native runner', () => {
  it('rejects a partial patch that stops consuming the format budget', () => {
    const part = extractFunction(nativeSource, 'runPreparedEmbeddedLoop');
    const patched = patch.__testing.transformRunner(
      'async ' + part.body,
      'native-loop-fixture.mjs',
    );
    const changed = patched.replace(
      'beginRunAttempt(runRetryBudget); },',
      'beginRunAttempt({}); },',
    );
    expect(changed).not.toBe(patched);
    expect(() =>
      patch.__testing.transformRunner(changed, 'native-loop-fixture.mjs', { verifyOnly: true }),
    ).toThrow(/partial/);
  });

  it('adds exactly two requests and bypasses other retry families on exhaustion', async () => {
    const h = harness([attempt(), attempt(), attempt(), attempt()]);
    const result = await h.run();
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.prompts).toHaveLength(2);
    expect(h.decisions.mock.calls.map(([value]) => value.attributes.detail)).toEqual([
      'retry',
      'retry',
      'budget_exhausted',
    ]);
    expect(h.event.mock.calls.map(([value]) => value.data.retryAttempt)).toEqual([1, 2]);
    expect(h.recover).not.toHaveBeenCalled();
    expect(h.assistantFailure).not.toHaveBeenCalled();
    expect(h.refresh.continueAfterAttempt).not.toHaveBeenCalled();
    expect(h.terminal.mock.calls[0][0].toolCallRecoveryHandled).toBe(true);
    expect(result.meta.error.fallbackSafe).toBe(false);
    expect(h.settle).toHaveBeenCalledTimes(1);
  });

  it('preserves settled writes and their cumulative replay metadata', async () => {
    const assistant = failure('Inspecting the remaining files.');
    const write = {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'write-1', name: 'write' }],
    };
    const result = { role: 'toolResult', toolCallId: 'write-1', toolName: 'write', content: [] };
    const raw = attempt(assistant, {
      messagesSnapshot: [{ role: 'user', content: 'inspect' }, write, result, assistant],
      toolMetas: [{ toolName: 'write', toolCallId: 'write-1', replaySafe: false }],
      itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
      replayMetadata: { replaySafe: false, hadPotentialSideEffects: true },
    });
    const h = harness([
      raw,
      attempt({
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Done' }],
      } as any),
    ]);
    await h.run();
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.terminal.mock.calls[0][0].attempt.replayMetadata.hadPotentialSideEffects).toBe(true);
    expect(h.prompts[0]).toContain('Previously displayed commentary is preserved');
    expect(h.session.markOwnedTranscriptRetry).not.toHaveBeenCalled();
  });

  it('passes only this completed attempt feedback into the actual internal prompt seam', async () => {
    const completed = failure();
    Object.assign(completed.diagnostics[0].details, { feedback: { version: 1, batchCallCount: 3,
      issues: [{ callIndex: 1, kind: 'invalid_json', detail: 'xml_like_input', argumentChars: 9 }],
      omitted: false, localization: 'located' } });
    const current = structuredClone(completed);
    Object.assign(current.diagnostics[0].details, { feedback: { version: 1, batchCallCount: 1,
      issues: [{ callIndex: 0, kind: 'non_object_arguments', argumentChars: 2 }], omitted: false, localization: 'located' } });
    const h = harness([attempt(completed, { currentAttemptAssistant: current }),
      attempt({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Done' }] } as any)]);
    await h.run();
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain('Call 2: invalid JSON (XML-like input; use a JSON object)');
    expect(h.prompts[0]).toContain('all 3 calls were withheld, including valid siblings');
    expect(h.prompts[0]).not.toContain('Call 1: arguments must');
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.session.markOwnedTranscriptRetry).not.toHaveBeenCalled();
  });

  it('continues a current response after earlier native schema errors without restarting the attempt', async () => {
    const h = harness([attempt(failure(), { lastToolError: { toolName: 'swarm_workflow_verify', errorKind: 'argument-validation' } }),
      attempt({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Done' }] } as any)]);
    await h.run();
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.prompts).toHaveLength(1);
    expect(h.session.markOwnedTranscriptRetry).not.toHaveBeenCalled();
  });

  it.each([new Error('network failed'), 'transport failed'])(
    'stops fallback and auth rotation after a claimed chain throws',
    async error => {
      const h = harness([attempt(), error]);
      const thrown = await h.run().catch((value: any) => value);
      expect(h.recordedStops.has(thrown)).toBe(true);
      if (error instanceof Error) expect(thrown).toBe(error);
      else expect(thrown.cause).toBe(error);
      expect(h.failover.recoverThrownHarnessAuthFailure).not.toHaveBeenCalled();
      expect(h.dispatch).toHaveBeenCalledTimes(1);
      expect(h.settle).toHaveBeenCalledTimes(1);
    },
  );

  it('retains the admission cancellation check after progress callbacks', async () => {
    let h: ReturnType<typeof harness>;
    h = harness([attempt(), attempt()], 'initial', {
      onEvent: () => h.signal.abort(new Error('Stopped')),
    });
    await expect(h.run()).rejects.toThrow('Stopped');
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.settle).toHaveBeenCalledTimes(1);
  });

  it('transfers the native pre-reply generation once before format continuations', async () => {
    const generation = { assertCurrent: vi.fn(), release: vi.fn() };
    const h = harness([attempt(), attempt(), attempt()], 'initial', {
      preReplyGeneration: generation,
    });
    await h.run();
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(generation.assertCurrent).toHaveBeenCalledTimes(1);
    expect(generation.release).toHaveBeenCalledTimes(1);
    expect(generation.assertCurrent.mock.invocationCallOrder[0]).toBeLessThan(
      generation.release.mock.invocationCallOrder[0],
    );
    expect(generation.release.mock.invocationCallOrder[0]).toBeLessThan(
      h.dispatch.mock.invocationCallOrder[0],
    );
  });

  it('rejects an expired pre-reply generation before dispatch', async () => {
    const generation = {
      assertCurrent: vi.fn(() => {
        throw new Error('Native generation expired');
      }),
      release: vi.fn(),
    };
    const h = harness([attempt()], 'initial', { preReplyGeneration: generation });
    await expect(h.run()).rejects.toThrow('Native generation expired');
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(generation.release).not.toHaveBeenCalled();
    expect(h.settle).toHaveBeenCalledTimes(1);
  });

  it('stops fallback when the native finally cleanup fails after format recovery', async () => {
    const error = new Error('Native cleanup failed');
    const answer = attempt({
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'text', text: 'Done' }],
    } as any);
    const h = harness([attempt(), answer], 'initial', { settleError: error });
    const thrown = await h.run().catch((value: any) => value);
    expect(thrown).toBe(error);
    expect(h.recordedStops.has(thrown)).toBe(true);
    expect(h.settle).toHaveBeenCalledTimes(1);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it('honors the native total retry budget even before the format budget is spent', async () => {
    const h = harness([attempt(), attempt()], 'initial', { maxAttempts: 1 });
    const result = await h.run();
    expect(result.meta.error.kind).toBe('incomplete_turn');
    expect(h.decisions.mock.calls[0][0].attributes.detail).toBe('run_budget_exhausted');
    expect(h.event).not.toHaveBeenCalled();
    expect(h.prompts).toHaveLength(0);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it('settles a finalize-rejected answer after one format correction without delivering or retrying it', async () => {
    const draft = 'I have started the requested Team.';
    const assistant = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: draft }] };
    const completion = vi.fn(async (input: any) => ({ action: 'complete', result: { ...input, meta: {} } }));
    const terminalSource = patch.__testing.transformRunner(
      `async ${extractFunction(nativeSource, 'resolveEmbeddedRunTerminal').body}`,
      'native-rejected-draft-fixture.mjs',
    );
    const resolve = vm.runInNewContext(`${terminalSource}; resolveEmbeddedRunTerminal`, {
      projectAgentRunAttemptTerminal: () => ({}),
      isEmbeddedRunTerminalAbort: () => false, isEmbeddedRunTerminalTimeout: () => false,
      isEmbeddedRunTerminalInterrupted: () => false, resolveSilentToolResultReplyPayload: () => undefined,
      resolveSettledToolBatchEvidence: () => ({ intentionalTermination: false }),
      shouldTreatEmptyAssistantReplyAsSilent: () => false, resolveReplyExpectation: () => 'required',
      resolveSourceReplyDelivery: () => 'missing', resolveIncompleteTurnPayloadText: () => null,
      completeEmbeddedRun: completion,
    });
    const h = harness([
      attempt(),
      attempt(assistant as any, { beforeAgentFinalizeRevisionReason: 'The requested Team has not been started.' }),
      attempt(),
    ], 'initial', {
      terminal: (input: any) => resolve({
        ...input, payloadsWithToolMedia: [{ text: draft }],
        finalAssistantVisibleText: draft, finalAssistantRawText: draft,
      }),
    });

    const result = await h.run();

    expect(completion).toHaveBeenCalledTimes(1);
    expect(result.payloadsForTerminalPath).toBeUndefined();
    expect(result.finalAssistantVisibleText).toBeUndefined();
    expect(result.finalAssistantRawText).toBeUndefined();
    expect(result.incompleteTurnText).toContain('finalization hook');
    expect(result.incompleteTurnFallbackSafe).toBe(false);
    expect(result.meta.modelFallbackStopReason).toBe('tool_call_format_recovery');
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.prompts).toHaveLength(1);
    expect(h.event.mock.calls.map(([value]) => value.data.retryAttempt)).toEqual([1]);
    expect(h.recover).not.toHaveBeenCalled();
    expect(h.assistantFailure).not.toHaveBeenCalled();
    expect(h.refresh.continueAfterAttempt).not.toHaveBeenCalled();
    expect(h.settle).toHaveBeenCalledTimes(1);
  });

  it.each([null, 'fallback'])('requires native initial-candidate provenance (%s)', async stage => {
    const h = harness([attempt()], stage);
    await expect(h.run()).rejects.toThrow('Generic assistant retry');
    expect(h.prompts).toHaveLength(0);
    expect(h.recover).toHaveBeenCalledTimes(1);
  });

  it('keeps the two-request format budget across native compaction continuations', async () => {
    const progress = () =>
      attempt({ role: 'assistant', stopReason: 'stop', content: [] } as any, {
        normalizedAction: 'retry',
      });
    const h = harness([attempt(), progress(), attempt(), progress(), attempt()]);
    await h.run();
    expect(h.dispatch).toHaveBeenCalledTimes(3);
    expect(h.prompts).toHaveLength(2);
    expect(h.event.mock.calls.map(([value]) => value.data.retryAttempt)).toEqual([1, 2]);
    expect(h.assistantFailure).not.toHaveBeenCalled();
  });

  it.each([{ pluginHarnessOwnsTransport: true }, { modelApi: 'openai-responses' }])(
    'preserves the existing recovery owner for unsupported transport %j',
    async options => {
      const h = harness([attempt()], 'initial', options);
      await expect(h.run()).rejects.toThrow('Generic assistant retry');
      expect(h.prompts).toHaveLength(0);
      expect(h.recover).toHaveBeenCalledTimes(1);
    },
  );


});
