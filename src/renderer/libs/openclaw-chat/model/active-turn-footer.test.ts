import { describe, expect, test } from 'vitest';

import {
  formatActiveTurnDuration,
  formatActiveTurnTimestamp,
  projectActiveTurnFooter,
} from './active-turn-footer';
import type { AssistantTurn, TurnItem } from './chat-transcript-state';

function turn(status: AssistantTurn['status'], items: TurnItem[] = []): AssistantTurn {
  return {
    id: 'turn-1',
    runId: 'run-1',
    sessionId: null,
    lifecycleGeneration: null,
    sessionKey: 'session-1',
    status,
    lastAgentSeq: 1,
    startedAt: 1_000,
    ...(status === 'running' ? {} : { endedAt: 2_000 }),
    items,
    toolById: new Map(),
  };
}

describe('active turn footer', () => {
  test.each([
    [
      'Thinking',
      {
        type: 'thinking',
        status: 'running',
        text: 'working',
      },
    ],
    [
      'Tool',
      {
        type: 'tool',
        status: 'running',
        toolCallId: 'call-1',
        name: 'search',
      },
    ],
  ])('stays visible while the last message is running %s', (_label, item) => {
    const runningItem = {
      id: 'item-1',
      runId: 'run-1',
      firstSeq: 1,
      lastSeq: 1,
      startedAt: 1_100,
      updatedAt: 1_200,
      ...item,
    } as TurnItem;

    expect(projectActiveTurnFooter(turn('running', [runningItem]), 4_000)).toEqual({
      completedAt: null,
      durationMs: 3_000,
      running: true,
    });
  });

  test('keeps the completion time and final duration after the turn finishes', () => {
    expect(projectActiveTurnFooter(turn('final'), 9_000)).toEqual({
      completedAt: 2_000,
      durationMs: 1_000,
      running: false,
    });
  });

  test('does not render without an active turn', () => {
    expect(projectActiveTurnFooter(null)).toBeNull();
  });

  test('formats the latest time with seconds', () => {
    expect(formatActiveTurnTimestamp(new Date(2026, 6, 29, 16, 5, 12))).toBe(
      '2026-07-29 16:05:12',
    );
  });

  test('formats duration as a clock value', () => {
    expect(formatActiveTurnDuration(7_338_999)).toBe('02:02:18');
  });
});
