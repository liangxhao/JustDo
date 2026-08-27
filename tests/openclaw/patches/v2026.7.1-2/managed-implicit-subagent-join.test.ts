import { describe, expect, test } from 'vitest';

type RunEntry = {
  runId?: string;
  childSessionKey?: string;
  requesterSessionKey?: string;
  controllerSessionKey?: string;
  cleanup?: 'keep' | 'delete';
  expectsCompletionMessage?: boolean;
  startedAt?: number;
  endedAt?: number;
  outcome?: { status?: string; error?: string };
  completion?: { required?: boolean; resultText?: string; capturedAt?: number };
  delivery?: {
    status?: string;
    justDoManagedJoin?: {
      state?: string;
      controllerSessionKey?: string;
    };
  };
};

const implicitJoinPatch =
  require('../../../../scripts/patches/v2026.7.1-2/041-managed-implicit-subagent-join.cjs') as {
    __testing: {
      selectJustDoImplicitJoinRuns: (
        entries: RunEntry[],
        controllerSessionKey: string,
      ) => RunEntry[];
      partitionJustDoImplicitJoinResults: (entries: RunEntry[], controllerSessionKey: string) => {
        completed: RunEntry[];
        pending: number;
      };
      reconcileJustDoImplicitJoinRuns: (
        expectedByChildSessionKey: Map<string, string>,
        entries: RunEntry[],
        controllerSessionKey: string,
      ) => {
        currentRuns: RunEntry[];
        replacements: Array<{ childSessionKey: string; previousRunId: string; runId: string }>;
        missingRunIds: string[];
      };
      buildJustDoImplicitJoinPrompt: (
        entries: RunEntry[],
        pending: number,
        maxChars?: number,
      ) => { prompt: string; entries: RunEntry[]; pending: number };
      isJustDoImplicitJoinCommitState: (state?: string) => boolean;
    };
  };
const terminalGuardPatch =
  require('../../../../scripts/patches/v2026.7.1-2/042-required-subagent-terminal-guard.cjs') as {
    __testing: {
      shouldAttemptJustDoImplicitJoin: (params: {
        hasSessionKey?: boolean;
        alreadyRevising?: boolean;
        willRetry?: boolean;
        isError?: boolean;
        incompleteTerminalAssistant?: boolean;
        aborted?: boolean;
        promptError?: boolean;
        timedOut?: boolean;
        hasCompletedClientToolCall?: boolean;
        yieldDetected?: boolean;
        completionDeliveryRun?: boolean;
      }) => boolean;
      isJustDoSubagentCompletionDeliveryRun: (inputProvenance?: {
        kind?: string;
        sourceTool?: string;
      }) => boolean;
      transformAttempt: (content: string, filePath: string) => string;
      transformRunner: (content: string, filePath: string) => string;
      transformDelivery: (content: string, filePath: string) => string;
      transformAnnounce: (content: string, filePath: string) => string;
      transformAssistantObservation: (content: string, filePath: string) => string;
    };
  };

describe('managed implicit subagent join capability', () => {
  test('selects only required undelivered children and resumes owned implicit waiters', () => {
    const required: RunEntry = {
      runId: 'required',
      childSessionKey: 'agent:main:subagent:required',
      requesterSessionKey: 'agent:main:justdo:parent',
      expectsCompletionMessage: true,
      completion: { required: true },
      delivery: { status: 'pending' },
    };
    const fireAndForget: RunEntry = {
      runId: 'optional',
      childSessionKey: 'agent:main:subagent:optional',
      requesterSessionKey: 'agent:main:justdo:parent',
      expectsCompletionMessage: false,
      completion: { required: false },
      delivery: { status: 'not_required' },
    };
    const resumed: RunEntry = {
      runId: 'resumed',
      childSessionKey: 'agent:main:subagent:resumed',
      requesterSessionKey: 'agent:main:justdo:parent',
      expectsCompletionMessage: false,
      delivery: {
        status: 'not_required',
        justDoManagedJoin: {
          state: 'implicit_waiting',
          controllerSessionKey: 'agent:main:justdo:parent',
        },
      },
    };
    const foreignWaiter: RunEntry = {
      runId: 'foreign',
      requesterSessionKey: 'agent:main:justdo:other',
      delivery: {
        justDoManagedJoin: {
          state: 'implicit_waiting',
          controllerSessionKey: 'agent:main:justdo:other',
        },
      },
    };
    const delivered: RunEntry = {
      runId: 'delivered',
      requesterSessionKey: 'agent:main:justdo:parent',
      expectsCompletionMessage: true,
      delivery: { status: 'delivered' },
    };

    expect(
      implicitJoinPatch.__testing.selectJustDoImplicitJoinRuns(
        [required, fireAndForget, resumed, foreignWaiter, delivered],
        'agent:main:justdo:parent',
      ),
    ).toEqual([required, resumed]);
  });

  test('assigns an automatic completion obligation only to the exact requester', () => {
    const shared: RunEntry = {
      runId: 'shared',
      childSessionKey: 'agent:main:subagent:shared',
      requesterSessionKey: 'agent:main:justdo:requester',
      controllerSessionKey: 'agent:main:justdo:controller',
      expectsCompletionMessage: true,
      completion: { required: true },
      delivery: { status: 'pending' },
    };

    expect(
      implicitJoinPatch.__testing.selectJustDoImplicitJoinRuns(
        [shared],
        'agent:main:justdo:controller',
      ),
    ).toEqual([]);
    expect(
      implicitJoinPatch.__testing.selectJustDoImplicitJoinRuns(
        [shared],
        'agent:main:justdo:requester',
      ),
    ).toEqual([shared]);
  });

  test('rejects a run whose implicit ownership changes during reconciliation', () => {
    const stolen: RunEntry = {
      runId: 'run-1',
      childSessionKey: 'child-1',
      requesterSessionKey: 'agent:main:justdo:parent',
      delivery: {
        justDoManagedJoin: {
          state: 'implicit_waiting',
          controllerSessionKey: 'agent:main:justdo:other',
        },
      },
    };

    expect(
      implicitJoinPatch.__testing.reconcileJustDoImplicitJoinRuns(
        new Map([['child-1', 'run-1']]),
        [stolen],
        'agent:main:justdo:parent',
      ),
    ).toEqual({ currentRuns: [], replacements: [], missingRunIds: ['run-1'] });
  });

  test('treats failed children as completed results once their completion is captured', () => {
    const failed: RunEntry = {
      runId: 'failed',
      childSessionKey: 'agent:main:subagent:failed',
      requesterSessionKey: 'agent:main:justdo:parent',
      endedAt: 20,
      outcome: { status: 'error', error: 'boom' },
      completion: { resultText: 'child failed', capturedAt: 21 },
      delivery: {
        justDoManagedJoin: {
          state: 'implicit_waiting',
          controllerSessionKey: 'agent:main:justdo:parent',
        },
      },
    };
    const running: RunEntry = {
      runId: 'running',
      requesterSessionKey: 'agent:main:justdo:parent',
      delivery: {
        justDoManagedJoin: {
          state: 'implicit_waiting',
          controllerSessionKey: 'agent:main:justdo:parent',
        },
      },
    };

    expect(
      implicitJoinPatch.__testing.partitionJustDoImplicitJoinResults(
        [failed, running],
        'agent:main:justdo:parent',
      ),
    ).toEqual({ completed: [failed], pending: 1 });
    const batch = implicitJoinPatch.__testing.buildJustDoImplicitJoinPrompt([failed], 1);
    expect(batch.prompt).toContain('"status":"error"');
    expect(batch.prompt).toContain('"error":"boom"');
    expect(batch.entries).toEqual([failed]);
    expect(batch.pending).toBe(1);
  });

  test('bounds runtime result context while preserving continuation instructions', () => {
    const large: RunEntry = {
      runId: 'large',
      childSessionKey: 'agent:main:subagent:large',
      endedAt: 20,
      completion: { resultText: 'x'.repeat(50_000), capturedAt: 21 },
      delivery: { justDoManagedJoin: { state: 'implicit_waiting' } },
    };

    const { prompt, entries } = implicitJoinPatch.__testing.buildJustDoImplicitJoinPrompt(
      [large],
      0,
      2_000,
    );
    expect(prompt.length).toBeLessThanOrEqual(2_000);
    expect(prompt).toContain('required subagent completion batch');
    expect(prompt).toContain('Continue the parent task');
    expect(prompt).toContain('"truncated":true');
    expect(entries).toEqual([large]);
  });

  test('shares a bounded prompt across every result instead of dropping later siblings', () => {
    const entries = ['first', 'second'].map(runId => ({
      runId,
      childSessionKey: `agent:main:subagent:${runId}`,
      endedAt: 20,
      completion: { resultText: runId.repeat(20_000), capturedAt: 21 },
      delivery: { justDoManagedJoin: { state: 'implicit_waiting' } },
    }));

    const batch = implicitJoinPatch.__testing.buildJustDoImplicitJoinPrompt(entries, 0, 2_000);
    const { prompt } = batch;
    expect(prompt.length).toBeLessThanOrEqual(2_000);
    expect(prompt).toContain('"runId":"first"');
    expect(prompt).toContain('"runId":"second"');
    expect(prompt.match(/"truncated":true/g)).toHaveLength(2);
    expect(batch.entries).toEqual(entries);
    expect(batch.pending).toBe(0);
  });

  test('never marks oversized metadata as presented unless its record entered the prompt', () => {
    const entries = ['first', 'second'].map(runId => ({
      runId: runId.repeat(2_000),
      childSessionKey: `agent:main:subagent:${runId.repeat(2_000)}`,
      endedAt: 20,
      outcome: { status: runId.repeat(2_000), error: runId.repeat(2_000) },
      completion: { capturedAt: 21 },
      delivery: { justDoManagedJoin: { state: 'implicit_waiting' } },
    }));

    const batch = implicitJoinPatch.__testing.buildJustDoImplicitJoinPrompt(entries, 0, 2_000);
    expect(batch.prompt.length).toBeLessThanOrEqual(2_000);
    expect(batch.entries).toEqual(entries);
    expect(batch.pending).toBe(0);
    expect(batch.prompt.match(/"truncated":true/g)).toHaveLength(2);
  });

  test('keeps the seventeenth completed sibling pending for the next presentation batch', () => {
    const entries = Array.from({ length: 16 }, (_, index) => ({
      runId: `run-${index}`,
      childSessionKey: `child-${index}`,
      endedAt: 20,
      completion: { resultText: `result-${index}`, capturedAt: 21 },
    }));

    const batch = implicitJoinPatch.__testing.buildJustDoImplicitJoinPrompt(entries, 1);
    expect(batch.entries).toEqual(entries);
    expect(batch.pending).toBe(1);
  });

  test('guards only a real terminal candidate and includes silent replies', () => {
    const shouldAttempt = terminalGuardPatch.__testing.shouldAttemptJustDoImplicitJoin;

    expect(shouldAttempt({ hasSessionKey: true })).toBe(true);
    for (const excluded of [
      'alreadyRevising',
      'willRetry',
      'isError',
      'incompleteTerminalAssistant',
      'aborted',
      'promptError',
      'timedOut',
      'hasCompletedClientToolCall',
      'yieldDetected',
      'completionDeliveryRun',
    ] as const) {
      expect(shouldAttempt({ hasSessionKey: true, [excluded]: true })).toBe(false);
    }
    expect(shouldAttempt({ hasSessionKey: false })).toBe(false);
  });

  test('does not recursively join the child already carried by a native completion run', () => {
    const isCompletionRun =
      terminalGuardPatch.__testing.isJustDoSubagentCompletionDeliveryRun;

    expect(
      isCompletionRun({ kind: 'inter_session', sourceTool: 'subagent_announce' }),
    ).toBe(true);
    expect(
      isCompletionRun({ kind: 'inter_session', sourceTool: ' SUBAGENT_ANNOUNCE ' }),
    ).toBe(true);
    expect(isCompletionRun({ kind: 'inter_session', sourceTool: 'sessions_send' })).toBe(
      false,
    );
    expect(isCompletionRun({ kind: 'user', sourceTool: 'subagent_announce' })).toBe(false);
  });

  test('consumes implicit results only after a later assistant continuation commits', () => {
    const isCommitState = implicitJoinPatch.__testing.isJustDoImplicitJoinCommitState;
    expect(isCommitState('tool_result_committed')).toBe(true);
    expect(isCommitState('implicit_presented')).toBe(true);
    expect(isCommitState('implicit_waiting')).toBe(false);
    expect(isCommitState('presented')).toBe(false);
  });

  test('intercepts silent terminal candidates before the optional finalize hook', () => {
    const fixture = `async function runAttempt() {
  let beforeAgentFinalizeRevisionReason;
  const onBeforeTerminalDelivery = hookRunner?.hasHooks("before_agent_finalize") ? async (event) => {
    if (beforeAgentFinalizeRevisionReason || event.willRetry || event.isError || event.incompleteTerminalAssistant || !event.hasAssistantVisibleText) return;
    const lastAssistant = event.lastAssistant;
    const lastAssistantMessage = "NO_REPLY";
    if (!lastAssistantMessage) return;
    const hasCompletedClientToolCall = clientToolCallSlots.some((slot) => slot.completed);
    const silentFinalReply = params.silentExpected && isSilentReplyText(lastAssistantMessage, "NO_REPLY");
    if (aborted || promptError || timedOut || hasCompletedClientToolCall || yieldDetected || silentFinalReply) return;
    const outcome = await runAgentHarnessBeforeAgentFinalizeHook({ hookRunner });
    if (outcome.action !== "revise") return;
    beforeAgentFinalizeRevisionReason = outcome.reason;
    return { suppressTerminalDelivery: true };
  } : void 0;
  const subscription = subscribeEmbeddedAgentSession(buildEmbeddedSubscriptionParams({
    onBeforeTerminalDelivery,
    blockReplyBreak: params.blockReplyBreak
  }));
  let toolMetasForTerminal = [];
}`;

    const transformed = terminalGuardPatch.__testing.transformAttempt(fixture, 'attempt.js');
    expect(transformed).toContain(
      'hasBeforeAgentFinalizeHook || hasJustDoManagedTerminalGuard ? async (event) =>',
    );
    expect(transformed).toContain('isManagedSession?.(params.sessionKey)');
    expect(transformed).toContain('waitForRequiredChildren?.({');
    expect(transformed.indexOf('waitForRequiredChildren?.({')).toBeLessThan(
      transformed.indexOf('!event.hasAssistantVisibleText'),
    );
    expect(transformed).toContain(
      'JUSTDO_MANAGED_IMPLICIT_JOIN_REVISION_PREFIX + implicitJoin.prompt',
    );
    expect(transformed).toContain(
      'liveAssistantObservationDuringTerminalGuard: hasJustDoManagedTerminalGuard',
    );
    expect(terminalGuardPatch.__testing.transformAttempt(transformed, 'attempt.js')).toBe(
      transformed,
    );
  });

  test('streams managed assistant observations while terminal delivery stays deferred', () => {
    const fixture = `function createHarness(params, state, emitAgentEvent) {
  const emitAssistantStreamDataSafely = (delivery) => {
    const { data } = delivery;
    emitAgentEvent({ runId: params.runId, stream: "assistant", data });
    params.onAgentEvent?.({ stream: "assistant", data });
    if (delivery.emitPartialReply && params.onPartialReply && state.shouldEmitPartialReplies) params.onPartialReply(data);
  };
  const emitAssistantStreamData = (data, options) => {
    const delivery = { data, emitPartialReply: options?.emitPartialReply === true };
    if (state.deferBlockReplyDelivery) {
      state.deferredAssistantEvents.push(delivery);
      return;
    }
    emitAssistantStreamDataSafely(delivery);
  };
  const flushDeferredAssistantEvents = () => {
    if (state.deferredAssistantEvents.length === 0) return;
    const deferred = state.deferredAssistantEvents.splice(0);
    for (const delivery of deferred) emitAssistantStreamDataSafely(delivery);
  };
  const clearDeferredAssistantEvents = () => {
    state.deferredAssistantEvents.length = 0;
  };
  const deferredToolMediaReplies = new WeakSet();
  return { emitAssistantStreamData, flushDeferredAssistantEvents, clearDeferredAssistantEvents };
}`;
    const transformed = terminalGuardPatch.__testing.transformAssistantObservation(
      fixture,
      'stream.js',
    );
    const createHarness = new Function(`${transformed}; return createHarness;`)() as (
      params: Record<string, unknown>,
      state: Record<string, unknown>,
      emitAgentEvent: (event: unknown) => void,
    ) => {
      emitAssistantStreamData: (data: unknown, options: { emitPartialReply: boolean }) => void;
      flushDeferredAssistantEvents: () => void;
      clearDeferredAssistantEvents: () => void;
    };
    const gatewayEvents: unknown[] = [];
    const observerEvents: unknown[] = [];
    const partialReplies: unknown[] = [];
    const state = {
      deferBlockReplyDelivery: true,
      deferredAssistantEvents: [],
      shouldEmitPartialReplies: true,
    };
    const harness = createHarness(
      {
        runId: 'run-1',
        liveAssistantObservationDuringTerminalGuard: true,
        onAgentEvent: (event: unknown) => observerEvents.push(event),
        onPartialReply: (data: unknown) => partialReplies.push(data),
      },
      state,
      event => gatewayEvents.push(event),
    );

    harness.emitAssistantStreamData({ text: 'live' }, { emitPartialReply: true });
    expect(gatewayEvents).toHaveLength(1);
    expect(observerEvents).toHaveLength(1);
    expect(partialReplies).toHaveLength(0);
    expect(state.deferredAssistantEvents).toHaveLength(1);
    const observation = (
      (gatewayEvents[0] as { data: Record<string, unknown> }).data
        .justdoTerminalGuardObservation as { token: string; action: string }
    );
    expect(observation).toMatchObject({ action: 'update' });
    expect(observation.token).toEqual(expect.any(String));

    harness.flushDeferredAssistantEvents();
    expect(gatewayEvents).toHaveLength(2);
    expect(observerEvents).toHaveLength(2);
    expect(gatewayEvents[1]).toMatchObject({
      stream: 'assistant',
      data: {
        justdoTerminalGuardObservation: { token: observation.token, action: 'commit' },
      },
    });
    expect(partialReplies).toEqual([{ text: 'live' }]);

    const rollbackGatewayEvents: unknown[] = [];
    const rollbackObserverEvents: unknown[] = [];
    const rollbackState = {
      deferBlockReplyDelivery: true,
      deferredAssistantEvents: [],
      shouldEmitPartialReplies: true,
    };
    const rollbackHarness = createHarness(
      {
        runId: 'run-rollback',
        liveAssistantObservationDuringTerminalGuard: true,
        onAgentEvent: (event: unknown) => rollbackObserverEvents.push(event),
      },
      rollbackState,
      event => rollbackGatewayEvents.push(event),
    );
    rollbackHarness.emitAssistantStreamData(
      { text: 'rejected candidate' },
      { emitPartialReply: false },
    );
    const rollbackObservation = (
      (rollbackGatewayEvents[0] as { data: Record<string, unknown> }).data
        .justdoTerminalGuardObservation as { token: string; action: string }
    );
    rollbackHarness.clearDeferredAssistantEvents();
    expect(rollbackGatewayEvents).toHaveLength(2);
    expect(rollbackObserverEvents).toHaveLength(2);
    expect(rollbackGatewayEvents[1]).toMatchObject({
      stream: 'assistant',
      data: {
        justdoTerminalGuardObservation: {
          token: rollbackObservation.token,
          action: 'rollback',
        },
      },
    });
    expect(rollbackState.deferredAssistantEvents).toHaveLength(0);

    const deferredGatewayEvents: unknown[] = [];
    const deferredObserverEvents: unknown[] = [];
    const deferredPartialReplies: unknown[] = [];
    const deferredState = {
      deferBlockReplyDelivery: true,
      deferredAssistantEvents: [],
      shouldEmitPartialReplies: true,
    };
    const deferredHarness = createHarness(
      {
        runId: 'run-2',
        liveAssistantObservationDuringTerminalGuard: false,
        onAgentEvent: (event: unknown) => deferredObserverEvents.push(event),
        onPartialReply: (data: unknown) => deferredPartialReplies.push(data),
      },
      deferredState,
      event => deferredGatewayEvents.push(event),
    );
    deferredHarness.emitAssistantStreamData({ text: 'guarded' }, { emitPartialReply: true });
    expect(deferredGatewayEvents).toHaveLength(0);
    expect(deferredObserverEvents).toHaveLength(0);
    expect(deferredPartialReplies).toHaveLength(0);
    deferredHarness.flushDeferredAssistantEvents();
    expect(deferredGatewayEvents).toHaveLength(1);
    expect(deferredObserverEvents).toHaveLength(1);
    expect(deferredPartialReplies).toEqual([{ text: 'guarded' }]);

    expect(
      terminalGuardPatch.__testing.transformAssistantObservation(transformed, 'stream.js'),
    ).toBe(transformed);
    const bundledWithoutMarker = transformed.replace(
      ' // JUSTDO_LIVE_ASSISTANT_OBSERVATION_DURING_TERMINAL_GUARD_V2026_7_1_2',
      '',
    );
    const normalizedBundle = terminalGuardPatch.__testing.transformAssistantObservation(
      bundledWithoutMarker,
      'gateway-bundle.mjs',
    );
    expect(normalizedBundle).toBe(transformed);
    expect(normalizedBundle.match(/const liveAssistantObservationToken =/g)).toHaveLength(1);
    expect(() =>
      terminalGuardPatch.__testing.transformAssistantObservation(
        normalizedBundle.replace(
          'const liveAssistantObservationToken =',
          'const liveAssistantObservationToken = duplicate;\n  const liveAssistantObservationToken =',
        ),
        'duplicate-bundle.mjs',
      ),
    ).toThrow(/declaration counts are token=2/i);
  });

  test('continues a silent implicit join without spending the plugin revision budget', () => {
    const fixture = `const BEFORE_AGENT_FINALIZE_RETRY_PROMPT_PREFIX = "Before accepting the previous final answer, apply this revision request and produce the revised final answer. Do not repeat completed work or rerun tools unless the request explicitly requires it.";
async function run() {
  try {
  const beforeAgentFinalizeRevisionReason = attempt.beforeAgentFinalizeRevisionReason;
  const shouldHonorBeforeAgentFinalizeRevision = !aborted && !promptError && !timedOut && !attempt.clientToolCalls && !attempt.yieldDetected && !emptyAssistantReplyIsSilent;
  if (beforeAgentFinalizeRevisionReason && shouldHonorBeforeAgentFinalizeRevision) {
    beforeAgentFinalizeRevisionAttempts += 1;
    nextAttemptPromptOverride = buildBeforeAgentFinalizeRetryPrompt(beforeAgentFinalizeRevisionReason);
    suppressNextUserMessagePersistence = true;
    reasoningOnlyRetryInstruction = null;
    emptyResponseRetryInstruction = null;
    compactionContinuationRetryInstruction = null;
    log$1.warn(\`before_agent_finalize requested one more pass: runId=\${params.runId} sessionId=\${params.sessionId} attempt=\${beforeAgentFinalizeRevisionAttempts}/\${MAX_BEFORE_AGENT_FINALIZE_REVISIONS}\`);
    continue;
  }
  } finally {
    if (params.isFinalFallbackAttempt !== false) await cleanup();
  }
}`;

    const transformed = terminalGuardPatch.__testing.transformRunner(fixture, 'runner.js');
    expect(transformed).toContain(
      'isJustDoManagedImplicitJoinRevision || !emptyAssistantReplyIsSilent',
    );
    expect(transformed).toContain(
      'if (isJustDoManagedImplicitJoinRevision) nextAttemptPromptOverride',
    );
    expect(transformed.indexOf('if (isJustDoManagedImplicitJoinRevision)')).toBeLessThan(
      transformed.indexOf('beforeAgentFinalizeRevisionAttempts += 1'),
    );
    expect(transformed).toContain(
      'restoreImplicitDelivery?.(params.sessionKey, params.runId)',
    );
    expect(terminalGuardPatch.__testing.transformRunner(transformed, 'runner.js')).toBe(
      transformed,
    );
  });

  test('rechecks durable ownership after native announce waited for the requester', () => {
    const deliveryFixture = `async function sendSubagentAnnounceDirectly(params) {
\t\tconst sourceToolId = normalizeOptionalLowercaseString(params.sourceTool) ?? "subagent_announce";
\t\tconst isSubagentCompletion = sourceToolId === "subagent_announce";
\t\tlet requesterActivity = resolveRequesterSessionActivity(canonicalRequesterSessionKey);
\t\tif (params.expectsCompletionMessage && isSubagentCompletion && requesterActivity.sessionId && requesterActivity.isActive) {
\t\t\tconst requesterEnded = await waitForEmbeddedAgentRunEnd(requesterActivity.sessionId, announceTimeoutMs);
\t\t\tif (!requesterEnded) return { delivered: false, path: "none", reason: "requester_busy" };
\t\t}
\t\tif (params.expectsCompletionMessage && subagentAnnounceDeliveryDeps.isRequesterSessionAbandoned(canonicalRequesterSessionKey, requesterActivity.sessionId)) return {
\t\t\tdelivered: false,
\t\t\tpath: "none"
\t\t};
}`;
    const announceFixture = `async function runSubagentAnnounceFlow(params) {
  let shouldDeleteChildSession = true;
  const delivery = await deliverSubagentAnnouncement(params);
  params.onDeliveryResult?.(delivery);
  didAnnounce = delivery.delivered || delivery.terminal === true;
}`;

    const transformedDelivery = terminalGuardPatch.__testing.transformDelivery(
      deliveryFixture,
      'delivery.js',
    );
    const transformedAnnounce = terminalGuardPatch.__testing.transformAnnounce(
      announceFixture,
      'announce.js',
    );
    expect(transformedDelivery).toContain(
      'ownsCompletion?.(canonicalRequesterSessionKey, params.sourceSessionKey)',
    );
    expect(transformedDelivery.indexOf('reason: "managed_join_owned"')).toBeGreaterThan(
      transformedDelivery.indexOf('waitForEmbeddedAgentRunEnd'),
    );
    expect(transformedAnnounce).toContain('delivery.reason === "managed_join_owned"');
    expect(transformedAnnounce).toContain('shouldDeleteChildSession = false;');
    expect(
      terminalGuardPatch.__testing.transformDelivery(transformedDelivery, 'delivery.js'),
    ).toBe(transformedDelivery);
    expect(
      terminalGuardPatch.__testing.transformAnnounce(transformedAnnounce, 'announce.js'),
    ).toBe(transformedAnnounce);
  });
});
