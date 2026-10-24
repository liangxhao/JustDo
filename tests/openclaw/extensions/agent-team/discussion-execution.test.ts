import { beforeEach, expect, it, vi } from 'vitest';

import { executeGroupDiscussion } from '../../../../plugins/extensions/agent-team/discussion/discussion-execution';

const sdk = vi.hoisted(() => ({
  dispatch: vi.fn(),
  getSessionEntry: vi.fn(),
  group: vi.fn(),
  reply: vi.fn(),
  append: vi.fn(),
  identity: { agentId: 'alice', sessionKey: 'agent:alice:justdo-team:group:room' },
}));
vi.mock('openclaw/plugin-sdk/channel-inbound', () => ({
  dispatchChannelInboundTurn: sdk.dispatch,
  getGroupThreadDeliverySession: () => sdk.identity,
  resolveGroupThreadMentionFacts: () => ({}),
  resolveGroupThreadConfig: () => ({}),
  runGroupThread: sdk.group,
}));
vi.mock('openclaw/plugin-sdk/reply-runtime', () => ({
  dispatchReplyWithBufferedBlockDispatcher: sdk.reply,
}));
vi.mock('openclaw/plugin-sdk/session-store-runtime', () => ({
  getSessionEntry: sdk.getSessionEntry,
}));
vi.mock('openclaw/plugin-sdk/session-transcript-runtime', () => ({
  appendSessionTranscriptMessageByIdentity: sdk.append,
}));

beforeEach(() => {
  vi.clearAllMocks();
  sdk.dispatch.mockResolvedValue(undefined);
  sdk.getSessionEntry.mockImplementation(({ agentId }) => ({
    sessionId: agentId,
    lifecycleRevision: 'rev',
    sessionRoot: '/project',
    permissionMode: 'read-only',
  }));
});

it('preserves accepted native ownership when the start callback rejects a changed member', async () => {
  const members = ['alice', 'bob'].map(agentId => ({
    agentId,
    name: agentId,
    sessionId: agentId,
    lifecycleRevision: 'rev',
    sessionRoot: '/project',
    permissionMode: 'read-only',
  }));
  let listener!: (event: never) => void;
  const unsubscribe = vi.fn();
  const onExecution = vi.fn();
  const onOutcome = vi.fn();
  const dispatcher = vi.fn(async params => {
    sdk.identity = { agentId: 'alice', sessionKey: 'agent:alice:justdo-team:group:room' };
    sdk.getSessionEntry.mockReturnValue({
      sessionId: 'replacement',
      lifecycleRevision: 'changed',
      sessionRoot: '/project',
      permissionMode: 'read-only',
    });
    params.replyOptions.onAgentRunStart('native-alice');
  });
  sdk.dispatch.mockImplementation(async turn => {
    await turn.dispatchReplyFromConfig({
      ctx: { AgentId: 'alice' },
      replyOptions: turn.replyOptions,
    });
  });

  await expect(
    executeGroupDiscussion({
      cfg: {},
      room: {
        id: 'room',
        title: 'Fixture',
        members,
        rounds: 1,
        revision: 1,
        generation: 0,
        state: 'ready',
        cwd: '/project',
        permissionMode: 'ask',
        createdAt: 1,
        updatedAt: 1,
      },
      send: {
        roomId: 'room',
        requestId: 'request',
        expectedRevision: 1,
        message: 'Topic',
        selectedAgentIds: [],
        rounds: 1,
      },
      resources: { settingsRevision: 1, maxRounds: 4, maxTurns: 2, maxConcurrent: 1 },
      discussionId: 'discussion',
      members,
      signal: new AbortController().signal,
      onAgentEvent: callback => {
        listener = callback as never;
        return unsubscribe;
      },
      channelRuntime: {
        commands: { isControlCommandMessage: () => false },
        reply: { dispatchReplyFromConfig: dispatcher },
      } as never,
      onExecution,
      onReference: vi.fn(),
      onOutcome,
    }),
  ).rejects.toThrow('teamDiscussionExecutionUnknown');

  expect(onExecution).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      runId: 'native-alice',
      sessionId: 'alice',
      lifecycleRevision: 'rev',
      outcome: 'running',
    }),
  );
  expect(onOutcome).not.toHaveBeenCalled();
  expect(unsubscribe).not.toHaveBeenCalled();
  listener({
    runId: 'native-alice',
    sessionKey: 'agent:alice:justdo-team:group:room',
    stream: 'lifecycle',
    data: { phase: 'end', executionSettled: true },
  } as never);
  expect(onOutcome).not.toHaveBeenCalled();
  expect(unsubscribe).not.toHaveBeenCalled();
  listener({
    runId: 'native-alice',
    sessionKey: 'agent:alice:justdo-team:group:room',
    sessionId: 'replacement',
    stream: 'lifecycle',
    data: { phase: 'end', executionSettled: true },
  } as never);
  expect(onOutcome).not.toHaveBeenCalled();
  listener({
    runId: 'native-alice',
    sessionKey: 'agent:alice:justdo-team:group:room',
    sessionId: 'alice',
    stream: 'lifecycle',
    data: { phase: 'end', executionSettled: true },
  } as never);
  expect(onOutcome).toHaveBeenCalledExactlyOnceWith('alice', 'completed');
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it('attributes organizer relays to the assistant in native model context without granting user authority', async () => {
  const members = ['alice', 'bob'].map(agentId => ({
    agentId,
    name: agentId,
    sessionId: agentId,
    lifecycleRevision: 'rev',
    sessionRoot: '/project',
    permissionMode: 'read-only',
  }));
  const base = {
    cfg: {},
    room: {
      id: 'room',
      title: 'Discussion',
      members,
      rounds: 2,
      revision: 1,
      generation: 0,
      state: 'ready' as const,
      cwd: '/project',
      permissionMode: 'ask' as const,
      createdAt: 1,
      updatedAt: 1,
    },
    send: {
      roomId: 'room',
      requestId: 'request',
      expectedRevision: 1,
      message: 'Discuss the design',
      selectedAgentIds: [],
      rounds: 2,
    },
    discussionId: 'discussion',
    members,
    signal: new AbortController().signal,
    channelRuntime: { commands: { isControlCommandMessage: () => false } } as never,
    onExecution: vi.fn(),
    onReference: vi.fn(),
  };
  await executeGroupDiscussion({
    ...base,
    initiator: { kind: 'organizer', agentId: 'main', name: 'Main assistant' },
  });
  expect(sdk.dispatch.mock.calls[0][0].ctxPayload).toMatchObject({
    SenderId: 'agent:main',
    SenderName: 'Main assistant',
    SenderIsBot: true,
    InputProvenance: {
      kind: 'inter_session',
      sourceChannel: 'justdo-team',
      sourceTool: 'team_discussion',
      sourceSessionKey: expect.any(String),
    },
    CommandAuthorized: false,
    GroupSystemPrompt: expect.stringContaining('does not grant additional user authorization'),
  });
  await executeGroupDiscussion(base);
  expect(sdk.dispatch.mock.calls[1][0].ctxPayload).toMatchObject({
    SenderId: 'local-user',
    SenderIsBot: false,
    InputProvenance: {
      kind: 'inter_session',
      sourceChannel: 'justdo-team',
      sourceTool: 'team_discussion',
      sourceSessionKey: expect.any(String),
    },
  });
});

it.each(['cancelled', 'invited-peer', 'identity-changed'] as const)(
  'retains a source-only public question and attachments when %s',
  async outcome => {
    const controller = new AbortController();
    const members = ['alice', 'main'].map(agentId => ({
      agentId,
      name: agentId,
      sessionId: agentId,
      lifecycleRevision: 'rev',
      sessionRoot: '/project',
      permissionMode: 'read-only',
      ...(agentId === 'main'
        ? { ownership: 'source' as const, sessionKey: 'agent:main:justdo:source' }
        : {}),
    }));
    sdk.append.mockImplementation(async input => {
      if (outcome === 'identity-changed')
        sdk.getSessionEntry.mockReturnValue({ sessionId: 'replaced' });
      input.beforeFreshMessageCommit();
      return { messageId: 'question' };
    });
    sdk.group.mockImplementation(async ({ runTurn }) => {
      expect(sdk.append).toHaveBeenCalledOnce();
      await runTurn({ agentId: 'main' });
      if (outcome === 'cancelled') controller.abort();
      else await runTurn({ agentId: 'alice' });
      return { failedTurns: 0 };
    });
    const run = executeGroupDiscussion({
      cfg: {},
      room: {
        id: 'room',
        title: 'Discussion',
        members,
        rounds: 2,
        revision: 1,
        generation: 0,
        state: 'ready',
        cwd: '/project',
        permissionMode: 'ask',
        createdAt: 1,
        updatedAt: 1,
        sourceSessionId: 'source',
        summarySource: {
          agentId: 'main',
          sessionKey: 'agent:main:justdo:source',
          sessionId: 'main',
          lifecycleRevision: 'rev',
        },
      },
      send: {
        roomId: 'room',
        requestId: 'request',
        expectedRevision: 1,
        message: 'Review the attachment',
        selectedAgentIds: ['main'],
        rounds: 2,
        attachmentPaths: ['/project/report.pdf'],
      },
      discussionId: 'discussion',
      members,
      signal: controller.signal,
      channelRuntime: { commands: { isControlCommandMessage: () => false } } as never,
      onExecution: vi.fn(),
      onReference: vi.fn(),
    });
    if (outcome !== 'invited-peer') await expect(run).rejects.toThrow();
    else await expect(run).resolves.toBeUndefined();
    if (outcome === 'identity-changed') expect(sdk.group).not.toHaveBeenCalled();
    expect(sdk.append).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'alice',
        sessionId: 'alice',
        idempotencyLookup: 'scan',
        message: expect.objectContaining({
          role: 'user',
          idempotencyKey: 'justdo-team:room:discussion:input',
          openclawDeliveryMirror: {
            kind: 'channel-input',
            sourceMessageId: 'justdo-team:room:discussion',
          },
          openclawDelivery: { mediaUrls: ['/project/report.pdf'] },
        }),
      }),
    );
  },
);

it.each(['ack', 'callback', 'throw'] as const)(
  'does not reuse capacity after unconfirmed %s',
  async report => {
    const members = ['alice', 'bob'].map(agentId => ({
      agentId,
      name: agentId,
      sessionId: agentId,
      lifecycleRevision: 'rev',
      sessionRoot: '/project',
      permissionMode: 'read-only',
    }));
    const dispatcher = vi.fn(async params => {
      sdk.identity = {
        agentId: params.ctx.AgentId,
        sessionKey: `agent:${params.ctx.AgentId}:justdo-team:group:room`,
      };
      params.replyOptions.onAgentRunStart(`native-${params.ctx.AgentId}`);
      if (report === 'callback') params.replyOptions.onAgentRunTerminalOutcome('completed');
      if (report === 'throw') throw new Error('dispatcher failure');
      return { queuedFinal: true }; // Still no executionSettled lifecycle evidence.
    });
    sdk.dispatch.mockImplementation(async turn => {
      const results = await Promise.allSettled(
        members.map(member =>
          turn.dispatchReplyFromConfig({
            ctx: { AgentId: member.agentId },
            replyOptions: turn.replyOptions,
          }),
        ),
      );
      if (report === 'throw')
        throw (results.find(result => result.status === 'rejected') as PromiseRejectedResult)
          .reason;
    });
    await expect(
      executeGroupDiscussion({
        cfg: {},
        room: {
          id: 'room',
          title: 'Fixture',
          members,
          rounds: 1,
          revision: 1,
          generation: 0,
          state: 'ready',
          cwd: '/project',
          permissionMode: 'ask',
          createdAt: 1,
          updatedAt: 1,
        },
        send: {
          roomId: 'room',
          requestId: 'request',
          expectedRevision: 1,
          message: 'Topic',
          selectedAgentIds: [],
          rounds: 1,
        },
        resources: { settingsRevision: 1, maxRounds: 4, maxTurns: 2, maxConcurrent: 1 },
        discussionId: 'discussion',
        members,
        signal: new AbortController().signal,
        onAgentEvent: vi.fn(() => () => {}),
        channelRuntime: {
          commands: { isControlCommandMessage: () => false },
          reply: { dispatchReplyFromConfig: dispatcher },
        } as never,
        onExecution: vi.fn(),
        onReference: vi.fn(),
      }),
    ).rejects.toThrow('teamDiscussionExecutionUnknown');
    expect(dispatcher).toHaveBeenCalledOnce();
  },
);

it.each(['end', 'error'] as const)(
  'keeps the permit until dispatch cleanup with native %s and ignores duplicate terminals',
  async phase => {
    const members = ['alice', 'bob'].map(agentId => ({
      agentId,
      name: agentId,
      sessionId: agentId,
      lifecycleRevision: 'rev',
      sessionRoot: '/project',
      permissionMode: 'read-only',
    }));
    let listener: (event: never) => void;
    const held: (() => void)[] = [];
    const entered: string[] = [];
    const onOutcome = vi.fn();
    const dispatcher = vi.fn(async params => {
      const agentId = params.ctx.AgentId;
      entered.push(agentId);
      sdk.identity = { agentId, sessionKey: `agent:${agentId}:justdo-team:group:room` };
      params.replyOptions.onAgentRunStart(`native-${agentId}`);
      params.replyOptions.onAgentRunTerminalOutcome('completed');
      listener({
        runId: `native-${agentId}`,
        sessionKey: sdk.identity.sessionKey,
        sessionId: agentId,
        stream: 'lifecycle',
        data: { phase, executionSettled: true },
      } as never);
      await new Promise<void>(resolve => held.push(resolve));
      return { queuedFinal: true };
    });
    sdk.dispatch.mockImplementation(async turn => {
      await Promise.allSettled(
        members.map(member =>
          turn.dispatchReplyFromConfig({
            ctx: { AgentId: member.agentId },
            replyOptions: turn.replyOptions,
          }),
        ),
      );
    });
    const run = executeGroupDiscussion({
      cfg: {},
      room: {
        id: 'room',
        title: 'Fixture',
        members,
        rounds: 1,
        revision: 1,
        generation: 0,
        state: 'ready',
        cwd: '/project',
        permissionMode: 'ask',
        createdAt: 1,
        updatedAt: 1,
      },
      send: {
        roomId: 'room',
        requestId: 'request',
        expectedRevision: 1,
        message: 'Topic',
        selectedAgentIds: [],
        rounds: 1,
      },
      resources: { settingsRevision: 1, maxRounds: 4, maxTurns: 2, maxConcurrent: 1 },
      discussionId: 'discussion',
      members,
      signal: new AbortController().signal,
      onAgentEvent: callback => {
        listener = callback as never;
        return () => {};
      },
      channelRuntime: {
        commands: { isControlCommandMessage: () => false },
        reply: { dispatchReplyFromConfig: dispatcher },
      } as never,
      onExecution: vi.fn(),
      onReference: vi.fn(),
      onOutcome,
    });
    await vi.waitFor(() => expect(entered).toEqual(['alice']));
    expect(dispatcher).toHaveBeenCalledOnce();
    held.shift()!();
    await vi.waitFor(() => expect(entered).toEqual(['alice', 'bob']));
    listener({
      runId: 'native-alice',
      sessionKey: 'agent:alice:justdo-team:group:room',
      sessionId: 'alice',
      stream: 'lifecycle',
      data: { phase, executionSettled: true },
    } as never);
    expect(onOutcome).toHaveBeenCalledTimes(2);
    held.shift()!();
    if (phase === 'error') await expect(run).rejects.toThrow('teamDiscussionMemberFailed');
    else await expect(run).resolves.toBeUndefined();
  },
);

it('retains late lifecycle listening while another acquired dispatch is still preparing', async () => {
  const members = ['alice', 'bob'].map(agentId => ({
    agentId,
    name: agentId,
    sessionId: agentId,
    lifecycleRevision: 'rev',
    sessionRoot: '/project',
    permissionMode: 'read-only',
  }));
  let listener: (event: never) => void;
  let subscribed = true;
  const unsubscribe = vi.fn(() => {
    subscribed = false;
  });
  let releaseBob!: () => void;
  const bobReady = new Promise<void>(resolve => {
    releaseBob = resolve;
  });
  let aliceReturned = false;
  const dispatcher = vi.fn(async params => {
    const agentId = params.ctx.AgentId;
    if (agentId === 'bob') await bobReady;
    sdk.identity = { agentId, sessionKey: `agent:${agentId}:justdo-team:group:room` };
    params.replyOptions.onAgentRunStart(`native-${agentId}`);
    if (agentId === 'alice') aliceReturned = true;
    else if (subscribed)
      listener({
        runId: 'native-bob',
        sessionKey: sdk.identity.sessionKey,
        sessionId: 'bob',
        stream: 'lifecycle',
        data: { phase: 'end', executionSettled: true },
      } as never);
    return { queuedFinal: true };
  });
  sdk.dispatch.mockImplementation(async turn => {
    await Promise.allSettled(
      members.map(member =>
        turn.dispatchReplyFromConfig({
          ctx: { AgentId: member.agentId },
          replyOptions: turn.replyOptions,
        }),
      ),
    );
  });
  const onOutcome = vi.fn();
  const onExecution = vi.fn();
  const run = executeGroupDiscussion({
    cfg: {},
    room: {
      id: 'room',
      title: 'Fixture',
      members,
      rounds: 1,
      revision: 1,
      generation: 0,
      state: 'ready',
      cwd: '/project',
      permissionMode: 'ask',
      createdAt: 1,
      updatedAt: 1,
    },
    send: {
      roomId: 'room',
      requestId: 'request',
      expectedRevision: 1,
      message: 'Topic',
      selectedAgentIds: [],
      rounds: 1,
    },
    resources: { settingsRevision: 1, maxRounds: 4, maxTurns: 2, maxConcurrent: 2 },
    discussionId: 'discussion',
    members,
    signal: new AbortController().signal,
    onAgentEvent: callback => {
      listener = callback as never;
      return unsubscribe;
    },
    channelRuntime: {
      commands: { isControlCommandMessage: () => false },
      reply: { dispatchReplyFromConfig: dispatcher },
    } as never,
    onExecution,
    onReference: vi.fn(),
    onOutcome,
  });
  await vi.waitFor(() => expect(aliceReturned).toBe(true));
  await new Promise(resolve => setTimeout(resolve, 0));
  listener({
    runId: 'native-alice',
    sessionKey: 'agent:alice:justdo-team:group:room',
    sessionId: 'alice',
    stream: 'lifecycle',
    data: { phase: 'end', executionSettled: true },
  } as never);
  expect(unsubscribe).not.toHaveBeenCalled();
  releaseBob();
  await expect(run).rejects.toThrow('teamDiscussionExecutionUnknown');
  expect(onExecution).toHaveBeenCalledTimes(2);
  expect(onOutcome.mock.calls).toEqual([
    ['alice', 'completed'],
    ['bob', 'completed'],
  ]);
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it('blocks a granted queued permit if uncertainty closes the pool before its continuation', async () => {
  const members = ['alice', 'carol', 'bob'].map(agentId => ({
    agentId,
    name: agentId,
    sessionId: agentId,
    lifecycleRevision: 'rev',
    sessionRoot: '/project',
    permissionMode: 'read-only',
  }));
  let listener: (event: never) => void;
  let subscribed = true;
  const unsubscribe = vi.fn(() => {
    subscribed = false;
  });
  const finish: Record<string, () => void> = {};
  const started: string[] = [];
  const dispatcher = vi.fn(params => {
    const agentId = params.ctx.AgentId;
    started.push(agentId);
    sdk.identity = { agentId, sessionKey: `agent:${agentId}:justdo-team:group:room` };
    params.replyOptions.onAgentRunStart(`native-${agentId}`);
    if (agentId === 'bob') {
      if (subscribed)
        listener({
          runId: 'native-bob',
          sessionKey: sdk.identity.sessionKey,
          sessionId: 'bob',
          stream: 'lifecycle',
          data: { phase: 'end', executionSettled: true },
        } as never);
      return Promise.resolve({ queuedFinal: true });
    }
    return new Promise(resolve => {
      finish[agentId] = () => resolve({ queuedFinal: true });
    });
  });
  sdk.dispatch.mockImplementation(async turn => {
    await Promise.allSettled(
      members.map(member =>
        turn.dispatchReplyFromConfig({
          ctx: { AgentId: member.agentId },
          replyOptions: turn.replyOptions,
        }),
      ),
    );
  });
  const onOutcome = vi.fn();
  const onExecution = vi.fn();
  const run = executeGroupDiscussion({
    cfg: {},
    room: {
      id: 'room',
      title: 'Fixture',
      members,
      rounds: 1,
      revision: 1,
      generation: 0,
      state: 'ready',
      cwd: '/project',
      permissionMode: 'ask',
      createdAt: 1,
      updatedAt: 1,
    },
    send: {
      roomId: 'room',
      requestId: 'request',
      expectedRevision: 1,
      message: 'Topic',
      selectedAgentIds: [],
      rounds: 1,
    },
    resources: { settingsRevision: 1, maxRounds: 4, maxTurns: 3, maxConcurrent: 2 },
    discussionId: 'discussion',
    members,
    signal: new AbortController().signal,
    onAgentEvent: callback => {
      listener = callback as never;
      return unsubscribe;
    },
    channelRuntime: {
      commands: { isControlCommandMessage: () => false },
      reply: { dispatchReplyFromConfig: dispatcher },
    } as never,
    onExecution,
    onReference: vi.fn(),
    onOutcome,
  });
  await vi.waitFor(() => expect(started).toEqual(['alice', 'carol']));
  listener({
    runId: 'native-carol',
    sessionKey: 'agent:carol:justdo-team:group:room',
    sessionId: 'carol',
    stream: 'lifecycle',
    data: { phase: 'end', executionSettled: true },
  } as never);
  finish.carol();
  finish.alice();
  queueMicrotask(() =>
    listener({
      runId: 'native-alice',
      sessionKey: 'agent:alice:justdo-team:group:room',
      sessionId: 'alice',
      stream: 'lifecycle',
      data: { phase: 'end', executionSettled: true },
    } as never),
  );
  await expect(run).rejects.toThrow('teamDiscussionExecutionUnknown');
  expect(started).toEqual(['alice', 'carol']);
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(onOutcome.mock.calls).toEqual([
    ['carol', 'completed'],
    ['alice', 'completed'],
  ]);
});
