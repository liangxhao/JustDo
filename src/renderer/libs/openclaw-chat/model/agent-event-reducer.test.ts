import type { NormalizedAgentEvent, NormalizedChatEvent } from '@shared/openclaw/agentEvent';
import { beforeEach, describe, expect, test } from 'vitest';

import { reduceAgentEvent, reduceChatEvent } from './agent-event-reducer';
import {
  beginAssistantTurn,
  createChatTranscriptState,
  type TranscriptReducerDependencies,
} from './chat-transcript-state';

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
