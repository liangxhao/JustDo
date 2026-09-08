import { describe, expect, it, vi } from 'vitest';

import {
  buildGatewaySessionDetailStats,
  requestGatewaySessionUsage,
} from './openclawSessionDetails';

describe('Gateway session detail statistics', () => {
  it('uses the canonical total while preserving the provider token breakdown', () => {
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
      totalTokens: 71,
      hasTokenUsage: true,
    });
  });

  it('falls back to component sums only when the provider total is absent', () => {
    expect(
      buildGatewaySessionDetailStats(
        { total_tokens: 9, messageCounts: {}, modelUsage: [{ model: 'gpt-5', count: 1 }] },
        null,
      ),
    ).toMatchObject({
      tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      totalTokens: 9,
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
  it('requests fresh current-instance usage and returns the specific session summary', async () => {
    const usage = { totalTokens: 123 };
    const request = vi.fn().mockResolvedValue({
      sessions: [{ key: 'child', usage }],
      cacheStatus: { status: 'fresh' },
    });

    await expect(
      requestGatewaySessionUsage({ request } as never, 'agent:main:subagent:child'),
    ).resolves.toBe(usage);
    expect(request).toHaveBeenCalledWith(
      'sessions.usage',
      expect.objectContaining({
        key: 'agent:main:subagent:child',
        range: 'all',
        groupBy: 'instance',
        limit: expect.any(Number),
      }),
    );
  });

  it('uses visible history for the summary, message counts, and duplicate tool calls', () => {
    expect(
      buildGatewaySessionDetailStats(
        {
          totalTokens: 10,
          lastActivity: 500,
          messageCounts: { total: 99, user: 20, assistant: 79, toolCalls: 1 },
          modelUsage: [
            { provider: 'openrouter', model: 'anthropic/claude-sonnet-4', count: 1 },
            { provider: 'openclaw', model: 'delivery-mirror', count: 1 },
            { provider: 'ollama', model: 'delivery-mirror', count: 1 },
          ],
        },
        null,
        [
          { role: 'user', content: 'First visible question' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Working' },
              { type: 'tool_use', name: 'read', id: 'call-1', input: {} },
              { type: 'tool_use', name: 'read', id: 'call-2', input: {} },
            ],
          },
        ],
      ),
    ).toMatchObject({
      summary: 'First visible question',
      messageCount: 2,
      userMessageCount: 1,
      assistantMessageCount: 1,
      toolCallCount: 2,
      models: ['openrouter/anthropic/claude-sonnet-4', 'ollama/delivery-mirror'],
      totalTokens: 10,
      lastActivity: 500,
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
    const limits = request.mock.calls.map(([, params]) => params.limit);
    expect(new Set(limits).size).toBe(1);
  });

  it('uses a supplied session revision as a stable outer-cache discriminator', async () => {
    const request = vi.fn().mockResolvedValue({
      sessions: [{ key: 'child', usage: {} }],
      cacheStatus: { status: 'fresh' },
    });

    await requestGatewaySessionUsage({ request } as never, 'agent:main:subagent:child', {
      cacheDiscriminator: 1_234,
    });

    expect(request).toHaveBeenCalledWith(
      'sessions.usage',
      expect.objectContaining({ limit: 1_234 }),
    );
  });

  it('treats a fresh session row with null usage as an empty token snapshot', async () => {
    const request = vi.fn().mockResolvedValue({
      sessions: [{ key: 'child', usage: null }],
      cacheStatus: { status: 'fresh' },
    });

    const usage = await requestGatewaySessionUsage(
      { request } as never,
      'agent:main:subagent:child',
    );

    expect(usage).toEqual({});
    expect(
      buildGatewaySessionDetailStats(usage, null, [{ role: 'user', content: 'Pending reply' }]),
    ).toMatchObject({
      messageCount: 1,
      userMessageCount: 1,
      assistantMessageCount: 0,
      totalTokens: 0,
      hasTokenUsage: false,
    });
  });

  it.each(['partial', 'stale'] as const)(
    'rejects %s instance usage after bounded retries',
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
