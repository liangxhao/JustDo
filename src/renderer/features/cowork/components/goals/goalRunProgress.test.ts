import { describe, expect, it } from 'vitest';

import { createChatTranscriptState } from '@/libs/openclaw-chat/model/chat-transcript-state';

import { buildGoalRunProgress } from './goalRunProgress';

const createState = (items: Array<Record<string, unknown>> = [], overrides = {}) => {
  const transcript = createChatTranscriptState('session-1');
  transcript.activeTurn = {
    id: 'turn-1',
    runId: 'run-1',
    sessionId: null,
    lifecycleGeneration: null,
    sessionKey: 'session-1',
    status: 'running',
    lastAgentSeq: items.length,
    startedAt: 100,
    items: items as never,
    toolById: new Map(),
  };
  return { chatSending: true, compactionInFlight: false, transcript, ...overrides };
};

describe('buildGoalRunProgress', () => {
  it('maps live activity to an honest execution phase', () => {
    expect(buildGoalRunProgress(createState())).toMatchObject({ phase: 'running' });
    expect(
      buildGoalRunProgress(
        createState([{ type: 'thinking', text: 'considering', status: 'running' }]),
      ),
    ).toMatchObject({ phase: 'thinking' });
    expect(
      buildGoalRunProgress(
        createState([{ type: 'tool', name: 'exec', toolCallId: 'call-1', status: 'running' }]),
      ),
    ).toMatchObject({ phase: 'tool', toolCount: 1, toolName: 'exec' });
    expect(
      buildGoalRunProgress(createState([{ type: 'content', text: 'Done', status: 'streaming' }])),
    ).toMatchObject({ phase: 'responding' });
    expect(buildGoalRunProgress(createState([], { compactionInFlight: true }))).toMatchObject({
      phase: 'compacting',
    });
  });

  it('reports the latest activity that is still active instead of an earlier content item', () => {
    expect(
      buildGoalRunProgress(
        createState([
          { type: 'content', text: 'I will check.', status: 'streaming' },
          { type: 'tool', name: 'web_search', toolCallId: 'call-1', status: 'running' },
        ]),
      ),
    ).toMatchObject({ phase: 'tool', toolName: 'web_search' });
  });

  it('does not present completed activity as current progress', () => {
    expect(
      buildGoalRunProgress(
        createState([
          { type: 'thinking', text: 'Done thinking', status: 'completed' },
          { type: 'tool', name: 'exec', toolCallId: 'call-1', status: 'completed' },
        ]),
      ),
    ).toMatchObject({ phase: 'running', toolCount: 1 });
  });

  it('returns no progress after the run ends', () => {
    expect(buildGoalRunProgress(createState([], { chatSending: false }))).toBeNull();
  });
});
