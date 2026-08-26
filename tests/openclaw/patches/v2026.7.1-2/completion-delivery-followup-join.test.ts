import { describe, expect, test } from 'vitest';

type RunEntry = {
  runId?: string;
  childSessionKey?: string;
  requesterSessionKey?: string;
  cleanup?: 'keep' | 'delete';
  cleanupHandled?: boolean;
  cleanupCompletedAt?: number;
  expectsCompletionMessage?: boolean;
  endedAt?: number;
  completion?: { required?: boolean; resultText?: string; capturedAt?: number };
  delivery?: {
    status?: string;
    justDoManagedJoin?: {
      state?: string;
      controllerSessionKey?: string;
      startedAt?: number;
      originalCleanup?: 'keep' | 'delete';
      originalExpectsCompletionMessage?: boolean;
    };
  };
};

const patch =
  require('../../../../scripts/patches/v2026.7.1-2/043-completion-delivery-followup-join.cjs') as {
    __testing: {
      resolveJustDoCompletionSourceSessionKey: (inputProvenance?: {
        kind?: string;
        sourceTool?: string;
        sourceSessionKey?: string;
      }) => string | undefined;
      resolveJustDoCompletionFollowupJoin: (
        entries: RunEntry[],
        controllerSessionKey: string,
        completionSourceSessionKey?: string,
        registeredRuns?: Iterable<RunEntry>,
      ) => {
        kind: 'ordinary' | 'malformed' | 'descendant_wake' | 'direct_completion';
        entries: RunEntry[];
      };
      transformTools: (content: string, filePath: string) => string;
      transformAttempt: (content: string, filePath: string) => string;
    };
  };
const implicitJoinPatch =
  require('../../../../scripts/patches/v2026.7.1-2/041-managed-implicit-subagent-join.cjs') as {
    __testing: {
      selectJustDoImplicitJoinRuns: (
        entries: RunEntry[],
        controllerSessionKey: string,
      ) => RunEntry[];
      partitionJustDoImplicitJoinResults: (
        entries: RunEntry[],
        controllerSessionKey: string,
      ) => { completed: RunEntry[]; pending: number };
      isJustDoImplicitJoinCommitState: (state?: string) => boolean;
    };
  };
const recoveryPatch =
  require('../../../../scripts/patches/v2026.7.1-2/020-managed-join-recovery.cjs') as {
    __testing: {
      restoreJustDoManagedJoinEntry: (entry: RunEntry) => boolean;
    };
  };

describe('completion-delivery follow-up subagent join capability', () => {
  test('identifies only a well-formed subagent completion source', () => {
    const resolveSource = patch.__testing.resolveJustDoCompletionSourceSessionKey;

    expect(
      resolveSource({
        kind: 'inter_session',
        sourceTool: ' SUBAGENT_ANNOUNCE ',
        sourceSessionKey: ' agent:main:subagent:source ',
      }),
    ).toBe('agent:main:subagent:source');
    expect(
      resolveSource({ kind: 'inter_session', sourceTool: 'subagent_announce' }),
    ).toBe('');
    expect(
      resolveSource({
        kind: 'inter_session',
        sourceTool: 'sessions_send',
        sourceSessionKey: 'agent:main:subagent:source',
      }),
    ).toBeUndefined();
  });

  test('correlates direct completion, ordinary and synthetic descendant-wake runs', () => {
    const controller = 'agent:main:justdo:parent';
    const source: RunEntry = {
      runId: 'source',
      childSessionKey: 'agent:main:subagent:source',
      requesterSessionKey: controller,
      expectsCompletionMessage: true,
      completion: { required: true },
      delivery: { status: 'pending' },
    };
    const followup: RunEntry = {
      runId: 'followup',
      childSessionKey: 'agent:main:subagent:followup',
      requesterSessionKey: controller,
      expectsCompletionMessage: true,
      completion: { required: true },
      delivery: { status: 'pending' },
    };
    const selected = implicitJoinPatch.__testing.selectJustDoImplicitJoinRuns(
      [source, followup],
      controller,
    );
    const resolveJoin = patch.__testing.resolveJustDoCompletionFollowupJoin;

    expect(resolveJoin(selected, controller, ' agent:main:subagent:source ')).toEqual({
      kind: 'direct_completion',
      entries: [followup],
    });
    expect(resolveJoin(selected, controller, undefined)).toEqual({
      kind: 'ordinary',
      entries: selected,
    });
    const subagentController = 'agent:main:subagent:worker';
    const descendant: RunEntry = {
      ...followup,
      requesterSessionKey: subagentController,
    };
    const parentRegistration: RunEntry = {
      runId: 'worker-run',
      childSessionKey: subagentController,
      requesterSessionKey: controller,
    };
    expect(
      resolveJoin(
        [descendant],
        subagentController,
        subagentController,
        [parentRegistration],
      ),
    ).toEqual({
      kind: 'descendant_wake',
      entries: [descendant],
    });
  });

  test('fails closed for empty, unknown, stale or foreign completion sources', () => {
    const controller = 'agent:main:justdo:parent';
    const eligible: RunEntry = {
      runId: 'eligible',
      childSessionKey: 'agent:main:subagent:eligible',
      requesterSessionKey: controller,
      expectsCompletionMessage: true,
      completion: { required: true },
      delivery: { status: 'pending' },
    };
    const foreign: RunEntry = {
      ...eligible,
      childSessionKey: 'agent:main:subagent:foreign',
      requesterSessionKey: 'agent:main:justdo:other',
    };
    const stale: RunEntry = {
      ...eligible,
      childSessionKey: 'agent:main:subagent:stale',
      delivery: { status: 'delivered' },
    };
    const resolveJoin = patch.__testing.resolveJustDoCompletionFollowupJoin;

    for (const [entries, source] of [
      [[eligible], ''],
      [[eligible], 'agent:main:subagent:unknown'],
      [[eligible, stale], 'agent:main:subagent:stale'],
      [[eligible, foreign], 'agent:main:subagent:foreign'],
    ] as const) {
      expect(resolveJoin([...entries], controller, source)).toEqual({
        kind: 'malformed',
        entries: [],
      });
    }
    expect(resolveJoin([eligible], controller, controller, [])).toEqual({
      kind: 'malformed',
      entries: [],
    });
    expect(
      resolveJoin([eligible], controller, controller, [
        {
          runId: 'self-owned-root',
          childSessionKey: controller,
          requesterSessionKey: controller,
        },
      ]),
    ).toEqual({ kind: 'malformed', entries: [] });
  });

  test('filters the completion source after required-child selection', () => {
    const fixture = `function selectJustDoImplicitJoinRuns(entries, controllerSessionKey) {
  return entries;
}
async function waitForJustDoRequiredSubagentsAtTerminalCore(params) {
\tconst controllerSessionKey = params.controllerSessionKey;
\tconst visibleRuns = selectJustDoImplicitJoinRuns(listControlledSubagentRuns(controllerSessionKey), controllerSessionKey);
}`;

    const transformed = patch.__testing.transformTools(fixture, 'tools.js');
    expect(transformed).toContain('function resolveJustDoCompletionFollowupJoin(');
    expect(transformed).toContain(
      'const selectedRuns = selectJustDoImplicitJoinRuns(listControlledSubagentRuns(controllerSessionKey), controllerSessionKey);',
    );
    expect(transformed).toContain('const visibleRuns = completionFollowupJoin.entries;');
    expect(transformed).toContain('subagentRuns.values()');
    expect(patch.__testing.transformTools(transformed, 'tools.js')).toBe(transformed);
  });

  test('allows a valid completion run to join follow-up children without rejoining its source', () => {
    const fixture = `async function runAttempt() {
  let beforeAgentFinalizeRevisionReason;
  const onBeforeTerminalDelivery = async (event) => {
    const hasCompletedClientToolCall = clientToolCallSlots.some((slot) => slot.completed);
    if (shouldAttemptJustDoImplicitJoin({
      hasSessionKey: true,
      completionDeliveryRun: isJustDoSubagentCompletionDeliveryRun(params.inputProvenance)
    })) {
      const implicitJoin = await waitForRequiredChildren({
        controllerSessionKey: params.sessionKey,
        sessionId: params.sessionId,
        runId: params.runId,
        abortSignal: runAbortController.signal
      });
    }
  };
}`;

    const transformed = patch.__testing.transformAttempt(fixture, 'attempt.js');
    expect(transformed).toContain('function resolveJustDoCompletionSourceSessionKey(');
    expect(transformed).toContain(
      'const completionSourceSessionKey = resolveJustDoCompletionSourceSessionKey(params.inputProvenance);',
    );
    expect(transformed).toContain('completionDeliveryRun: completionSourceSessionKey === ""');
    expect(transformed).toContain(
      'excludedChildSessionKey: completionSourceSessionKey,',
    );
    expect(patch.__testing.transformAttempt(transformed, 'attempt.js')).toBe(transformed);
  });

  test('keeps source native while only the follow-up crosses join, commit and abort states', () => {
    const controller = 'agent:main:justdo:parent';
    const source: RunEntry = {
      runId: 'source-run',
      childSessionKey: 'agent:main:subagent:source',
      requesterSessionKey: controller,
      cleanup: 'delete',
      expectsCompletionMessage: true,
      endedAt: 10,
      completion: { required: true, resultText: 'source result', capturedAt: 11 },
      delivery: { status: 'pending' },
    };
    const followup: RunEntry = {
      runId: 'followup-run',
      childSessionKey: 'agent:main:subagent:followup',
      requesterSessionKey: controller,
      cleanup: 'delete',
      expectsCompletionMessage: true,
      completion: { required: true },
      delivery: { status: 'pending' },
    };
    const sourceBefore = structuredClone(source);
    const selected = implicitJoinPatch.__testing.selectJustDoImplicitJoinRuns(
      [source, followup],
      controller,
    );
    const plan = patch.__testing.resolveJustDoCompletionFollowupJoin(
      selected,
      controller,
      source.childSessionKey,
    );

    expect(plan).toEqual({ kind: 'direct_completion', entries: [followup] });
    for (const entry of plan.entries) {
      entry.delivery = {
        ...entry.delivery,
        status: 'not_required',
        justDoManagedJoin: {
          state: 'implicit_waiting',
          controllerSessionKey: controller,
          startedAt: 20,
          originalCleanup: entry.cleanup,
          originalExpectsCompletionMessage: entry.expectsCompletionMessage,
        },
      };
      entry.expectsCompletionMessage = false;
      entry.completion = { ...entry.completion, required: false };
      entry.cleanup = 'keep';
    }
    expect(source).toEqual(sourceBefore);
    expect(followup.delivery?.justDoManagedJoin?.state).toBe('implicit_waiting');

    followup.endedAt = 30;
    followup.completion = { ...followup.completion, resultText: 'follow-up result', capturedAt: 31 };
    expect(
      implicitJoinPatch.__testing.partitionJustDoImplicitJoinResults(
        plan.entries,
        controller,
      ),
    ).toEqual({ completed: [followup], pending: 0 });
    if (followup.delivery?.justDoManagedJoin)
      followup.delivery.justDoManagedJoin.state = 'implicit_presented';
    expect(
      implicitJoinPatch.__testing.isJustDoImplicitJoinCommitState(
        followup.delivery?.justDoManagedJoin?.state,
      ),
    ).toBe(true);
    expect(
      implicitJoinPatch.__testing.isJustDoImplicitJoinCommitState(
        source.delivery?.justDoManagedJoin?.state,
      ),
    ).toBe(false);
    expect(source).toEqual(sourceBefore);

    if (followup.delivery?.justDoManagedJoin)
      followup.delivery.justDoManagedJoin.state = 'implicit_waiting';
    expect(recoveryPatch.__testing.restoreJustDoManagedJoinEntry(followup)).toBe(true);
    expect(followup).toMatchObject({
      cleanup: 'delete',
      expectsCompletionMessage: true,
      completion: { required: true },
      delivery: { status: 'pending' },
    });
    expect(followup.delivery?.justDoManagedJoin).toBeUndefined();
    expect(source).toEqual(sourceBefore);
  });
});
