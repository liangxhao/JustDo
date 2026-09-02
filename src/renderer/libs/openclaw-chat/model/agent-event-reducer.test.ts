import type { NormalizedAgentEvent, NormalizedChatEvent } from '@shared/openclaw/agentEvent';
import { beforeEach, describe, expect, test } from 'vitest';

import { reduceAgentEvent, reduceChatEvent } from './agent-event-reducer';
import {
  beginAssistantTurn,
  createChatTranscriptState,
  type TranscriptReducerDependencies,
} from './chat-transcript-state';
import { projectTurnItems } from './project-turn-items';

let now = 100;
let id = 0;
let dependencies: TranscriptReducerDependencies;

beforeEach(() => {
  now = 100;
  id = 0;
  dependencies = {
    now: () => now,
    createId: prefix => `${prefix}-${++id}`,
  };
});

function agent(
  seq: number,
  stream: string,
  data: Record<string, unknown>,
  overrides: Partial<NormalizedAgentEvent> = {},
): NormalizedAgentEvent {
  return {
    runId: 'run-1',
    sessionKey: 'session-1',
    sessionId: 'sid-1',
    lifecycleGeneration: 'life-1',
    agentId: 'main',
    spawnedBy: null,
    agentSeq: seq,
    frameSeq: seq + 20,
    deliveryEvent: 'agent',
    stream,
    timestamp: now + seq,
    data,
    ...overrides,
  };
}

function chat(
  state: NormalizedChatEvent['state'],
  overrides: Partial<NormalizedChatEvent> = {},
): NormalizedChatEvent {
  return {
    runId: 'run-1',
    sessionKey: 'session-1',
    sessionId: 'sid-1',
    lifecycleGeneration: 'life-1',
    frameSeq: 80,
    state,
    replace: false,
    ...overrides,
  };
}

describe('agent event reducer', () => {
  test('accepts the v2026.8 thinking snapshot field', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');

    expect(
      reduceAgentEvent(state, agent(1, 'thinking', { thinking: 'inspect the workspace' }), dependencies),
    ).toBe('applied');
    expect(state.activeTurn?.items).toMatchObject([
      { type: 'thinking', status: 'running', text: 'inspect the workspace' },
    ]);
  });

  test('advances ordering across new non-display streams', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');

    expect(
      reduceAgentEvent(
        state,
        agent(1, 'run_status', { phase: 'preparing_workspace' }),
        dependencies,
      ),
    ).toBe('applied');
    expect(reduceAgentEvent(state, agent(2, 'assistant', { text: 'ready' }), dependencies)).toBe(
      'applied',
    );
    expect(state.activeTurn?.lastAgentSeq).toBe(2);
    expect(state.activeTurn?.items).toMatchObject([{ type: 'content', text: 'ready' }]);
  });

  test('accepts only documented managed-session aliases, not arbitrary suffixes', () => {
    const state = createChatTranscriptState('agent:main:justdo:session-1', 'sid-1');

    expect(
      reduceAgentEvent(
        state,
        agent(1, 'thinking', { text: 'accepted' }, { sessionKey: 'justdo:session-1' }),
        dependencies,
      ),
    ).toBe('applied');
    expect(
      reduceAgentEvent(
        state,
        agent(2, 'thinking', { text: 'wrong' }, { sessionKey: 'other-session-1' }),
        dependencies,
      ),
    ).toBe('ignored-session');
    expect(state.activeTurn?.items[0]).toMatchObject({ text: 'accepted' });
  });

  test('preserves Thinking -> Tool -> Content chronology and accepts sequence gaps', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');

    expect(reduceAgentEvent(state, agent(2, 'thinking', { text: 'plan' }), dependencies)).toBe(
      'applied',
    );
    expect(
      reduceAgentEvent(
        state,
        agent(9, 'tool', { phase: 'start', toolCallId: 'call-1', name: 'read' }),
        dependencies,
      ),
    ).toBe('applied');
    reduceAgentEvent(
      state,
      agent(12, 'tool', { phase: 'result', toolCallId: 'call-1', result: 'ok' }),
      dependencies,
    );
    reduceAgentEvent(state, agent(20, 'assistant', { text: 'done' }), dependencies);

    expect(state.activeTurn?.items.map(item => `${item.type}:${item.status}`)).toEqual([
      'thinking:completed',
      'tool:completed',
      'content:streaming',
    ]);
  });

  test('backfills missing activity owners without rewinding newer live content', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');

    reduceAgentEvent(state, agent(4, 'assistant', { text: 'newer live answer' }), dependencies);
    expect(
      reduceAgentEvent(
        state,
        agent(1, 'thinking', { thinking: 'recovered reasoning' }),
        dependencies,
        { allowSequenceBackfill: true },
      ),
    ).toBe('applied');
    expect(
      reduceAgentEvent(
        state,
        agent(2, 'tool', {
          phase: 'start',
          toolCallId: 'call-recovered',
          name: 'read',
          args: { path: 'README.md' },
        }),
        dependencies,
        { allowSequenceBackfill: true },
      ),
    ).toBe('applied');
    expect(
      reduceAgentEvent(
        state,
        agent(3, 'tool', {
          phase: 'update',
          toolCallId: 'call-recovered',
          name: 'read',
          partialResult: 'halfway',
        }),
        dependencies,
        { allowSequenceBackfill: true },
      ),
    ).toBe('applied');

    expect(state.activeTurn?.lastAgentSeq).toBe(4);
    expect(state.activeTurn?.items).toMatchObject([
      { type: 'thinking', status: 'completed', text: 'recovered reasoning' },
      { type: 'tool', status: 'running', toolCallId: 'call-recovered', output: 'halfway' },
      { type: 'content', status: 'streaming', text: 'newer live answer' },
    ]);
  });

  test('keeps a terminal tool owner tombstoned against an older replay snapshot', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');

    reduceAgentEvent(
      state,
      agent(6, 'tool', {
        phase: 'result',
        toolCallId: 'call-1',
        name: 'read',
        result: 'final output',
      }),
      dependencies,
    );

    expect(
      reduceAgentEvent(
        state,
        agent(2, 'tool', {
          phase: 'start',
          toolCallId: 'call-1',
          name: 'read',
          args: { path: 'stale.md' },
        }),
        dependencies,
        { allowSequenceBackfill: true },
      ),
    ).toBe('ignored-sequence');
    expect(state.activeTurn?.toolById.get('call-1')).toMatchObject({
      status: 'completed',
      output: 'final output',
    });
  });

  test('does not split streamed Content when an empty Thinking snapshot arrives', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');

    reduceAgentEvent(state, agent(1, 'thinking', { text: '先分析问题' }), dependencies);
    reduceAgentEvent(state, agent(2, 'assistant', { delta: '我可以' }), dependencies);
    reduceAgentEvent(state, agent(3, 'thinking', { text: '' }), dependencies);
    reduceAgentEvent(
      state,
      agent(4, 'assistant', { delta: '尝试直接启动 Chrome 浏览器。' }),
      dependencies,
    );

    expect(state.activeTurn?.items).toMatchObject([
      { type: 'thinking', status: 'completed', text: '先分析问题' },
      {
        type: 'content',
        status: 'streaming',
        text: '我可以尝试直接启动 Chrome 浏览器。',
      },
    ]);
  });

  test('does not split cumulative Content snapshots on an empty Thinking frame', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');

    reduceAgentEvent(state, agent(1, 'thinking', { text: '先分析问题' }), dependencies);
    reduceAgentEvent(state, agent(2, 'assistant', { text: '我可以' }), dependencies);
    reduceAgentEvent(state, agent(3, 'thinking', { text: '', replace: true }), dependencies);
    reduceAgentEvent(
      state,
      agent(4, 'assistant', { text: '我可以尝试直接启动 Chrome 浏览器。' }),
      dependencies,
    );

    expect(state.activeTurn?.items.map(item => item.type)).toEqual(['thinking', 'content']);
    expect(state.activeTurn?.items[1]).toMatchObject({
      type: 'content',
      text: '我可以尝试直接启动 Chrome 浏览器。',
    });
  });

  test('preserves whitespace deltas only inside an existing visible stream', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');

    reduceAgentEvent(state, agent(1, 'thinking', { delta: '' }), dependencies);
    reduceAgentEvent(state, agent(2, 'thinking', { delta: 'Reasoning' }), dependencies);
    reduceAgentEvent(state, agent(3, 'thinking', { delta: ' ' }), dependencies);
    reduceAgentEvent(state, agent(4, 'thinking', { delta: 'continues' }), dependencies);
    reduceAgentEvent(state, agent(5, 'assistant', { delta: '' }), dependencies);

    expect(state.activeTurn?.items).toMatchObject([
      { type: 'thinking', status: 'running', text: 'Reasoning continues' },
    ]);
  });

  test('uses the authoritative cumulative Thinking snapshot across an empty Content frame', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    const thinking = 'I should describe what the screenshot shows clearly';

    reduceAgentEvent(
      state,
      agent(1, 'thinking', {
        text: thinking,
        delta: thinking,
        isReasoningSnapshot: true,
      }),
      dependencies,
    );
    reduceAgentEvent(state, agent(2, 'assistant', { text: '', delta: '' }), dependencies);
    reduceAgentEvent(
      state,
      agent(3, 'thinking', {
        text: `${thinking}.`,
        delta: '.',
        isReasoningSnapshot: true,
      }),
      dependencies,
    );
    reduceChatEvent(state, chat('final'), dependencies);

    expect(state.activeTurn?.items).toMatchObject([
      { type: 'thinking', status: 'completed', text: `${thinking}.` },
    ]);
    expect(projectTurnItems(state.activeTurn)).toMatchObject([
      {
        kind: 'process-summary',
        thinkingCount: 1,
        items: [{ type: 'thinking', text: `${thinking}.` }],
      },
    ]);
  });

  test('uses a non-empty delta when an OpenClaw commentary snapshot is blank', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');

    reduceAgentEvent(
      state,
      agent(1, 'assistant', { text: '', delta: 'commentary chunk', phase: 'commentary' }),
      dependencies,
    );
    reduceAgentEvent(
      state,
      agent(2, 'assistant', { text: '', delta: ' continues', phase: 'commentary' }),
      dependencies,
    );

    expect(state.activeTurn?.items).toMatchObject([
      {
        type: 'content',
        status: 'streaming',
        text: 'commentary chunk continues',
        sourceMode: 'delta',
      },
    ]);
  });

  test('treats a non-prefix Thinking snapshot as an authoritative revision', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');

    reduceAgentEvent(
      state,
      agent(1, 'thinking', {
        text: 'rough draft',
        delta: 'rough draft',
        isReasoningSnapshot: true,
      }),
      dependencies,
    );
    reduceAgentEvent(
      state,
      agent(2, 'thinking', { text: '.', delta: '.', isReasoningSnapshot: true }),
      dependencies,
    );

    expect(state.activeTurn?.items).toMatchObject([
      { type: 'thinking', status: 'running', text: '.' },
    ]);
  });

  test('rolls back rejected managed-terminal content and commits the accepted revision', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    const observation = (token: string, action: 'update' | 'commit' | 'rollback') => ({
      justdoTerminalGuardObservation: { token, action },
    });

    reduceAgentEvent(
      state,
      agent(1, 'assistant', {
        text: 'Candidate before tool',
        ...observation('candidate-1', 'update'),
      }),
      dependencies,
    );
    reduceAgentEvent(
      state,
      agent(2, 'tool', { phase: 'start', toolCallId: 'call-1', name: 'read' }),
      dependencies,
    );
    reduceAgentEvent(
      state,
      agent(3, 'tool', { phase: 'result', toolCallId: 'call-1', result: 'ok' }),
      dependencies,
    );
    reduceAgentEvent(
      state,
      agent(4, 'assistant', { text: 'Rejected final', ...observation('candidate-1', 'update') }),
      dependencies,
    );

    expect(
      state.activeTurn?.items
        .filter(item => item.type === 'content')
        .map(item => [item.text, item.terminalGuardObservationToken]),
    ).toEqual([
      ['Candidate before tool', 'candidate-1'],
      ['Rejected final', 'candidate-1'],
    ]);

    reduceAgentEvent(
      state,
      agent(5, 'assistant', observation('candidate-1', 'rollback')),
      dependencies,
    );
    expect(state.activeTurn?.items.map(item => item.type)).toEqual(['tool']);

    reduceAgentEvent(
      state,
      agent(6, 'assistant', { text: 'Accepted revision', ...observation('candidate-2', 'update') }),
      dependencies,
    );
    reduceAgentEvent(
      state,
      agent(7, 'assistant', observation('candidate-2', 'commit')),
      dependencies,
    );
    expect(state.activeTurn?.items.slice(-1)[0]).toMatchObject({
      type: 'content',
      text: 'Accepted revision',
    });
    expect(
      state.activeTurn?.items.find(item => item.type === 'content')?.terminalGuardObservationToken,
    ).toBeUndefined();
  });

  test('keeps cumulative chat snapshots from duplicating content across a tool boundary', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');

    reduceAgentEvent(state, agent(1, 'assistant', { text: 'Before tool call' }), dependencies);
    reduceAgentEvent(
      state,
      agent(2, 'tool', { phase: 'start', toolCallId: 'call-1', name: 'read' }),
      dependencies,
    );
    reduceAgentEvent(
      state,
      agent(3, 'tool', { phase: 'result', toolCallId: 'call-1', result: 'ok' }),
      dependencies,
    );
    reduceAgentEvent(state, agent(4, 'assistant', { text: 'After tool call' }), dependencies);

    expect(
      reduceChatEvent(
        state,
        chat('delta', {
          message: { role: 'assistant', content: 'Before tool call\nAfter tool call' },
          deltaText: '\nAfter tool call',
        }),
        dependencies,
      ),
    ).toBe('applied');
    expect(
      reduceChatEvent(
        state,
        chat('final', {
          message: { role: 'assistant', content: 'Before tool call\nAfter tool call' },
        }),
        dependencies,
      ),
    ).toBe('applied');

    expect(
      state.activeTurn?.items.filter(item => item.type === 'content').map(item => item.text),
    ).toEqual(['Before tool call', 'After tool call']);
  });

  test('does not truncate a repeated content segment after a tool boundary', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');

    reduceAgentEvent(state, agent(1, 'assistant', { text: 'Repeat' }), dependencies);
    reduceAgentEvent(
      state,
      agent(2, 'tool', { phase: 'result', toolCallId: 'call-1', result: 'ok' }),
      dependencies,
    );
    reduceAgentEvent(state, agent(3, 'assistant', { text: 'Repeat' }), dependencies);
    reduceChatEvent(
      state,
      chat('final', { message: { role: 'assistant', content: 'Repeat' } }),
      dependencies,
    );

    expect(
      state.activeTurn?.items.filter(item => item.type === 'content').map(item => item.text),
    ).toEqual(['Repeat', 'Repeat']);
  });

  test('keeps a current-only final when it extends the prior segment prefix', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');

    reduceAgentEvent(state, agent(1, 'assistant', { text: 'Plan' }), dependencies);
    reduceAgentEvent(
      state,
      agent(2, 'tool', { phase: 'result', toolCallId: 'call-1', result: 'ok' }),
      dependencies,
    );
    reduceAgentEvent(state, agent(3, 'assistant', { text: 'Plan B' }), dependencies);
    reduceChatEvent(
      state,
      chat('final', { message: { role: 'assistant', content: 'Plan B' } }),
      dependencies,
    );

    expect(
      state.activeTurn?.items.filter(item => item.type === 'content').map(item => item.text),
    ).toEqual(['Plan', 'Plan B']);
  });

  test('deduplicates alternate delivery and never lets older snapshots shorten content', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    reduceAgentEvent(state, agent(1, 'assistant', { text: 'complete' }), dependencies);

    expect(
      reduceAgentEvent(
        state,
        agent(1, 'assistant', { text: 'short' }, { deliveryEvent: 'session.tool' }),
        dependencies,
      ),
    ).toBe('ignored-sequence');
    expect(state.activeTurn?.items[0]).toMatchObject({ text: 'complete' });
  });

  test('keeps a result with a missing name and creates a missing start', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    reduceAgentEvent(
      state,
      agent(1, 'tool', { phase: 'result', toolCallId: 'call-1', result: 'ok' }),
      dependencies,
    );

    expect(state.activeTurn?.items[0]).toMatchObject({
      type: 'tool',
      name: 'tool',
      status: 'completed',
      output: 'ok',
    });
  });

  test('keeps an outputless sessions_yield result running on the original Tool item', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    reduceAgentEvent(
      state,
      agent(1, 'tool', {
        phase: 'start',
        toolCallId: 'call-yield-1',
        name: 'sessions_yield',
      }),
      dependencies,
    );
    const original = state.activeTurn?.toolById.get('call-yield-1');

    reduceAgentEvent(
      state,
      agent(2, 'tool', {
        phase: 'result',
        toolCallId: 'call-yield-1',
        name: 'sessions_yield',
      }),
      dependencies,
    );

    expect(state.activeTurn?.items).toHaveLength(1);
    expect(state.activeTurn?.toolById.get('call-yield-1')).toBe(original);
    expect(original).toMatchObject({ status: 'running' });
    expect(original?.output).toBeUndefined();
  });

  test('does not complete an outputless sessions_yield when chat.final arrives', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    reduceAgentEvent(
      state,
      agent(1, 'tool', {
        phase: 'start',
        toolCallId: 'call-yield-1',
        name: 'sessions_yield',
      }),
      dependencies,
    );
    reduceChatEvent(state, chat('final'), dependencies);

    expect(state.activeTurn?.toolById.get('call-yield-1')).toMatchObject({
      status: 'running',
    });
  });

  test('preserves distinct incremental sessions_yield calls instead of deduplicating by name', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    reduceAgentEvent(
      state,
      agent(1, 'tool', {
        phase: 'start',
        toolCallId: 'call-yield-1',
        name: 'sessions_yield',
      }),
      dependencies,
    );
    reduceAgentEvent(
      state,
      agent(2, 'tool', {
        phase: 'result',
        toolCallId: 'call-yield-1',
        name: 'sessions_yield',
        result: '{"status":"partial","pending":1}',
      }),
      dependencies,
    );
    reduceAgentEvent(
      state,
      agent(3, 'tool', {
        phase: 'start',
        toolCallId: 'call-yield-2',
        name: 'sessions_yield',
      }),
      dependencies,
    );

    expect(state.activeTurn?.items).toHaveLength(2);
    expect([...state.activeTurn!.toolById.keys()]).toEqual(['call-yield-1', 'call-yield-2']);
    expect(state.activeTurn?.toolById.get('call-yield-1')).toMatchObject({
      status: 'completed',
    });
    expect(state.activeTurn?.toolById.get('call-yield-2')).toMatchObject({ status: 'running' });
  });

  test('completes sessions_yield when an empty terminal frame follows partial output', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    reduceAgentEvent(
      state,
      agent(1, 'tool', {
        phase: 'start',
        toolCallId: 'call-yield-1',
        name: 'sessions_yield',
      }),
      dependencies,
    );
    reduceAgentEvent(
      state,
      agent(2, 'tool', {
        phase: 'update',
        toolCallId: 'call-yield-1',
        name: 'sessions_yield',
        partialResult: '{"status":"partial","pending":1}',
      }),
      dependencies,
    );
    reduceAgentEvent(
      state,
      agent(3, 'tool', {
        phase: 'result',
        toolCallId: 'call-yield-1',
        name: 'sessions_yield',
      }),
      dependencies,
    );

    expect(state.activeTurn?.items).toHaveLength(1);
    expect(state.activeTurn?.toolById.get('call-yield-1')).toMatchObject({
      status: 'completed',
      output: '{"status":"partial","pending":1}',
    });
  });

  test('preserves sessions_yield input when the terminal event only carries the result', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    reduceAgentEvent(
      state,
      agent(1, 'tool', {
        phase: 'start',
        toolCallId: 'call-yield-1',
        name: 'sessions_yield',
        arguments: { message: '等待 subagent 2 完成。' },
      }),
      dependencies,
    );
    const original = state.activeTurn?.toolById.get('call-yield-1');
    reduceAgentEvent(
      state,
      agent(2, 'tool', {
        phase: 'result',
        toolCallId: 'call-yield-1',
        name: 'sessions_yield',
        result: '{"status":"aborted","message":"Subagent join was stopped.","pending":0}',
      }),
      dependencies,
    );

    expect(state.activeTurn?.items).toHaveLength(1);
    expect(state.activeTurn?.toolById.get('call-yield-1')).toBe(original);
    expect(original).toMatchObject({
      status: 'completed',
      input: { message: '等待 subagent 2 完成。' },
    });
  });

  test('accepts legacy Tool id/input aliases and structured errors incrementally', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');

    expect(
      reduceAgentEvent(
        state,
        agent(1, 'tool', {
          phase: 'start',
          toolUseId: 'call-1',
          toolName: 'exec',
          arguments: {},
          partialArgs: '{"command":"npm test","timeout":5}',
        }),
        dependencies,
      ),
    ).toBe('applied');
    expect(
      reduceAgentEvent(
        state,
        agent(2, 'tool', {
          phase: 'result',
          tool_use_id: 'call-1',
          output: '{"error":"permission denied"}',
        }),
        dependencies,
      ),
    ).toBe('applied');

    expect(state.activeTurn?.items[0]).toMatchObject({
      type: 'tool',
      toolCallId: 'call-1',
      name: 'exec',
      input: { command: 'npm test', timeout: 5 },
      output: '{"error":"permission denied"}',
      status: 'failed',
    });
  });

  test('preserves partial state on abort and tombstones the run', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    reduceAgentEvent(state, agent(1, 'thinking', { text: 'working' }), dependencies);
    reduceAgentEvent(
      state,
      agent(2, 'tool', { phase: 'start', toolCallId: 'call-1', name: 'run' }),
      dependencies,
    );

    expect(reduceChatEvent(state, chat('aborted'), dependencies)).toBe('applied');
    expect(state.activeTurn?.items.map(item => `${item.type}:${item.status}`)).toEqual([
      'thinking:completed',
      'tool:cancelled',
      'terminal:aborted',
    ]);
    expect(reduceAgentEvent(state, agent(3, 'assistant', { text: 'late' }), dependencies)).toBe(
      'ignored-run',
    );
  });

  test('rejects a rotated session id and an unrelated active run', () => {
    const state = createChatTranscriptState('session-1', 'sid-new');
    beginAssistantTurn(
      state,
      { runId: 'run-current', sessionId: 'sid-new', lifecycleGeneration: 'life-2' },
      dependencies,
    );

    expect(
      reduceAgentEvent(
        state,
        agent(1, 'thinking', { text: 'stale' }, { sessionId: 'sid-old' }),
        dependencies,
      ),
    ).toBe('ignored-session');
    expect(
      reduceAgentEvent(
        state,
        agent(1, 'thinking', { text: 'other' }, { runId: 'run-other', sessionId: 'sid-new' }),
        dependencies,
      ),
    ).toBe('ignored-run');
  });

  test('binds a provisional send id to the first authoritative run', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    beginAssistantTurn(state, { runId: 'justdo-local' }, dependencies);

    expect(reduceAgentEvent(state, agent(1, 'thinking', { text: 'bound' }), dependencies)).toBe(
      'applied',
    );
    expect(state.activeTurn?.runId).toBe('run-1');
  });

  test('backfills compatible session identity when joining a run mid-stream', () => {
    const state = createChatTranscriptState('session-1');
    reduceAgentEvent(
      state,
      agent(
        1,
        'thinking',
        { text: 'attached' },
        {
          sessionId: null,
          lifecycleGeneration: null,
        },
      ),
      dependencies,
    );

    expect(reduceAgentEvent(state, agent(2, 'assistant', { text: 'bound' }), dependencies)).toBe(
      'applied',
    );
    expect(state.activeTurn).toMatchObject({
      sessionId: 'sid-1',
      lifecycleGeneration: 'life-1',
    });
  });

  test('admits matching subagent events when the selected transcript has no active run', () => {
    const state = createChatTranscriptState('agent:main:subagent:child-run', 'sid-child');

    expect(
      reduceAgentEvent(
        state,
        agent(
          1,
          'thinking',
          { text: 'child thinking' },
          {
            sessionKey: 'agent:main:subagent:child-run',
            sessionId: 'sid-child',
            spawnedBy: 'agent:main:justdo:session-1',
          },
        ),
        dependencies,
      ),
    ).toBe('applied');
    expect(state.activeTurn).toMatchObject({
      runId: 'run-1',
      items: [expect.objectContaining({ type: 'thinking', text: 'child thinking' })],
    });
  });

  test('keeps unscoped spawned events from starting the selected transcript', () => {
    const state = createChatTranscriptState('agent:main:subagent:child-run', 'sid-child');

    expect(
      reduceAgentEvent(
        state,
        agent(
          1,
          'thinking',
          { text: 'unscoped child thinking' },
          {
            sessionKey: null,
            sessionId: null,
            spawnedBy: 'agent:main:justdo:session-1',
          },
        ),
        dependencies,
      ),
    ).toBe('ignored-run');
    expect(state.activeTurn).toBeNull();
  });

  test('admits a new operator run after an interrupted run is tombstoned', () => {
    const state = createChatTranscriptState('session-1', 'sid-1');
    reduceAgentEvent(state, agent(1, 'thinking', { text: 'partial' }), dependencies);
    reduceChatEvent(state, chat('aborted'), dependencies);

    expect(
      reduceAgentEvent(
        state,
        agent(1, 'thinking', { text: 'attached' }, { runId: 'run-2' }),
        dependencies,
      ),
    ).toBe('applied');
    expect(state.activeTurn?.runId).toBe('run-2');
  });
});
