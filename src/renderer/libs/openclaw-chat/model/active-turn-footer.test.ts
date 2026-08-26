import { describe, expect, test } from 'vitest';

import {
  formatActiveTurnDuration,
  formatActiveTurnTimestamp,
  projectActiveTurnFooter,
  resolveActiveTurnModel,
  shouldRenderInterruptedTerminalFallback,
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
      status: 'running',
    });
  });

  test('keeps the completion time and final duration after the turn finishes', () => {
    expect(projectActiveTurnFooter(turn('final'), 9_000)).toEqual({
      completedAt: 2_000,
      durationMs: 1_000,
      running: false,
      status: 'completed',
    });
  });

  test('projects an aborted run as interruption status metadata', () => {
    expect(projectActiveTurnFooter(turn('aborted'), 9_000)).toEqual({
      completedAt: 2_000,
      durationMs: 1_000,
      running: false,
      status: 'aborted',
    });
  });

  test('does not render without an active turn', () => {
    expect(projectActiveTurnFooter(null)).toBeNull();
  });

  test('requests the original terminal row when aborted timing has no visible terminal item', () => {
    const footer = projectActiveTurnFooter(turn('aborted'), 9_000);

    expect(shouldRenderInterruptedTerminalFallback(footer, false)).toBe(true);
    expect(shouldRenderInterruptedTerminalFallback(footer, true)).toBe(false);
    expect(
      shouldRenderInterruptedTerminalFallback(projectActiveTurnFooter(turn('final')), false),
    ).toBe(false);
  });

  test('formats the latest time with seconds', () => {
    expect(formatActiveTurnTimestamp(new Date(2026, 6, 29, 16, 5, 12))).toBe('2026-07-29 16:05:12');
  });

  test.each([
    [1_287_999, '21m 27s'],
    [7_338_999, '2h 2m 18s'],
    [3_999, '3s'],
    [0, '0s'],
  ])('formats %i milliseconds as compact English units', (durationMs, expected) => {
    expect(formatActiveTurnDuration(durationMs)).toBe(expected);
  });
});

describe('resolveActiveTurnModel', () => {
  test('prefers model metadata emitted for the current run', () => {
    expect(
      resolveActiveTurnModel(
        [{ role: 'assistant', provider: 'old-provider', model: 'old-model' }],
        'current-model',
        'current-provider',
      ),
    ).toBe('current-provider/current-model');
  });

  test('uses the user-visible session run instead of an internal run id', () => {
    expect(
      projectActiveTurnFooter(
        {
          id: 'timing-1',
          sessionId: 'session-1',
          clientTurnId: 'root-run',
          rootRunId: 'root-run',
          startedAt: 1_000,
          state: 'running',
        },
        301_000,
      ),
    ).toMatchObject({ running: true, durationMs: 300_000 });
  });

  test('skips gateway-injected assistant records when falling back to history', () => {
    expect(
      resolveActiveTurnModel([
        { role: 'user', content: 'first turn' },
        { role: 'assistant', provider: 'custom-provider', model: 'actual-model' },
        { role: 'user', content: 'current turn' },
        { role: 'assistant', provider: 'openclaw', model: 'gateway-injected' },
      ]),
    ).toBe('');
  });

  test('uses only assistant metadata from the current user turn', () => {
    expect(
      resolveActiveTurnModel([
        { role: 'user', content: 'first turn' },
        { role: 'assistant', provider: 'old-provider', model: 'old-model' },
        { role: 'user', content: 'current turn' },
        { role: 'assistant', provider: 'current-provider', model: 'current-model' },
        { role: 'assistant', provider: 'openclaw', model: 'gateway-injected' },
      ]),
    ).toBe('current-provider/current-model');
  });

  test('does not guess from assistant-only history without a current turn boundary', () => {
    expect(
      resolveActiveTurnModel([{ role: 'assistant', provider: 'old-provider', model: 'old-model' }]),
    ).toBe('');
  });

  test('does not expose gateway-injected progress metadata in the footer', () => {
    expect(
      resolveActiveTurnModel(
        [{ role: 'assistant', model: 'gateway-injected' }],
        'gateway-injected',
        'openclaw',
      ),
    ).toBe('');
  });

  test('filters case-insensitive multi-segment gateway-injected model refs', () => {
    expect(resolveActiveTurnModel([], 'Vendor/OpenClaw/Gateway-Injected')).toBe('');
  });
});
