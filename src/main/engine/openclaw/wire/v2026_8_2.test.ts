import { describe, expect, test } from 'vitest';

import {
  parseChatHistoryResultV2026_8_2,
  parseHistoryDetailsResultV2026_8_2,
  parseSessionsListResultV2026_8_2,
  parseTaskEventV2026_8_2,
  parseTasksGetResultV2026_8_2,
  parseTasksListResultV2026_8_2,
} from './v2026_8_2';

describe('OpenClaw v2026.8.2 wire validators', () => {
  test('accepts the stable task ledger projection and cursor pagination', () => {
    const page = parseTasksListResultV2026_8_2({
      tasks: [
        {
          id: 'task-1',
          taskId: 'task-1',
          runtime: 'subagent',
          kind: 'subagent',
          status: 'completed',
          title: 'Research complete',
          sessionKey: 'agent:main:justdo:parent',
          childSessionKey: 'agent:researcher:justdo:child',
          createdAt: 100,
          endedAt: 200,
        },
      ],
      nextCursor: '1',
    });

    expect(page.nextCursor).toBe('1');
    expect(page.tasks[0]).toMatchObject({ id: 'task-1', status: 'completed' });
    expect(parseTasksGetResultV2026_8_2({ task: page.tasks[0] }).task.id).toBe(
      'task-1',
    );
    expect(
      parseTaskEventV2026_8_2({ action: 'upserted', task: page.tasks[0] }),
    ).toMatchObject({ action: 'upserted', task: { id: 'task-1' } });
  });

  test('rejects internal or unknown task statuses at the wire boundary', () => {
    for (const status of ['succeeded', 'lost', 'done', 'blocked']) {
      expect(() =>
        parseTasksListResultV2026_8_2({ tasks: [{ id: 'task-1', status }] }),
      ).toThrow('invalid status');
    }
  });

  test('validates history and session pagination instead of guessing malformed pages', () => {
    expect(
      parseChatHistoryResultV2026_8_2({
        messages: [{ role: 'assistant', content: 'done' }],
        hasMore: true,
        nextOffset: 50,
      }),
    ).toMatchObject({ hasMore: true, nextOffset: 50 });
    expect(() =>
      parseChatHistoryResultV2026_8_2({ messages: [], hasMore: true }),
    ).toThrow('omitted nextOffset');

    expect(
      parseSessionsListResultV2026_8_2({
        sessions: [{ key: 'agent:main:justdo:one' }],
        hasMore: false,
        nextOffset: null,
      }).sessions[0]?.key,
    ).toBe('agent:main:justdo:one');
    expect(() =>
      parseSessionsListResultV2026_8_2({ sessions: [{ key: 1 }] }),
    ).toThrow('missing key');
  });

  test('accepts only bounded runtime-bridge history detail shapes', () => {
    expect(
      parseHistoryDetailsResultV2026_8_2({
        toolInputs: { call_1: { name: 'read', input: { path: 'README.md' } } },
        compactionDetails: {
          compact_1: { summary: 'summary', tokensBefore: 1200, tokensAfter: 400 },
        },
      }),
    ).toEqual({
      toolInputs: { call_1: { name: 'read', input: { path: 'README.md' } } },
      compactionDetails: {
        compact_1: { summary: 'summary', tokensBefore: 1200, tokensAfter: 400 },
      },
    });
    expect(() =>
      parseHistoryDetailsResultV2026_8_2({
        toolInputs: { call_1: {} },
        compactionDetails: {},
      }),
    ).toThrow('malformed');
  });
});
