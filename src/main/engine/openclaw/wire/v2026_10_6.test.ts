import { describe, expect, test } from 'vitest';

import {
  parseChatHistoryCursorResultV2026_10_6,
  parseChatHistoryResultV2026_10_6,
  parseHistoryDetailsResultV2026_10_6,
  parseSessionsListResultV2026_10_6,
  parseSessionsSearchResultV2026_10_6,
} from './v2026_10_6';

describe('OpenClaw v2026.10.6 wire validators', () => {
  test('retains target unpaired activity without manufacturing terminal evidence', () => {
    // v10.6 AgentActivityItemSchema: unpairedCall describes page visibility only.
    const activity = [
      {
        messageId: 'native-message',
        items: [
          {
            itemId: 'native-item',
            phase: 'start',
            title: 'Native tool',
            kind: 'tool',
            toolCallId: 'native-call',
            unpairedCall: true,
          },
        ],
      },
    ];
    const page = parseChatHistoryResultV2026_10_6({ messages: [], activity });
    expect(page.activity).toEqual(activity);
    expect(page.activity?.[0]).not.toHaveProperty('executionSettled');
    expect(
      parseChatHistoryCursorResultV2026_10_6({
        kind: 'delta',
        messages: [],
        activity,
        deltaCursor: 'native-cursor',
      }),
    ).toMatchObject({ activity });
  });

  test('preserves newly projected native incarnation and control-membership facts', () => {
    const native = {
      key: 'agent:main:fixture:child',
      kind: 'direct',
      lifecycleRevision: 'native-life',
      sessionModelRevision: 'native-model',
      childOwnerSessionKeys: ['agent:main:fixture:parent'],
      hasBoard: true,
      isDock: true,
      createdSurface: 'plugin-dock',
      rowMode: 'compact',
    };
    expect(parseSessionsListResultV2026_10_6({ sessions: [native] }).sessions).toEqual([native]);
  });

  test('preserves native activity for full and delta history and rejects malformed sidecars', () => {
    const activity = [
      { messageId: 'm', items: [{ toolCallId: 'c', phase: 'end', status: 'failed' }] },
    ];
    expect(parseChatHistoryResultV2026_10_6({ messages: [], activity }).activity).toEqual(activity);
    expect(
      parseChatHistoryCursorResultV2026_10_6({
        kind: 'delta',
        messages: [],
        deltaCursor: 'c',
        activity,
      }),
    ).toMatchObject({ activity });
    expect(() => parseChatHistoryResultV2026_10_6({ messages: [], activity: {} })).toThrow(
      'activity',
    );
    expect(() =>
      parseChatHistoryCursorResultV2026_10_6({
        kind: 'delta',
        messages: [],
        deltaCursor: 'c',
        activity: [{ messageId: 'm', items: [null] }],
      }),
    ).toThrow('activity');
  });
  test('validates history and session pagination instead of guessing malformed pages', () => {
    expect(
      parseChatHistoryResultV2026_10_6({
        messages: [{ role: 'assistant', content: 'done' }],
        hasMore: true,
        nextOffset: 50,
        totalMessages: 75,
        deltaCursor: 'cursor-1',
      }),
    ).toMatchObject({
      hasMore: true,
      nextOffset: 50,
      totalMessages: 75,
      deltaCursor: 'cursor-1',
    });
    expect(() => parseChatHistoryResultV2026_10_6({ messages: [], hasMore: true })).toThrow(
      'omitted nextOffset',
    );
    expect(() =>
      parseChatHistoryResultV2026_10_6({
        messages: [],
        totalMessages: -1,
      }),
    ).toThrow('totalMessages');

    expect(
      parseChatHistoryCursorResultV2026_10_6({
        kind: 'delta',
        messages: [{ role: 'assistant' }],
        deltaCursor: 'cursor-2',
      }),
    ).toMatchObject({ kind: 'delta', deltaCursor: 'cursor-2' });
    expect(parseChatHistoryCursorResultV2026_10_6({ kind: 'reset' })).toEqual({
      kind: 'reset',
    });
    expect(() => parseChatHistoryCursorResultV2026_10_6({ kind: 'delta', messages: [] })).toThrow(
      'omitted deltaCursor',
    );

    expect(
      parseSessionsListResultV2026_10_6({
        sessions: [{ key: 'agent:main:justdo:one' }],
        hasMore: false,
        nextOffset: null,
      }).sessions[0]?.key,
    ).toBe('agent:main:justdo:one');
    expect(() => parseSessionsListResultV2026_10_6({ sessions: [{ key: 1 }] })).toThrow(
      'missing key',
    );
  });

  test('validates bounded session transcript search results', () => {
    expect(
      parseSessionsSearchResultV2026_10_6({
        results: [
          {
            sessionKey: 'agent:main:justdo:one',
            sessionId: 'gateway-session-1',
            messageId: 'message-1',
            role: 'assistant',
            timestamp: 123,
            snippet: 'matched content',
            score: 1.5,
          },
        ],
        indexing: true,
        truncated: false,
      }),
    ).toMatchObject({
      indexing: true,
      truncated: false,
      results: [{ role: 'assistant', snippet: 'matched content' }],
    });
    expect(() =>
      parseSessionsSearchResultV2026_10_6({
        results: [{ sessionKey: 'agent:main:justdo:one', role: 'tool' }],
      }),
    ).toThrow('malformed');
    expect(() =>
      parseSessionsSearchResultV2026_10_6({
        results: Array.from({ length: 26 }, () => ({})),
      }),
    ).toThrow('more than 25 results');
    expect(() =>
      parseSessionsSearchResultV2026_10_6({
        results: [
          {
            sessionKey: 'agent:main:justdo:one',
            sessionId: 'gateway-session-1',
            messageId: 'message-1',
            role: 'user',
            timestamp: 123,
            snippet: 'x'.repeat(502),
            score: 1,
          },
        ],
      }),
    ).toThrow('malformed');
  });

  test('accepts only bounded runtime-bridge history detail shapes', () => {
    expect(
      parseHistoryDetailsResultV2026_10_6({
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
      parseHistoryDetailsResultV2026_10_6({
        toolInputs: { call_1: {} },
        compactionDetails: {},
      }),
    ).toThrow('malformed');
  });

  test('validates the native archived transcript exclusion count', () => {
    expect(parseSessionsSearchResultV2026_10_6({ results: [] }).archivedTranscriptsExcluded).toBe(
      0,
    );
    expect(
      parseSessionsSearchResultV2026_10_6({ results: [], archivedTranscriptsExcluded: 3 })
        .archivedTranscriptsExcluded,
    ).toBe(3);
    for (const archivedTranscriptsExcluded of [-1, 1.5, '3', Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        parseSessionsSearchResultV2026_10_6({ results: [], archivedTranscriptsExcluded }),
      ).toThrow('archived exclusion count');
    }
  });
});
