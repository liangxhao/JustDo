import { describe, expect, test } from 'vitest';

import {
  parseChatHistoryCursorResultV2026_9_8,
  parseChatHistoryResultV2026_9_8,
  parseHistoryDetailsResultV2026_9_8,
  parseSessionsListResultV2026_9_8,
  parseSessionsSearchResultV2026_9_8,
} from './v2026_9_8';

describe('OpenClaw v2026.9.8 wire validators', () => {
  test('preserves native activity for full and delta history and rejects malformed sidecars', () => {
    const activity = [
      { messageId: 'm', items: [{ toolCallId: 'c', phase: 'end', status: 'failed' }] },
    ];
    expect(parseChatHistoryResultV2026_9_8({ messages: [], activity }).activity).toEqual(activity);
    expect(
      parseChatHistoryCursorResultV2026_9_8({
        kind: 'delta',
        messages: [],
        deltaCursor: 'c',
        activity,
      }),
    ).toMatchObject({ activity });
    expect(() => parseChatHistoryResultV2026_9_8({ messages: [], activity: {} })).toThrow(
      'activity',
    );
    expect(() =>
      parseChatHistoryCursorResultV2026_9_8({
        kind: 'delta',
        messages: [],
        deltaCursor: 'c',
        activity: [{ messageId: 'm', items: [null] }],
      }),
    ).toThrow('activity');
  });
  test('validates history and session pagination instead of guessing malformed pages', () => {
    expect(
      parseChatHistoryResultV2026_9_8({
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
    expect(() => parseChatHistoryResultV2026_9_8({ messages: [], hasMore: true })).toThrow(
      'omitted nextOffset',
    );
    expect(() =>
      parseChatHistoryResultV2026_9_8({
        messages: [],
        totalMessages: -1,
      }),
    ).toThrow('totalMessages');

    expect(
      parseChatHistoryCursorResultV2026_9_8({
        kind: 'delta',
        messages: [{ role: 'assistant' }],
        deltaCursor: 'cursor-2',
      }),
    ).toMatchObject({ kind: 'delta', deltaCursor: 'cursor-2' });
    expect(parseChatHistoryCursorResultV2026_9_8({ kind: 'reset' })).toEqual({
      kind: 'reset',
    });
    expect(() => parseChatHistoryCursorResultV2026_9_8({ kind: 'delta', messages: [] })).toThrow(
      'omitted deltaCursor',
    );

    expect(
      parseSessionsListResultV2026_9_8({
        sessions: [{ key: 'agent:main:justdo:one' }],
        hasMore: false,
        nextOffset: null,
      }).sessions[0]?.key,
    ).toBe('agent:main:justdo:one');
    expect(() => parseSessionsListResultV2026_9_8({ sessions: [{ key: 1 }] })).toThrow(
      'missing key',
    );
  });

  test('validates bounded session transcript search results', () => {
    expect(
      parseSessionsSearchResultV2026_9_8({
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
      parseSessionsSearchResultV2026_9_8({
        results: [{ sessionKey: 'agent:main:justdo:one', role: 'tool' }],
      }),
    ).toThrow('malformed');
    expect(() =>
      parseSessionsSearchResultV2026_9_8({
        results: Array.from({ length: 26 }, () => ({})),
      }),
    ).toThrow('more than 25 results');
    expect(() =>
      parseSessionsSearchResultV2026_9_8({
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
      parseHistoryDetailsResultV2026_9_8({
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
      parseHistoryDetailsResultV2026_9_8({
        toolInputs: { call_1: {} },
        compactionDetails: {},
      }),
    ).toThrow('malformed');
  });
});
