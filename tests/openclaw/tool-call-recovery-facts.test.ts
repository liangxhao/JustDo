import { describe, expect, it } from 'vitest';

import { observeToolCallRecoveryAttempt, projectToolCallRecoveryNestedEvidence } from '../../openclaw-extensions/runtime-services/tool-call-recovery/facts.mjs';
import { resolveToolCallRecovery } from '../../openclaw-extensions/runtime-services/tool-call-recovery/policy.mjs';

const user = () => ({ role: 'user', content: 'Continue the task.' });
const text = (value: string, phase?: string) => ({
  type: 'text',
  text: value,
  ...(phase ? { textSignature: JSON.stringify({ v: 1, id: 'segment', phase }) } : {}),
});
const failedAssistant = (overrides: Record<string, unknown> = {}) => ({
  role: 'assistant',
  stopReason: 'error',
  errorCode: 'malformed_tool_call_arguments',
  content: [{ type: 'thinking', thinking: 'opaque reasoning' }],
  diagnostics: [
    {
      type: 'tool_call_pre_dispatch_rejection',
      timestamp: 1,
      details: { streamComplete: true, dispatchCount: 0, batchRejected: true },
    },
  ],
  ...overrides,
});
const toolCall = (id: string, name: string) => ({
  role: 'assistant',
  content: [{ type: 'toolCall', id, name, arguments: {} }],
});
const toolResult = (toolCallId: string, toolName: string) => ({
  role: 'toolResult',
  toolCallId,
  toolName,
  content: [{ type: 'text', text: 'Done.' }],
});
const nativeAttempt = (overrides: Record<string, unknown> = {}) => {
  const assistant = failedAssistant();
  return {
    currentAttemptCompletedAssistant: assistant,
    messagesSnapshot: [user(), assistant],
    toolMetas: [],
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    ...overrides,
  };
};
const settledAttempt = () => {
  const assistant = failedAssistant();
  return nativeAttempt({
    currentAttemptCompletedAssistant: assistant,
    messagesSnapshot: [
      user(),
      toolCall('read-1', 'read'),
      toolResult('read-1', 'read'),
      toolCall('write-1', 'write'),
      toolResult('write-1', 'write'),
      assistant,
    ],
    toolMetas: [
      { toolCallId: 'read-1', toolName: 'read', replaySafe: true },
      { toolCallId: 'write-1', toolName: 'write', replaySafe: false },
    ],
    itemLifecycle: { startedCount: 2, completedCount: 2, activeCount: 0 },
  });
};

const nestedAttempt = () => {
  const assistant = failedAssistant();
  return nativeAttempt({
    sessionIdUsed: 'native-session',
    currentAttemptCompletedAssistant: assistant,
    messagesSnapshot: [user(), toolCall('outer', 'tool_call'), toolResult('outer', 'tool_call'), assistant],
    toolMetas: [
      { toolCallId: 'inner', toolName: 'read', isError: false, replaySafe: true },
      { toolCallId: 'outer', toolName: 'tool_call', isError: false, replaySafe: false },
    ],
    itemLifecycle: { startedCount: 2, completedCount: 2, activeCount: 0 },
    toolCallRecoveryNestedEvidence: {
      runId: 'native-run', sessionId: 'native-session', scopeId: 'native-scope',
      toolMetas: [
        { toolCallId: 'inner', toolName: 'read', parentToolCallId: 'outer', isError: false },
        { toolCallId: 'outer', toolName: 'tool_call', isError: false },
      ],
      activities: [{
        runId: 'native-run', scopeId: 'native-scope', toolCallId: 'inner',
        toolName: 'read', parentToolCallId: 'outer', isError: false,
      }],
    },
  });
};

describe('native accepted nested tool settlement', () => {
  it.each(['read', 'write', 'show_widget'])('continues after a settled Tool Search %s without replaying the parent', toolName => {
    const attempt = nestedAttempt();
    attempt.toolMetas[0].toolName = toolName;
    attempt.toolCallRecoveryNestedEvidence.toolMetas[0].toolName = toolName;
    attempt.toolCallRecoveryNestedEvidence.activities[0].toolName = toolName;

    const facts = observeToolCallRecoveryAttempt(attempt, false, 'native-run');

    expect(facts).toMatchObject({ rejected: true, excluded: false, allToolsSettled: true });
    expect(resolveToolCallRecovery({ ...facts, initialCandidate: true, aborted: false, attempts: 0 }).action).toBe('retry');
    expect(attempt.toolMetas[1].replaySafe).toBe(false);
  });

  const invalidEvidence: Array<[string, (attempt: ReturnType<typeof nestedAttempt>) => void]> = [
    ['missing evidence', attempt => { delete attempt.toolCallRecoveryNestedEvidence; }],
    ['failed native receipt read', attempt => { attempt.toolCallRecoveryNestedEvidence = null; }],
    ['foreign run', attempt => { attempt.toolCallRecoveryNestedEvidence.runId = 'other-run'; }],
    ['foreign session', attempt => { attempt.toolCallRecoveryNestedEvidence.sessionId = 'other-session'; }],
    ['missing native session', attempt => { delete attempt.sessionIdUsed; }],
    ['foreign receipt run', attempt => { attempt.toolCallRecoveryNestedEvidence.activities[0].runId = 'other-run'; }],
    ['foreign receipt scope', attempt => { attempt.toolCallRecoveryNestedEvidence.activities[0].scopeId = 'other-scope'; }],
    ['missing receipt', attempt => { attempt.toolCallRecoveryNestedEvidence.activities = []; }],
    ['duplicate receipt', attempt => { attempt.toolCallRecoveryNestedEvidence.activities.push({ ...attempt.toolCallRecoveryNestedEvidence.activities[0] }); }],
    ['wrong receipt name', attempt => { attempt.toolCallRecoveryNestedEvidence.activities[0].toolName = 'write'; }],
    ['wrong receipt result', attempt => { attempt.toolCallRecoveryNestedEvidence.activities[0].isError = true; }],
    ['wrong receipt parent', attempt => { attempt.toolCallRecoveryNestedEvidence.activities[0].parentToolCallId = 'other-parent'; }],
    ['unmatched parent', attempt => {
      attempt.toolCallRecoveryNestedEvidence.activities[0].parentToolCallId = 'other-parent';
      attempt.toolCallRecoveryNestedEvidence.toolMetas[0].parentToolCallId = 'other-parent';
    }],
    ['cyclic parent', attempt => {
      attempt.toolCallRecoveryNestedEvidence.activities[0].parentToolCallId = 'inner';
      attempt.toolCallRecoveryNestedEvidence.toolMetas[0].parentToolCallId = 'inner';
    }],
    ['unmatched meta', attempt => { attempt.toolCallRecoveryNestedEvidence.toolMetas[0].toolCallId = 'other-inner'; }],
    ['missing parent result', attempt => { attempt.messagesSnapshot.splice(2, 1); }],
    ['unknown settlement', attempt => { attempt.itemLifecycle.activeCount = 1; }],
    ['unfinished child', attempt => { attempt.itemLifecycle.completedCount = 1; }],
  ];
  it.each(invalidEvidence)('refuses %s without losing the exclusion on a later empty attempt', (_label, invalidate) => {
    const attempt = nestedAttempt();
    invalidate(attempt);
    const facts = observeToolCallRecoveryAttempt(attempt, false, 'native-run');
    expect(facts).toMatchObject({ rejected: true, excluded: true, allToolsSettled: false });
    expect(observeToolCallRecoveryAttempt(nativeAttempt(), facts.excluded, 'native-run').excluded).toBe(true);
  });

  it('does not accept nested evidence without the current native run binding', () => {
    expect(observeToolCallRecoveryAttempt(nestedAttempt()).allToolsSettled).toBe(false);
  });

  it.each(['asyncStarted', 'codeModeSuspended', 'terminate'])('keeps the %s exclusion on a proven nested child', flag => {
    const attempt = nestedAttempt();
    Object.assign(attempt.toolMetas[0], { [flag]: true });
    expect(observeToolCallRecoveryAttempt(attempt, false, 'native-run')).toMatchObject({ allToolsSettled: true, excluded: true });
  });

  it.each([
    ['final widget delivery', { sourceReplyDeliveryState: 'delivered' }],
    ['message delivery', { didSendViaMessagingTool: true }],
    ['block media delivery', { hasToolMediaBlockReply: true }],
    ['media result', { toolMediaUrls: ['native-media'] }],
    ['delegation', { acceptedSessionSpawns: [{ runId: 'child-run' }] }],
    ['yield', { yieldDetected: true }],
    ['approval', { didSendDeterministicApprovalPrompt: true }],
    ['client handoff', { clientToolCalls: [] }],
  ])('keeps %s excluded even when nested receipts are complete', (_label, override) => {
    const attempt = Object.assign(nestedAttempt(), override);
    const observed = observeToolCallRecoveryAttempt(attempt, false, 'native-run');
    expect(observed).toMatchObject({ allToolsSettled: true, excluded: true });
    expect(resolveToolCallRecovery({ ...observed, initialCandidate: true, aborted: false, attempts: 0 }).action).toBe('finalize');
  });

  it('checks every accepted child against its own parent, regardless of completion order', () => {
    const attempt = nestedAttempt();
    attempt.toolMetas.unshift({ toolCallId: 'leaf', toolName: 'write', isError: false, replaySafe: false });
    attempt.toolCallRecoveryNestedEvidence.toolMetas.push({ toolCallId: 'leaf', toolName: 'write', parentToolCallId: 'inner', isError: false });
    attempt.toolCallRecoveryNestedEvidence.activities.push({ runId: 'native-run', scopeId: 'native-scope', toolCallId: 'leaf', toolName: 'write', parentToolCallId: 'inner', isError: false });
    attempt.itemLifecycle = { startedCount: 3, completedCount: 3, activeCount: 0 };
    const before = structuredClone(attempt);

    expect(observeToolCallRecoveryAttempt(attempt, false, 'native-run')).toMatchObject({ excluded: false, allToolsSettled: true });
    expect(attempt).toEqual(before);
  });

  it('projects only receipt identities, never tool arguments or result contents', () => {
    const scope = { runId: 'native-run', sessionId: 'native-session', scopeId: 'native-scope' };
    const metas = [{ toolCallId: 'inner', toolName: 'read', parentToolCallId: 'outer', isError: false, meta: 'private arguments' }];
    const activity = { role: 'custom', customType: 'openclaw.nested-tool.v1', excludeFromContext: true,
      details: { ...scope, toolCallId: 'inner', toolName: 'read', parentToolCallId: 'outer', isError: false,
        input: 'private input', result: { content: [{ type: 'text', text: 'private result' }] } } };
    const projected = projectToolCallRecoveryNestedEvidence(scope, metas, [activity]);
    expect(JSON.stringify(projected)).not.toMatch(/private/);
    expect(projected.activities[0]).toEqual({ runId: 'native-run', scopeId: 'native-scope', toolCallId: 'inner', toolName: 'read', parentToolCallId: 'outer', isError: false });
    expect(projectToolCallRecoveryNestedEvidence(scope, metas, [{ ...activity, role: 'assistant' }]).activities).toEqual([null]);
  });
});

describe('native tool-call recovery fact projection', () => {
  it('admits a fully rejected first response with explicit zero lifecycle counts', () => {
    const attempt = nativeAttempt();

    const facts = observeToolCallRecoveryAttempt(attempt);

    expect(facts).toEqual({
      excluded: false,
      allToolsSettled: true,
      assistant: attempt.currentAttemptCompletedAssistant,
      rejected: true,
      streamComplete: true,
      dispatchCount: 0,
      hasVisibleText: false,
      commentaryOnly: false,
    });
    expect(facts.assistant).toBe(attempt.currentAttemptCompletedAssistant);
    expect(
      resolveToolCallRecovery({ ...facts, initialCandidate: true, aborted: false, attempts: 0 })
        .action,
    ).toBe('retry');
  });

  it('preserves settled ordinary writes without relabelling them replay-safe', () => {
    const attempt = settledAttempt();

    const facts = observeToolCallRecoveryAttempt(attempt);

    expect(facts).toMatchObject({ excluded: false, allToolsSettled: true, rejected: true });
    expect(attempt.toolMetas[1].replaySafe).toBe(false);
  });

  it('accepts prior-attempt settled history with a zero-tool current attempt', () => {
    const facts = observeToolCallRecoveryAttempt({
      ...settledAttempt(),
      toolMetas: [],
      itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
    });

    expect(facts).toMatchObject({ excluded: false, allToolsSettled: true });
  });

  it('admits an atomically removed valid/invalid batch without reconstructing either call', () => {
    const attempt = nativeAttempt({
      currentAttemptAssistant: structuredClone(failedAssistant()),
      lastAssistant: toolCall('invalid-sibling', 'exec'),
    });

    const facts = observeToolCallRecoveryAttempt(attempt);

    expect(facts).toMatchObject({ rejected: true, dispatchCount: 0, allToolsSettled: true });
    expect(attempt.messagesSnapshot).toHaveLength(2);
  });

  it('rejects an older completed failure when a new partial response owns the current turn', () => {
    const attempt = nativeAttempt({ currentAttemptAssistant: toolCall('new-pending', 'exec') });
    expect(observeToolCallRecoveryAttempt(attempt)).toMatchObject({
      excluded: true,
      rejected: false,
    });
  });

  it('rejects an older receipt when the latest transcript assistant belongs to another response', () => {
    const attempt = nativeAttempt();
    attempt.messagesSnapshot.push({ ...failedAssistant(), responseId: 'different-response' });
    expect(observeToolCallRecoveryAttempt(attempt)).toMatchObject({
      excluded: true,
      rejected: false,
    });
  });

  it.each(['lastAssistant', 'currentAttemptAssistant'])(
    'never revives a rejection from %s',
    key => {
      const attempt = nativeAttempt({
        currentAttemptCompletedAssistant: undefined,
        [key]: failedAssistant(),
      });

      const facts = observeToolCallRecoveryAttempt(attempt);

      expect(facts.assistant).toBeUndefined();
      expect(facts.rejected).toBe(false);
      expect(facts.streamComplete).toBe(false);
      expect(facts.dispatchCount).toBeUndefined();
    },
  );

  it.each([
    { stopReason: 'stop' },
    { errorCode: undefined },
    { errorCode: 'another_error' },
    { diagnostics: undefined },
    { diagnostics: [] },
    {
      diagnostics: [
        {
          type: 'provider_error',
          details: { batchRejected: true, streamComplete: true, dispatchCount: 0 },
        },
      ],
    },
    {
      diagnostics: [
        {
          type: 'tool_call_pre_dispatch_rejection',
          details: { batchRejected: false, streamComplete: true, dispatchCount: 0 },
        },
      ],
    },
    {
      diagnostics: [
        {
          type: 'tool_call_pre_dispatch_rejection',
          details: { batchRejected: true, streamComplete: false, dispatchCount: 0 },
        },
      ],
    },
    {
      diagnostics: [
        {
          type: 'tool_call_pre_dispatch_rejection',
          details: { batchRejected: true, streamComplete: true, dispatchCount: 1 },
        },
      ],
    },
    {
      diagnostics: [
        {
          type: 'tool_call_pre_dispatch_rejection',
          details: { batchRejected: true, streamComplete: true },
        },
      ],
    },
  ])('requires the complete current producer contract: %j', overrides => {
    const facts = observeToolCallRecoveryAttempt(
      nativeAttempt({ currentAttemptCompletedAssistant: failedAssistant(overrides) }),
    );

    expect(facts.rejected).toBe(false);
    expect(facts.streamComplete).toBe(false);
    expect(facts.dispatchCount).toBeUndefined();
  });

  it('rejects duplicate producer diagnostics and remaining current tool-call blocks', () => {
    const producer = failedAssistant().diagnostics[0];
    const duplicated = observeToolCallRecoveryAttempt(
      nativeAttempt({
        currentAttemptCompletedAssistant: failedAssistant({ diagnostics: [producer, producer] }),
      }),
    );
    const residual = observeToolCallRecoveryAttempt(
      nativeAttempt({
        currentAttemptCompletedAssistant: failedAssistant({
          content: toolCall('leftover', 'read').content,
        }),
      }),
    );

    expect(duplicated).toMatchObject({ rejected: false, excluded: true });
    expect(residual.rejected).toBe(false);
  });

  it('does not mistake a missing early result for a settled final batch', () => {
    const attempt = settledAttempt();
    attempt.messagesSnapshot.splice(2, 1);

    const facts = observeToolCallRecoveryAttempt(attempt);

    expect(facts.allToolsSettled).toBe(false);
  });

  it.each([
    { startedCount: 1, completedCount: 0, activeCount: 1 },
    { startedCount: 2, completedCount: 2, activeCount: 1 },
    { startedCount: -1, completedCount: -1, activeCount: 0 },
    { startedCount: 0.5, completedCount: 0.5, activeCount: 0 },
    { startedCount: 0, completedCount: 0 },
    undefined,
  ])('requires explicit, consistent lifecycle accounting: %j', itemLifecycle => {
    const facts = observeToolCallRecoveryAttempt(nativeAttempt({ itemLifecycle }));

    expect(facts.allToolsSettled).toBe(false);
  });

  it('rejects projection gaps even when lifecycle counters say everything completed', () => {
    const facts = observeToolCallRecoveryAttempt(
      nativeAttempt({
        toolMetas: [{ toolCallId: 'missing-call', toolName: 'write' }],
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
      }),
    );

    expect(facts.allToolsSettled).toBe(false);
  });

  it('does not let a later empty attempt erase earlier unknown settlement', () => {
    const first = observeToolCallRecoveryAttempt(
      nativeAttempt({ itemLifecycle: { startedCount: 1, completedCount: 0, activeCount: 1 } }),
    );

    const next = observeToolCallRecoveryAttempt(nativeAttempt(), first.excluded);

    expect(first).toMatchObject({ allToolsSettled: false, excluded: true });
    expect(next).toMatchObject({ allToolsSettled: true, excluded: true });
  });

  it.each(
    [
      [user(), toolResult('write-1', 'write'), toolCall('write-1', 'write')],
      [user(), toolCall('write-1', 'write'), toolResult('write-1', 'read')],
      [
        user(),
        toolCall('write-1', 'write'),
        toolResult('write-1', 'write'),
        toolResult('write-1', 'write'),
      ],
      [
        user(),
        toolCall('write-1', 'write'),
        toolResult('write-1', 'write'),
        toolCall('write-1', 'write'),
        toolResult('write-1', 'write'),
      ],
      [user(), toolCall('', 'write'), toolResult('', 'write')],
      [user(), { role: 'assistant', content: [{ type: 'unknown' }] }],
    ].map(messagesSnapshot => [messagesSnapshot]),
  )('rejects invalid batch ownership, ordering or uniqueness: %j', messagesSnapshot => {
    const facts = observeToolCallRecoveryAttempt(nativeAttempt({ messagesSnapshot }));

    expect(facts.allToolsSettled).toBe(false);
  });

  it.each(
    [
      [{ toolName: 'write' }],
      [{ toolCallId: 'write-1', toolName: 'read' }],
      [
        { toolCallId: 'write-1', toolName: 'write' },
        { toolCallId: 'write-1', toolName: 'write' },
      ],
    ].map(toolMetas => [toolMetas]),
  )('requires each current executed meta to have its own matching result: %j', toolMetas => {
    const facts = observeToolCallRecoveryAttempt({
      ...settledAttempt(),
      toolMetas,
      itemLifecycle: {
        startedCount: toolMetas.length,
        completedCount: toolMetas.length,
        activeCount: 0,
      },
    });

    expect(facts.allToolsSettled).toBe(false);
  });

  it('ignores unresolved calls and reused IDs in older user turns', () => {
    const attempt = settledAttempt();
    attempt.messagesSnapshot.unshift(user(), toolCall('write-1', 'old-unresolved-tool'));

    const facts = observeToolCallRecoveryAttempt(attempt);

    expect(facts).toMatchObject({ excluded: false, allToolsSettled: true });
  });

  it.each([
    { clientToolCalls: [] },
    { yieldDetected: true },
    { yieldMessageWaitRegistered: true },
    { didSendDeterministicApprovalPrompt: true },
    { heartbeatToolResponse: {} },
    { lastToolError: {} },
    { toolMediaUrls: ['media'] },
    { hostOwnedToolMediaUrls: ['media'] },
    { toolAudioAsVoice: true },
    { toolTrustedLocalMedia: true },
    { hasToolMediaBlockReply: true },
    { didSendViaMessagingTool: true },
    { didDeliverSourceReplyViaMessageTool: true },
    { sourceReplyDelivered: true },
    { sourceReplyDeliveryState: 'pending' },
    { sourceReplyDeliveryState: 'delivered' },
    { messagingToolSentTexts: ['sent'] },
    { messagingToolSentMediaUrls: ['media'] },
    { messagingToolSentTargets: [{}] },
    { messagingToolSourceReplyPayloads: [{}] },
    { successfulCronAdds: 1 },
    { acceptedSessionSpawns: [{ runId: 'child', childSessionKey: 'agent:child:session' }] },
    { runtimeContinuationStarted: true },
  ])('retains excluded native activity: %j', overrides => {
    const facts = observeToolCallRecoveryAttempt(nativeAttempt(overrides));

    expect(facts.excluded).toBe(true);
  });

  it.each([
    { asyncStarted: true },
    { codeModeSuspended: true },
    { terminate: true },
    { asyncTaskId: 'task' },
    { asyncTaskRunId: 'run' },
    { asyncTaskIds: [] },
  ])('retains excluded tool execution metadata: %j', activity => {
    const attempt = settledAttempt();
    Object.assign(attempt.toolMetas[1], activity);

    const first = observeToolCallRecoveryAttempt(attempt);
    const next = observeToolCallRecoveryAttempt(nativeAttempt(), first.excluded);

    expect(first.excluded).toBe(true);
    expect(next.excluded).toBe(true);
  });

  it.each([
    { toolMetas: undefined },
    { toolMetas: [null] },
    { didSendViaMessagingTool: undefined },
    { messagingToolSentTexts: undefined },
    { messagingToolSentMediaUrls: null },
    { messagingToolSentTargets: {} },
    { yieldDetected: 'false' },
    { yieldMessageWaitRegistered: 'false' },
    { acceptedSessionSpawns: {} },
    { successfulCronAdds: -1 },
    { currentAttemptCompletedAssistant: failedAssistant({ content: [{ type: 'text', text: 1 }] }) },
  ])('does not erase unknown native structure: %j', overrides => {
    const facts = observeToolCallRecoveryAttempt(nativeAttempt(overrides));

    expect(facts.excluded).toBe(true);
  });

  it('preserves an unknown previous exclusion state conservatively', () => {
    const facts = observeToolCallRecoveryAttempt(nativeAttempt(), null);

    expect(facts.excluded).toBe(true);
  });

  it('requires every visible text block to carry a native commentary signature', () => {
    const facts = observeToolCallRecoveryAttempt(
      nativeAttempt({
        currentAttemptCompletedAssistant: failedAssistant({
          content: [
            text('I will check.', 'commentary'),
            text('Then continue.', 'commentary'),
            text('   '),
          ],
        }),
      }),
    );

    expect(facts).toMatchObject({ hasVisibleText: true, commentaryOnly: true, rejected: true });
  });

  it.each([
    { phase: 'commentary', content: [text('Unphased text.')] },
    { content: [text('Commentary.', 'commentary'), text('Unphased text.')] },
    { content: [text('Commentary.', 'commentary'), text('Final.', 'final_answer')] },
    { phase: 'final_answer', content: [text('Conflicting commentary.', 'commentary')] },
    { phase: 'unknown', content: [text('Unknown phase.', 'commentary')] },
    { content: [{ type: 'text', text: 'Legacy signature.', textSignature: 'commentary-0' }] },
    { content: [{ type: 'text', text: 'Invalid signature.', textSignature: '{broken' }] },
    {
      content: [
        {
          type: 'text',
          text: 'Unknown signature version.',
          textSignature: '{"v":2,"phase":"commentary"}',
        },
      ],
    },
  ])('does not infer commentary from top-level or partial phase evidence: %j', overrides => {
    const facts = observeToolCallRecoveryAttempt(
      nativeAttempt({ currentAttemptCompletedAssistant: failedAssistant(overrides) }),
    );

    expect(facts).toMatchObject({ hasVisibleText: true, commentaryOnly: false });
  });

  it('does not require a text phase for thinking-only content', () => {
    const facts = observeToolCallRecoveryAttempt(nativeAttempt());

    expect(facts).toMatchObject({ hasVisibleText: false, commentaryOnly: false, rejected: true });
  });

  it('does not mutate its input or retain observations in module state', () => {
    const attempt = settledAttempt();
    const before = JSON.stringify(attempt);
    observeToolCallRecoveryAttempt(attempt, true);

    const facts = observeToolCallRecoveryAttempt(attempt);

    expect(JSON.stringify(attempt)).toBe(before);
    expect(facts.excluded).toBe(false);
  });
});
