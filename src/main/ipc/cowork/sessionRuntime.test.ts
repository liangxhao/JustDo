import { describe, expect, it, vi } from 'vitest';

import {
  createSingleFlightTtlLookup,
  queryGatewaySession,
  readGatewaySessionId,
  readSessionGoal,
  readUsage,
} from './sessionRuntime';

describe('queryGatewaySession', () => {
  it('uses sessions.describe for exact managed keys instead of a bounded session list', async () => {
    const request = vi.fn(async (method: string, params: { key?: string }) => {
      expect(method).toBe('sessions.describe');
      return params.key === 'agent:main:justdo:session-1'
        ? { session: { key: params.key, sessionId: 'gateway-1' } }
        : { session: null };
    });
    const result = await queryGatewaySession(
      {
        getCoworkStore: () => ({ getSession: () => ({ agentId: 'main' }) }) as never,
        getRuntime: () =>
          ({
            getGatewayClient: () => ({ request }),
            getSessionKeysForSession: () => [],
          }) as never,
      },
      'session-1',
    );

    expect(result.session?.sessionId).toBe('gateway-1');
    expect(request).not.toHaveBeenCalledWith('sessions.list', expect.anything());
  });
});

describe('readGatewaySessionId', () => {
  it('prefers the Gateway sessionId and normalizes whitespace', () => {
    expect(readGatewaySessionId({ sessionId: ' gateway-session-1 ', id: 'fallback-id' })).toBe(
      'gateway-session-1',
    );
  });

  it('falls back to id and rejects missing identifiers', () => {
    expect(readGatewaySessionId({ sessionId: ' ', id: 'gateway-session-2' })).toBe(
      'gateway-session-2',
    );
    expect(readGatewaySessionId({ sessionId: '  ' })).toBeUndefined();
  });
});

describe('readSessionGoal', () => {
  it('normalizes a valid Gateway goal', () => {
    expect(
      readSessionGoal({
        schemaVersion: 1,
        id: 'goal-1',
        objective: '  Ship the goal UI  ',
        status: 'blocked',
        createdAt: 10,
        updatedAt: 20,
        tokenStart: 100,
        tokensUsed: 25,
        tokenBudget: 50,
        continuationTurns: 2,
        lastStatusNote: '  Waiting for review  ',
      }),
    ).toMatchObject({
      id: 'goal-1',
      objective: 'Ship the goal UI',
      status: 'blocked',
      tokensUsed: 25,
      tokenBudget: 50,
      lastStatusNote: 'Waiting for review',
    });
  });

  it('rejects malformed or unknown goal states', () => {
    expect(readSessionGoal({ id: 'goal-1', objective: '', status: 'active' })).toBeUndefined();
    expect(
      readSessionGoal({
        schemaVersion: 1,
        id: 'goal-1',
        objective: 'Ship it',
        status: 'mystery',
      }),
    ).toBeUndefined();
  });

  it('does not expose invalid negative counters', () => {
    expect(
      readSessionGoal({
        schemaVersion: 1,
        id: 'goal-1',
        objective: 'Ship it',
        status: 'active',
        tokensUsed: -1,
        tokenBudget: -10,
        pausedAt: -20,
      }),
    ).toMatchObject({ tokensUsed: 0 });
    expect(
      readSessionGoal({
        schemaVersion: 1,
        id: 'goal-1',
        objective: 'Ship it',
        status: 'active',
        tokenBudget: -10,
      }),
    ).not.toHaveProperty('tokenBudget');
  });
});

describe('readUsage', () => {
  it('uses the live prompt estimate while the persisted total is stale', () => {
    expect(
      readUsage({
        totalTokens: 12_000,
        totalTokensFresh: false,
        contextWindow: 200_000,
        contextBudgetStatus: {
          estimatedPromptTokens: 18_500,
          contextTokenBudget: 180_000,
        },
      }),
    ).toEqual({
      totalTokens: 18_500,
      contextTokens: 200_000,
      totalTokensFresh: true,
      compactionCount: 0,
    });
  });

  it('keeps a fresh Gateway total ahead of the prompt estimate', () => {
    expect(
      readUsage({
        totalTokens: 21_000,
        totalTokensFresh: true,
        contextWindow: 200_000,
        contextBudgetStatus: {
          estimatedPromptTokens: 18_500,
        },
      }),
    ).toMatchObject({
      totalTokens: 21_000,
      totalTokensFresh: true,
    });
  });

  it('uses the live estimate during a run even when transcript fallback looks fresh', () => {
    expect(
      readUsage({
        totalTokens: 21_000,
        totalTokensFresh: true,
        hasActiveRun: true,
        contextWindow: 200_000,
        contextBudgetStatus: {
          estimatedPromptTokens: 32_500,
        },
      }),
    ).toMatchObject({
      totalTokens: 32_500,
      totalTokensFresh: true,
    });
  });

  it('exposes the compaction generation used to validate decreases', () => {
    expect(
      readUsage({
        sessionId: 'gateway-session-1',
        totalTokens: 9_000,
        contextWindow: 200_000,
        compactionCount: 3,
        modelProvider: 'openai',
        model: 'gpt-5',
      }),
    ).toMatchObject({
      totalTokens: 9_000,
      compactionCount: 3,
      gatewaySessionId: 'gateway-session-1',
      modelRef: 'openai/gpt-5',
    });
  });

  it.each(['usage_limited', 'budget_limited'])(
    'normalizes unsupported %s goals to blocked',
    status => {
      expect(
        readSessionGoal({
          schemaVersion: 1,
          id: 'goal-1',
          objective: 'Ship it',
          status,
        }),
      ).toMatchObject({ status: 'blocked' });
    },
  );
});

describe('createSingleFlightTtlLookup', () => {
  it('coalesces concurrent calls and reuses a settled value within the TTL', async () => {
    let currentTime = 100;
    let resolveLoad: ((value: string) => void) | undefined;
    const loader = vi.fn(
      () =>
        new Promise<string>(resolve => {
          resolveLoad = resolve;
        }),
    );
    const lookup = createSingleFlightTtlLookup(loader, 750, () => currentTime);

    const first = lookup('session-1');
    const concurrent = lookup('session-1');
    expect(loader).toHaveBeenCalledTimes(1);

    resolveLoad?.('value-1');
    await expect(Promise.all([first, concurrent])).resolves.toEqual(['value-1', 'value-1']);

    currentTime += 500;
    await expect(lookup('session-1')).resolves.toBe('value-1');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('refreshes after expiry and does not cache rejected calls', async () => {
    let currentTime = 100;
    const loader = vi
      .fn<(key: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error('gateway unavailable'))
      .mockResolvedValueOnce('value-2')
      .mockResolvedValueOnce('value-3');
    const lookup = createSingleFlightTtlLookup(loader, 750, () => currentTime);

    await expect(lookup('session-1')).rejects.toThrow('gateway unavailable');
    await expect(lookup('session-1')).resolves.toBe('value-2');
    expect(loader).toHaveBeenCalledTimes(2);

    currentTime += 751;
    await expect(lookup('session-1')).resolves.toBe('value-3');
    expect(loader).toHaveBeenCalledTimes(3);
  });
});
