import { describe, expect, it, vi } from 'vitest';

import {
  buildGatewaySessionDetailStats,
  requestGatewaySessionUsage,
} from './openclawSessionDetails';

describe('Gateway session detail statistics', () => {
  it('uses raw transcript counts and sums the four displayed token categories', () => {
    expect(
      buildGatewaySessionDetailStats(
        {
          input: 40,
          output: 8,
          cacheRead: 14,
          cacheWrite: 2,
          totalTokens: 71,
          messageCounts: {
            total: 5,
            user: 2,
            assistant: 3,
            toolCalls: 2,
          },
          modelUsage: [
            { provider: 'openai', model: 'gpt-5', count: 2 },
            { provider: 'anthropic', model: 'claude-sonnet-4', count: 1 },
            { provider: 'openclaw', model: 'gateway-injected', count: 1 },
          ],
        },
        'First question',
      ),
    ).toEqual({
      summary: 'First question',
      messageCount: 5,
      userMessageCount: 2,
      assistantMessageCount: 3,
      toolCallCount: 2,
      models: ['openai/gpt-5', 'anthropic/claude-sonnet-4'],
      tokenUsage: { input: 40, output: 8, cacheRead: 14, cacheWrite: 2 },
      totalTokens: 64,
      hasTokenUsage: true,
    });
  });

  it('ignores a divergent provider total and always uses component sums', () => {
    expect(
      buildGatewaySessionDetailStats(
        { total_tokens: 9, messageCounts: {}, modelUsage: [{ model: 'gpt-5', count: 1 }] },
        null,
      ),
    ).toMatchObject({
      tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      totalTokens: 0,
      hasTokenUsage: true,
    });
    expect(
      buildGatewaySessionDetailStats(
        { inputTokens: 5, completionTokens: 2, cacheRead: 3, messageCounts: {} },
        null,
      )?.totalTokens,
    ).toBe(10);
  });
});

describe('requestGatewaySessionUsage', () => {
  it('requests complete family usage and returns the specific session summary', async () => {
    const usage = { totalTokens: 123 };
    const request = vi.fn().mockResolvedValue({
      sessions: [{ key: 'child', usage }],
      cacheStatus: { status: 'fresh' },
    });

    await expect(
      requestGatewaySessionUsage({ request } as never, 'agent:main:subagent:child'),
    ).resolves.toBe(usage);
    expect(request).toHaveBeenCalledWith('sessions.usage', {
      key: 'agent:main:subagent:child',
      range: 'all',
      groupBy: 'family',
      limit: 1,
    });
  });

  it('waits for a refreshing cache before returning a complete usage summary', async () => {
    const usage = { totalTokens: 123 };
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessions: [{ key: 'child', usage: null }],
        cacheStatus: { status: 'refreshing' },
      })
      .mockResolvedValueOnce({
        sessions: [{ key: 'child', usage }],
        cacheStatus: { status: 'fresh' },
      });
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(
      requestGatewaySessionUsage({ request } as never, 'agent:main:subagent:child', {
        maxAttempts: 2,
        wait,
      }),
    ).resolves.toBe(usage);
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it.each(['partial', 'stale'] as const)(
    'rejects %s family usage after bounded retries',
    async status => {
      const request = vi.fn().mockResolvedValue({
        sessions: [{ key: 'child', usage: { totalTokens: 50 } }],
        cacheStatus: { status },
      });
      const wait = vi.fn().mockResolvedValue(undefined);

      await expect(
        requestGatewaySessionUsage({ request } as never, 'agent:main:subagent:child', {
          maxAttempts: 3,
          wait,
        }),
      ).rejects.toThrow('Gateway usage cache did not become fresh');
      expect(request).toHaveBeenCalledTimes(3);
      expect(wait).toHaveBeenCalledTimes(2);
    },
  );
});
