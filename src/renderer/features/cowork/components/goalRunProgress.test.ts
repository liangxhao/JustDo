import { describe, expect, it } from 'vitest';

import { buildGoalRunProgress } from './goalRunProgress';

const createState = (overrides: Record<string, unknown> = {}) => ({
  chatSending: true,
  compactionInFlight: false,
  chatStreamStartedAt: 100,
  chatStream: null,
  chatStreamSegments: [],
  chatThinkingStream: null,
  chatThinkingMessages: [],
  chatToolMessages: [],
  ...overrides,
});

describe('buildGoalRunProgress', () => {
  it('maps live activity to an honest execution phase', () => {
    expect(buildGoalRunProgress(createState())).toMatchObject({ phase: 'starting' });
    expect(buildGoalRunProgress(createState({ chatThinkingStream: 'considering' }))).toMatchObject({
      phase: 'thinking',
    });
    expect(
      buildGoalRunProgress({
        ...createState(),
        chatToolMessages: [{ content: [{ type: 'toolcall', name: 'exec' }] }],
      }),
    ).toMatchObject({ phase: 'tool', toolCount: 1, toolName: 'exec' });
    expect(buildGoalRunProgress(createState({ chatStream: 'Done' }))).toMatchObject({
      phase: 'responding',
    });
    expect(buildGoalRunProgress(createState({ compactionInFlight: true }))).toMatchObject({
      phase: 'compacting',
    });
  });

  it('returns no progress after the run ends', () => {
    expect(buildGoalRunProgress(createState({ chatSending: false }))).toBeNull();
  });
});
