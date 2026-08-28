import { describe, expect, test } from 'vitest';

import { projectPersistedTimeline } from './project-history-timeline';

describe('projectPersistedTimeline', () => {
  test('flattens mixed persisted assistant content around hard Content boundaries', () => {
    const result = projectPersistedTimeline([
      { role: 'user', content: 'go', id: 'user-1' },
      {
        role: 'assistant',
        id: 'assistant-1',
        content: [
          { type: 'thinking', thinking: 'plan' },
          { type: 'toolcall', toolCallId: 'call-1', name: 'read' },
          { type: 'toolresult', toolCallId: 'call-1', text: 'ok' },
          { type: 'text', text: 'first content' },
          { type: 'thinking', thinking: 'more' },
          { type: 'text', text: 'second content' },
        ],
      },
    ]);

    expect(result.map(item => item.kind)).toEqual([
      'history-message',
      'process-summary',
      'history-message',
      'process-summary',
      'history-message',
    ]);
    expect(result[1]).toMatchObject({ thinkingCount: 1, toolCount: 1 });
  });

  test('uses deterministic keys for cold history', () => {
    const messages = [{ role: 'assistant', content: 'answer', id: 'message-1' }];
    expect(projectPersistedTimeline(messages)[0].key).toBe(
      projectPersistedTimeline(messages)[0].key,
    );
  });

  test('does not infer run duration from message timestamps', () => {
    const result = projectPersistedTimeline([
      { role: 'user', content: 'first prompt', timestamp: 1_000 },
      { role: 'assistant', content: 'first answer', timestamp: 4_500 },
      { role: 'user', content: 'second prompt', timestamp: 10_000 },
      { role: 'assistant', content: 'second answer', timestamp: 12_000 },
    ]);

    expect(
      result.filter(item => item.kind === 'history-message').map(item => item.durationMs ?? null),
    ).toEqual([null, null, null, null]);
  });

  test('uses the transcript record timestamp for a provider message without a timestamp', () => {
    const result = projectPersistedTimeline([
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-yield-1', name: 'sessions_yield' }],
        __openclaw: { id: 'message-1', seq: 1, recordTimestampMs: 12_345 },
      },
    ]);

    expect(result).toEqual([
      expect.objectContaining({
        kind: 'live-process',
        item: expect.objectContaining({
          toolCallId: 'call-yield-1',
          startedAt: 12_345,
        }),
      }),
    ]);
  });

  test('uses a persisted run receipt and attaches it to the last visible announce', () => {
    const result = projectPersistedTimeline(
      [
        {
          role: 'user',
          content: 'prompt',
          runId: 'run-root',
        },
        {
          role: 'assistant',
          content: 'answer',
          runId: 'run-root',
        },
        {
          role: 'assistant',
          content: 'subagent result',
          runId: 'announce:v1:child',
          provider: 'openclaw',
          model: 'gateway-injected',
        },
      ],
      [
        {
          id: 'timing-1',
          sessionId: 'session-1',
          clientTurnId: 'run-root',
          rootRunId: 'run-root',
          startedAt: 1_000,
          endedAt: 6_000,
          state: 'completed',
        },
      ],
    );

    expect(result[1]).toEqual(expect.not.objectContaining({ durationMs: expect.any(Number) }));
    expect(result[2]).toMatchObject({
      kind: 'history-message',
      durationMs: 5_000,
      completedAt: 6_000,
    });
  });

  test.each(['completed', 'failed', 'aborted'] as const)(
    'settles a dangling Tool when its persisted run is %s',
    state => {
      const clientTurnStartedAt = 1_787_885_461_166;
      const restartedAt = 1_787_886_368_411;
      const terminalAt = 1_787_886_386_462;
      const result = projectPersistedTimeline(
        [
          {
            role: 'user',
            content: 'prompt',
            timestamp: clientTurnStartedAt + 20,
          },
          {
            role: 'assistant',
            timestamp: clientTurnStartedAt + 589,
            content: [
              {
                type: 'toolCall',
                id: 'call-question-1',
                name: 'AskUserQuestion',
              },
            ],
          },
        ],
        [
          {
            id: 'timing-1',
            sessionId: 'session-1',
            clientTurnId: `justdo-${clientTurnStartedAt}-turn-id`,
            rootRunId: `justdo-${clientTurnStartedAt}-turn-id`,
            startedAt: restartedAt,
            endedAt: terminalAt,
            state,
          },
        ],
      );

      expect(result).toEqual([
        expect.objectContaining({ kind: 'history-message' }),
        expect.objectContaining({
          kind: 'process-summary',
          interruptedCount: 1,
          items: [
            expect.objectContaining({
              toolCallId: 'call-question-1',
              status: 'interrupted',
              updatedAt: terminalAt,
            }),
          ],
        }),
      ]);
      expect(result.some(item => item.kind === 'live-process')).toBe(false);
    },
  );

  test('does not associate a restarted receipt with a newer user turn', () => {
    const originalTurnStartedAt = 1_787_885_461_166;
    const restartedAt = 1_787_886_368_411;
    const result = projectPersistedTimeline(
      [
        {
          role: 'user',
          content: 'new prompt',
          timestamp: restartedAt + 20,
        },
        {
          role: 'assistant',
          timestamp: restartedAt + 589,
          content: [{ type: 'toolCall', id: 'call-new-1', name: 'read' }],
        },
      ],
      [
        {
          id: 'timing-old',
          sessionId: 'session-1',
          clientTurnId: `justdo-${originalTurnStartedAt}-turn-id`,
          rootRunId: `justdo-${originalTurnStartedAt}-turn-id`,
          startedAt: restartedAt,
          endedAt: restartedAt,
          state: 'aborted',
        },
      ],
    );

    expect(result).toEqual([
      expect.objectContaining({ kind: 'history-message' }),
      expect.objectContaining({
        kind: 'live-process',
        item: expect.objectContaining({ toolCallId: 'call-new-1', status: 'running' }),
      }),
    ]);
  });

  test('lets a nearby running receipt prevent an older turn from claiming its Tool', () => {
    const oldTurnStartedAt = 1_787_885_461_166;
    const activeTurnStartedAt = oldTurnStartedAt + 10_000;
    const result = projectPersistedTimeline(
      [
        {
          role: 'user',
          content: 'active prompt',
          timestamp: activeTurnStartedAt + 20,
        },
        {
          role: 'assistant',
          timestamp: activeTurnStartedAt + 589,
          content: [{ type: 'toolCall', id: 'call-active-1', name: 'read' }],
        },
      ],
      [
        {
          id: 'timing-old',
          sessionId: 'session-1',
          clientTurnId: `justdo-${oldTurnStartedAt}-old-id`,
          rootRunId: `justdo-${oldTurnStartedAt}-old-id`,
          startedAt: oldTurnStartedAt,
          endedAt: oldTurnStartedAt + 5_000,
          state: 'completed',
        },
        {
          id: 'timing-active',
          sessionId: 'session-1',
          clientTurnId: `justdo-${activeTurnStartedAt}-active-id`,
          rootRunId: `justdo-${activeTurnStartedAt}-active-id`,
          startedAt: activeTurnStartedAt,
          state: 'running',
        },
      ],
    );

    expect(result).toEqual([
      expect.objectContaining({ kind: 'history-message' }),
      expect.objectContaining({
        kind: 'live-process',
        item: expect.objectContaining({ toolCallId: 'call-active-1', status: 'running' }),
      }),
    ]);
  });

  test('does not let an older terminal receipt override a running receipt for the same root', () => {
    const result = projectPersistedTimeline(
      [
        {
          role: 'assistant',
          runId: 'shared-root',
          content: [{ type: 'toolCall', id: 'call-recovered-1', name: 'sessions_yield' }],
        },
      ],
      [
        {
          id: 'timing-checkpoint',
          sessionId: 'session-1',
          clientTurnId: 'shared-root',
          rootRunId: 'shared-root',
          startedAt: 1_000,
          endedAt: 1_000,
          state: 'aborted',
        },
        {
          id: 'timing-recovered',
          sessionId: 'session-1',
          clientTurnId: 'runtime-recovery-1',
          rootRunId: 'shared-root',
          startedAt: 2_000,
          state: 'running',
        },
      ],
    );

    expect(result).toEqual([
      expect.objectContaining({
        kind: 'live-process',
        item: expect.objectContaining({
          toolCallId: 'call-recovered-1',
          status: 'running',
        }),
      }),
    ]);
  });

  test('clears a fallback terminal association when the same Tool joins an active run', () => {
    const result = projectPersistedTimeline(
      [
        { role: 'user', content: 'old prompt', timestamp: 1_010 },
        {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call-recovered-1', name: 'sessions_yield' }],
        },
        {
          role: 'assistant',
          runId: 'active-root',
          content: [{ type: 'toolCall', id: 'call-recovered-1', name: 'sessions_yield' }],
        },
      ],
      [
        {
          id: 'timing-old',
          sessionId: 'session-1',
          clientTurnId: 'justdo-1000-old',
          rootRunId: 'old-root',
          startedAt: 1_000,
          endedAt: 1_500,
          state: 'aborted',
        },
        {
          id: 'timing-active',
          sessionId: 'session-1',
          clientTurnId: 'runtime-recovery-1',
          rootRunId: 'active-root',
          startedAt: 2_000,
          state: 'running',
        },
      ],
    );

    expect(result).toEqual([
      expect.objectContaining({ kind: 'history-message' }),
      expect.objectContaining({
        kind: 'live-process',
        item: expect.objectContaining({
          toolCallId: 'call-recovered-1',
          status: 'running',
        }),
      }),
    ]);
  });

  test('matches a persisted receipt by user timestamp when history omits run ids', () => {
    const result = projectPersistedTimeline(
      [
        { role: 'user', content: 'prompt', timestamp: 1_010 },
        { role: 'assistant', content: 'answer', timestamp: 4_000 },
        {
          role: 'assistant',
          content: 'subagent result',
          timestamp: 5_000,
          runId: 'announce:v1:child',
          provider: 'openclaw',
          model: 'gateway-injected',
        },
      ],
      [
        {
          id: 'timing-1',
          sessionId: 'session-1',
          clientTurnId: 'client-turn-1',
          rootRunId: 'gateway-run-1',
          startedAt: 1_000,
          endedAt: 6_000,
          state: 'completed',
        },
      ],
    );

    expect(result[1]).toEqual(expect.not.objectContaining({ durationMs: expect.any(Number) }));
    expect(result[2]).toMatchObject({ durationMs: 5_000, completedAt: 6_000 });
  });

  test('does not reuse an older prompt when a newer user timestamp is invalid', () => {
    const result = projectPersistedTimeline([
      { role: 'user', content: 'old prompt', timestamp: 1_000 },
      { role: 'assistant', content: 'old answer', timestamp: 2_000 },
      { role: 'user', content: 'new prompt' },
      { role: 'assistant', content: 'new answer', timestamp: 5_000 },
    ]);

    expect(result[3]).toEqual(
      expect.not.objectContaining({
        durationMs: expect.any(Number),
      }),
    );
  });

  test('does not attach a turn duration to gateway-injected assistant messages', () => {
    const result = projectPersistedTimeline([
      { role: 'user', content: 'prompt', timestamp: 1_000 },
      {
        role: 'assistant',
        content: 'internal status',
        timestamp: 2_000,
        provider: 'openclaw',
        model: 'gateway-injected',
      },
    ]);

    expect(result[1]).toEqual(
      expect.not.objectContaining({
        durationMs: expect.any(Number),
      }),
    );
  });

  test('restores every valid update_plan call as a standalone timeline item', () => {
    const result = projectPersistedTimeline([
      {
        role: 'assistant',
        id: 'assistant-1',
        content: [
          { type: 'thinking', thinking: 'planning' },
          {
            type: 'tool_use',
            id: 'plan-1',
            name: 'update_plan',
            input: { plan: [{ step: 'Inspect', status: 'completed' }] },
          },
          { type: 'tool_use', id: 'read-1', name: 'read', input: { path: 'README.md' } },
          {
            type: 'tool_use',
            id: 'plan-2',
            name: 'update_plan',
            input: {
              plan: [
                { step: 'Inspect', status: 'completed' },
                { step: 'Implement', status: 'in_progress' },
              ],
            },
          },
        ],
      },
    ]);

    expect(result.map(item => item.kind)).toEqual([
      'process-summary',
      'plan-update',
      'live-process',
      'plan-update',
    ]);
    expect(result.filter(item => item.kind === 'plan-update')).toHaveLength(2);
  });

  test('keeps a failed persisted Tool only inside its process summary', () => {
    const result = projectPersistedTimeline([
      {
        role: 'assistant',
        id: 'assistant-1',
        content: [
          { type: 'toolcall', toolCallId: 'call-1', name: 'run_tests' },
          {
            type: 'toolresult',
            toolCallId: 'call-1',
            isError: true,
            text: 'Process exited with code 1',
          },
        ],
      },
    ]);

    expect(result.map(item => item.kind)).toEqual(['process-summary']);
    expect(result[0]).toMatchObject({ toolCount: 1, errorCount: 1 });
    expect(result[0]).toMatchObject({
      items: [{ status: 'failed', output: 'Process exited with code 1' }],
    });
  });

  test('keeps result-before-start and object Tool output inspectable', () => {
    const result = projectPersistedTimeline([
      {
        role: 'assistant',
        id: 'assistant-1',
        content: [
          {
            type: 'toolresult',
            toolCallId: 'call-1',
            name: 'inspect',
            output: { ok: true, count: 2 },
          },
        ],
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: 'process-summary',
      toolCount: 1,
      items: [
        {
          name: 'inspect',
          output: '{\n  "ok": true,\n  "count": 2\n}',
          status: 'completed',
        },
      ],
    });
  });

  test('joins an OpenClaw toolResult message with array content to its Tool call', () => {
    const result = projectPersistedTimeline([
      {
        role: 'assistant',
        id: 'assistant-1',
        content: [
          {
            type: 'toolCall',
            id: 'call-1',
            name: 'exec',
            arguments: { command: 'npm test' },
          },
        ],
      },
      {
        role: 'toolResult',
        id: 'result-1',
        toolCallId: 'call-1',
        toolName: 'exec',
        content: [{ type: 'text', text: '761 tests passed' }],
        isError: false,
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: 'process-summary',
      toolCount: 1,
      items: [
        {
          toolCallId: 'call-1',
          name: 'exec',
          input: { command: 'npm test' },
          output: '761 tests passed',
          status: 'completed',
        },
      ],
    });
  });

  test('keeps a persisted sessions_yield running until a non-empty result is available', () => {
    const dangling = projectPersistedTimeline([
      {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'call-yield-1',
            name: 'sessions_yield',
            arguments: { message: 'wait' },
          },
        ],
      },
      {
        role: 'toolResult',
        toolCallId: 'call-yield-1',
        toolName: 'sessions_yield',
        content: [],
      },
    ]);
    const waitingItem = dangling.find(item => item.kind === 'live-process');
    const waitingTool =
      waitingItem?.kind === 'live-process' && waitingItem.item.type === 'tool'
        ? waitingItem.item
        : undefined;

    expect(dangling.map(item => item.kind)).toEqual(['live-process']);
    expect(waitingTool).toMatchObject({
      type: 'tool',
      toolCallId: 'call-yield-1',
      status: 'running',
    });
    expect(waitingTool?.output).toBeUndefined();

    const completed = projectPersistedTimeline([
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-yield-1', name: 'sessions_yield' }],
      },
      {
        role: 'toolResult',
        toolCallId: 'call-yield-1',
        toolName: 'sessions_yield',
        content: [{ type: 'text', text: '{"status":"partial","pending":4}' }],
      },
    ]);
    const completedTools = completed.flatMap(item =>
      item.kind === 'process-summary' ? item.items.filter(entry => entry.type === 'tool') : [],
    );

    expect(completedTools).toHaveLength(1);
    expect(completedTools[0]).toMatchObject({
      toolCallId: 'call-yield-1',
      status: 'completed',
      output: '{"status":"partial","pending":4}',
    });

    const cancelled = projectPersistedTimeline([
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-yield-1', name: 'sessions_yield' }],
      },
      {
        role: 'toolResult',
        toolCallId: 'call-yield-1',
        toolName: 'sessions_yield',
        status: 'cancelled',
        content: [],
      },
    ]);
    const cancelledTool = cancelled
      .flatMap(item => (item.kind === 'process-summary' ? item.items : []))
      .find(item => item.type === 'tool');

    expect(cancelledTool).toMatchObject({
      toolCallId: 'call-yield-1',
      status: 'cancelled',
    });
  });

  test('does not fold a waiting sessions_yield when an announce message arrives behind it', () => {
    const waitingMessages = [
      {
        role: 'assistant',
        runId: 'parent-run',
        content: [
          { type: 'thinking', thinking: 'Waiting for the worker.' },
          {
            type: 'toolCall',
            id: 'call-yield-1',
            name: 'sessions_yield',
            arguments: { message: '等待 subagent' },
          },
        ],
      },
      {
        role: 'toolResult',
        runId: 'parent-run',
        toolCallId: 'call-yield-1',
        toolName: 'sessions_yield',
        content: [],
      },
      {
        role: 'assistant',
        runId: 'announce:v1:agent:main:subagent:child-run',
        content: [{ type: 'text', text: 'Subagent progress arrived.' }],
      },
    ];
    const result = projectPersistedTimeline(waitingMessages);

    expect(result.map(item => item.kind)).toEqual([
      'process-summary',
      'live-process',
      'history-message',
    ]);
    expect(result[0]).toMatchObject({
      kind: 'process-summary',
      thinkingCount: 1,
      toolCount: 0,
    });
    expect(result[1]).toMatchObject({
      kind: 'live-process',
      item: {
        type: 'tool',
        name: 'sessions_yield',
        status: 'running',
      },
    });

    const continued = projectPersistedTimeline([
      ...waitingMessages,
      {
        role: 'assistant',
        runId: 'parent-run',
        content: [
          {
            type: 'toolCall',
            id: 'call-read-1',
            name: 'read',
            arguments: { path: 'result.txt' },
          },
        ],
      },
    ]);
    const runningToolIds = continued.flatMap(item =>
      item.kind === 'live-process' && item.item.type === 'tool' ? [item.item.toolCallId] : [],
    );

    expect(runningToolIds).toEqual(['call-yield-1', 'call-read-1']);

    const completedResult = JSON.stringify({
      status: 'completed',
      pending: 0,
      results: [{ status: 'ok' }],
    });
    const refreshed = projectPersistedTimeline([
      waitingMessages[0],
      {
        role: 'toolResult',
        runId: 'parent-run',
        toolCallId: 'call-yield-1',
        toolName: 'sessions_yield',
        content: [{ type: 'text', text: completedResult }],
      },
      waitingMessages[2],
      {
        role: 'assistant',
        runId: 'parent-run',
        content: [
          { type: 'thinking', thinking: 'Continue after the worker finished.' },
          {
            type: 'toolCall',
            id: 'call-read-1',
            name: 'read',
            arguments: { path: 'result.txt' },
          },
        ],
      },
      {
        role: 'toolResult',
        runId: 'parent-run',
        toolCallId: 'call-read-1',
        toolName: 'read',
        content: [{ type: 'text', text: 'worker result' }],
      },
    ]);
    const refreshedTools = refreshed.flatMap(item =>
      item.kind === 'process-summary' ? item.items.filter(process => process.type === 'tool') : [],
    );

    expect(refreshed.some(item => item.kind === 'live-process')).toBe(false);
    expect(refreshedTools).toMatchObject([
      {
        toolCallId: 'call-yield-1',
        name: 'sessions_yield',
        status: 'completed',
        output: completedResult,
      },
      {
        toolCallId: 'call-read-1',
        name: 'read',
        status: 'completed',
        output: 'worker result',
      },
    ]);
  });

  test('recovers sessions_yield arguments from a standalone result before history patching', () => {
    const output = JSON.stringify({
      status: 'completed',
      message: '等待 subagent 2（news_finance）完成调研后继续。',
      pending: 0,
      results: [{ status: 'ok' }],
    });
    const result = projectPersistedTimeline([
      {
        role: 'toolResult',
        toolCallId: 'call-yield-1',
        toolName: 'sessions_yield',
        content: [{ type: 'text', text: output }],
      },
    ]);
    const tools = result.flatMap(item =>
      item.kind === 'process-summary' ? item.items.filter(entry => entry.type === 'tool') : [],
    );

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      toolCallId: 'call-yield-1',
      status: 'completed',
      input: { message: '等待 subagent 2（news_finance）完成调研后继续。' },
      output,
    });
  });

  test('does not replace persisted sessions_yield arguments with a result status message', () => {
    const result = projectPersistedTimeline([
      {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'call-yield-1',
            name: 'sessions_yield',
            arguments: { message: '等待 subagent 2 完成。' },
          },
        ],
      },
      {
        role: 'toolResult',
        toolCallId: 'call-yield-1',
        toolName: 'sessions_yield',
        content: [
          {
            type: 'text',
            text: '{"status":"already_waiting","message":"A sessions_yield call is already waiting."}',
          },
        ],
      },
    ]);
    const tool = result
      .flatMap(item => (item.kind === 'process-summary' ? item.items : []))
      .find(entry => entry.type === 'tool');

    expect(tool).toMatchObject({
      toolCallId: 'call-yield-1',
      input: { message: '等待 subagent 2 完成。' },
    });
  });

  test('keeps an array-content OpenClaw Tool failure visible with updated summary state', () => {
    const result = projectPersistedTimeline([
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call-1', name: 'exec', arguments: {} }],
      },
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'exec',
        content: [{ type: 'text', text: 'Process exited with code 1' }],
        isError: true,
      },
    ]);

    expect(result.map(item => item.kind)).toEqual(['process-summary']);
    expect(result[0]).toMatchObject({
      errorCount: 1,
      items: [{ status: 'failed', output: 'Process exited with code 1' }],
    });
  });

  test('hydrates an enveloped Tool call with partialArgs before a standalone result', () => {
    const result = projectPersistedTimeline([
      {
        type: 'message',
        id: 'assistant-envelope',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'cleaning up' },
            {
              type: 'toolCall',
              id: 'call-1',
              name: 'exec',
              arguments: {},
              partialArgs: '{"command":"Remove-Item tmp.js","timeout":5}',
            },
          ],
        },
      } as unknown as never,
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'nearby text' }],
      },
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'exec',
        content: [{ type: 'text', text: '(no output)' }],
      },
    ]);

    const summary = result.find(item => item.kind === 'process-summary');
    expect(summary).toMatchObject({
      items: [
        {
          toolCallId: 'call-1',
          input: { command: 'Remove-Item tmp.js', timeout: 5 },
          output: '(no output)',
        },
      ],
    });
  });

  test('hydrates standalone tool_use metadata and its result', () => {
    const result = projectPersistedTimeline([
      {
        role: 'tool_use',
        toolCallId: 'call-1',
        metadata: {
          toolUseId: 'call-1',
          toolName: 'Read',
          toolInput: { file_path: 'README.md' },
        },
        content: 'Read',
      },
      {
        role: 'tool_result',
        tool_call_id: 'call-1',
        metadata: { toolUseId: 'call-1', toolName: 'Read' },
        content: 'ok',
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: 'process-summary',
      items: [
        {
          name: 'Read',
          input: { file_path: 'README.md' },
          output: 'ok',
        },
      ],
    });
  });

  test('preserves an authoritative run ID for live-to-history summary correlation', () => {
    const result = projectPersistedTimeline([
      {
        role: 'assistant',
        runId: 'run-shared',
        content: [
          { type: 'thinking', thinking: 'working' },
          { type: 'toolCall', id: 'call-1', name: 'Read', arguments: {} },
        ],
      },
    ]);

    expect(result).toEqual([
      expect.objectContaining({
        kind: 'process-summary',
        runId: 'run-shared',
        items: [expect.objectContaining({ type: 'thinking', runId: 'run-shared' })],
      }),
      expect.objectContaining({
        kind: 'live-process',
        item: expect.objectContaining({
          type: 'tool',
          runId: 'run-shared',
          toolCallId: 'call-1',
        }),
      }),
    ]);
  });

  test('merges attached Tool call and empty result compatibility messages', () => {
    const result = projectPersistedTimeline([
      {
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'working' }],
        __justdoAttachedToolMessages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'toolcall',
                toolCallId: 'call-1',
                name: 'exec',
                arguments: { command: 'npm test' },
              },
              {
                type: 'toolresult',
                toolCallId: 'call-1',
                name: 'exec',
                text: '',
              },
            ],
          },
        ],
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: 'process-summary',
      thinkingCount: 1,
      toolCount: 1,
      items: [
        { type: 'thinking' },
        {
          type: 'tool',
          input: { command: 'npm test' },
          output: '',
          status: 'completed',
        },
      ],
    });
  });

  test('matches a result without an id to the first unmatched Tool with the same name', () => {
    const result = projectPersistedTimeline([
      {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'call-1',
            name: 'Read',
            arguments: { file_path: 'README.md' },
          },
          {
            type: 'toolResult',
            name: 'Read',
            text: 'contents',
          },
        ],
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: 'process-summary',
      toolCount: 1,
      items: [
        {
          toolCallId: 'call-1',
          input: { file_path: 'README.md' },
          output: 'contents',
        },
      ],
    });
  });
});
