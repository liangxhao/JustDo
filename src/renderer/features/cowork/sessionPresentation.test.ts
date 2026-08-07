import { describe, expect, it } from 'vitest';

import type { CoworkSession, CoworkSessionSummary } from '@/features/cowork/coworkTypes';
import {
  buildSessionDetailStats,
  getSessionDateGroupKey,
  groupSessionsByDate,
} from '@/features/cowork/sessionPresentation';

const summary = (id: string, updatedAt: number, pinned = false): CoworkSessionSummary => ({
  id,
  title: id,
  status: 'idle',
  pinned,
  createdAt: updatedAt,
  updatedAt,
});

describe('session date grouping', () => {
  const now = new Date(2026, 0, 31, 0, 15).getTime();

  it('uses local calendar days across month boundaries', () => {
    expect(
      getSessionDateGroupKey(summary('today', new Date(2026, 0, 31, 0, 1).getTime()), now),
    ).toBe('today');
    expect(
      getSessionDateGroupKey(summary('yesterday', new Date(2026, 0, 30, 23, 59).getTime()), now),
    ).toBe('yesterday');
    expect(getSessionDateGroupKey(summary('seven', new Date(2026, 0, 24, 12).getTime()), now)).toBe(
      'previous7Days',
    );
    expect(getSessionDateGroupKey(summary('thirty', new Date(2026, 0, 1, 12).getTime()), now)).toBe(
      'previous30Days',
    );
    expect(
      getSessionDateGroupKey(summary('earlier', new Date(2025, 11, 31, 12).getTime()), now),
    ).toBe('earlier');
  });

  it('recognizes yesterday across a year boundary', () => {
    expect(
      getSessionDateGroupKey(
        summary('last-year', new Date(2025, 11, 31, 23, 59).getTime()),
        new Date(2026, 0, 1, 0, 1).getTime(),
      ),
    ).toBe('yesterday');
  });

  it('keeps pinned sessions first and sorts each group by activity', () => {
    const groups = groupSessionsByDate(
      [
        summary('older-today', new Date(2026, 0, 31, 8).getTime()),
        summary('pinned', new Date(2025, 0, 1).getTime(), true),
        summary('newer-today', new Date(2026, 0, 31, 9).getTime()),
      ],
      new Date(2026, 0, 31, 12).getTime(),
    );

    expect(groups.map(group => group.key)).toEqual(['pinned', 'today']);
    expect(groups[1].sessions.map(session => session.id)).toEqual(['newer-today', 'older-today']);
  });
});

describe('session detail statistics', () => {
  it('builds a clean summary and aggregates messages, models, and token usage', () => {
    const session: CoworkSession = {
      id: 'session-1',
      title: 'Session',
      status: 'completed',
      pinned: false,
      cwd: 'E:\\workspace',
      executionMode: 'local',
      activeSkillIds: ['skill-a'],
      agentId: 'main',
      createdAt: 1,
      updatedAt: 2,
      messages: [
        {
          id: '1',
          type: 'user',
          content: '  Explain\n\nthis   code  ',
          timestamp: 1,
        },
        {
          id: '2',
          type: 'assistant',
          content: 'Sure',
          timestamp: 2,
          metadata: { modelName: 'gpt-test' },
          usage: { input: 10, output: 4, cacheRead: 3 },
        },
        {
          id: '3',
          type: 'tool_use',
          content: 'read',
          timestamp: 3,
          metadata: { toolUseId: 'call-1' },
        },
        {
          id: '3-duplicate',
          type: 'tool_use',
          content: 'read',
          timestamp: 3,
          metadata: { toolUseId: 'call-1' },
        },
        {
          id: '4',
          type: 'assistant',
          content: 'Done',
          timestamp: 4,
          modelName: 'gpt-test',
          usage: { input: 2, output: 1, cacheWrite: 5 },
        },
      ],
    };

    expect(buildSessionDetailStats(session)).toEqual({
      summary: 'Explain this code',
      messageCount: 3,
      userMessageCount: 1,
      assistantMessageCount: 2,
      toolCallCount: 1,
      models: ['gpt-test'],
      tokenUsage: { input: 12, output: 5, cacheRead: 3, cacheWrite: 5 },
      hasTokenUsage: true,
    });
  });

  it('handles an empty session without claiming token statistics', () => {
    const session: CoworkSession = {
      id: 'empty',
      title: 'Empty',
      status: 'idle',
      pinned: false,
      cwd: '',
      executionMode: 'local',
      activeSkillIds: [],
      agentId: 'main',
      createdAt: 1,
      updatedAt: 1,
      messages: [],
    };

    expect(buildSessionDetailStats(session)).toMatchObject({
      summary: null,
      messageCount: 0,
      hasTokenUsage: false,
      models: [],
    });
  });

  it('ignores empty usage objects', () => {
    const session: CoworkSession = {
      id: 'empty-usage',
      title: 'Empty usage',
      status: 'idle',
      pinned: false,
      cwd: '',
      executionMode: 'local',
      activeSkillIds: [],
      agentId: 'main',
      createdAt: 1,
      updatedAt: 1,
      messages: [{ id: '1', type: 'assistant', content: 'Hello', timestamp: 1, usage: {} }],
    };

    expect(buildSessionDetailStats(session).hasTokenUsage).toBe(false);
  });

  it('uses the first non-empty user message and ignores legacy duplicate usage', () => {
    const session: CoworkSession = {
      id: 'legacy-duplicates',
      title: 'Legacy duplicates',
      status: 'completed',
      pinned: false,
      cwd: '',
      executionMode: 'local',
      activeSkillIds: [],
      agentId: 'main',
      createdAt: 1,
      updatedAt: 6,
      messages: [
        { id: 'empty-user', type: 'user', content: '  ', timestamp: 1 },
        { id: 'user', type: 'user', content: 'Actual question', timestamp: 2 },
        {
          id: 'assistant-1',
          type: 'assistant',
          content: 'Done',
          timestamp: 3,
          usage: { input: 10, output: 2 },
        },
        {
          id: 'assistant-duplicate',
          type: 'assistant',
          content: 'Done',
          timestamp: 4,
          usage: { input: 10, output: 2 },
        },
      ],
    };

    expect(buildSessionDetailStats(session)).toMatchObject({
      summary: 'Actual question',
      messageCount: 3,
      userMessageCount: 1,
      assistantMessageCount: 2,
      tokenUsage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
    });
  });
});
