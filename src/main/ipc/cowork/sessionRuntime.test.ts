import { describe, expect, it, vi } from 'vitest';

import {
  createSingleFlightTtlLookup,
  queryGatewaySession,
  readGatewaySessionId,
  readSessionGoal,
  readUsage,
} from './sessionRuntime';

describe('queryGatewaySession', () => {
  it('combines the exact session row with the active-run registry projection', async () => {
    const request = vi.fn(async (method: string, params: { key?: string; search?: string }) => {
      if (method === 'sessions.describe') {
        return params.key === 'agent:main:justdo:session-1'
          ? {
              session: {
                key: params.key,
                sessionId: 'gateway-1',
                totalTokens: 10_000,
              },
            }
          : { session: null };
      }
      expect(method).toBe('sessions.list');
      expect(params.search).toBe('agent:main:justdo:session-1');
      return {
        sessions: [
          {
            key: 'agent:main:justdo:session-1',
            sessionId: 'gateway-1',
            totalTokens: 10_000,
            hasActiveRun: false,
          },
        ],
      };
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

    expect(result.session).toMatchObject({
      sessionId: 'gateway-1',
      totalTokens: 10_000,
      hasActiveRun: false,
    });
    expect(request).toHaveBeenCalledWith('sessions.list', {
      search: 'agent:main:justdo:session-1',
      limit: 20,
      agentId: 'main',
    });
  });

  it('re-reads exact usage after a run ends between the first two requests', async () => {
    let describeCalls = 0;
    const request = vi.fn(async (method: string, params: { key?: string }) => {
      if (method === 'sessions.describe') {
        describeCalls += 1;
        return {
          session: {
            key: params.key,
            sessionId: 'gateway-1',
            totalTokens: describeCalls === 1 ? 21_000 : 10_000,
            status: describeCalls === 1 ? 'running' : 'done',
          },
        };
      }
      return {
        sessions: [
          {
            key: 'agent:main:justdo:session-1',
            sessionId: 'gateway-1',
            totalTokens: 10_000,
            status: 'done',
            hasActiveRun: false,
          },
        ],
      };
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

    expect(result.session).toMatchObject({
      totalTokens: 10_000,
      status: 'done',
      hasActiveRun: false,
    });
    expect(describeCalls).toBe(2);
  });

  it('preserves a newer active signal returned by the second exact read', async () => {
    let describeCalls = 0;
    const request = vi.fn(async (method: string, params: { key?: string }) => {
      if (method === 'sessions.describe') {
        describeCalls += 1;
        return {
          session: {
            key: params.key,
            sessionId: 'gateway-1',
            totalTokens: 21_000,
            ...(describeCalls === 2 ? { hasActiveRun: true } : {}),
          },
        };
      }
      return {
        sessions: [{ key: 'agent:main:justdo:session-1', hasActiveRun: false }],
      };
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

    expect(result.session?.hasActiveRun).toBe(true);
    expect(describeCalls).toBe(2);
  });

  it('keeps exact usage available if active-run projection fails', async () => {
    const request = vi.fn(async (method: string, params: { key?: string }) => {
      if (method === 'sessions.list') throw new Error('list unavailable');
      return { session: { key: params.key, sessionId: 'gateway-1' } };
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

    expect(result.session).toMatchObject({ sessionId: 'gateway-1' });
    expect(result.session).not.toHaveProperty('hasActiveRun');
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
      usageSource: 'estimate',
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
      hasActiveRun: true,
    });
  });

  it('does not present a previous total as finalized while the current run is active', () => {
    expect(
      readUsage({
        totalTokens: 21_000,
        totalTokensFresh: true,
        hasActiveRun: true,
        updatedAt: 300,
        contextWindow: 200_000,
      }),
    ).toMatchObject({
      totalTokens: 21_000,
      usageSource: 'reported',
      usageUpdatedAt: 300,
      hasActiveRun: true,
    });
  });

  it('treats an active status as authoritative over a contradictory idle flag', () => {
    expect(
      readUsage({
        totalTokens: 21_000,
        totalTokensFresh: true,
        hasActiveRun: false,
        status: 'running',
        contextWindow: 200_000,
        contextBudgetStatus: { estimatedPromptTokens: 32_500 },
      }),
    ).toMatchObject({
      totalTokens: 32_500,
      usageSource: 'estimate',
      hasActiveRun: true,
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

  it('uses Gateway checkpoint count when the session row omits compactionCount', () => {
    expect(
      readUsage({
        totalTokens: 9_000,
        contextWindow: 200_000,
        compactionCheckpointCount: 2,
      }),
    ).toMatchObject({
      totalTokens: 9_000,
      usageSource: 'reported',
      compactionCount: 2,
    });
  });

  it('identifies and timestamps live estimates separately from final reported usage', () => {
    expect(
      readUsage({
        totalTokens: 90_362,
        totalTokensFresh: true,
        status: 'running',
        updatedAt: 300,
        contextWindow: 200_000,
        contextBudgetStatus: {
          estimatedPromptTokens: 147_347,
          updatedAt: 200,
        },
      }),
    ).toMatchObject({
      totalTokens: 147_347,
      usageSource: 'estimate',
      usageUpdatedAt: 200,
    });

    expect(
      readUsage({
        totalTokens: 90_362,
        totalTokensFresh: true,
        hasActiveRun: false,
        status: 'done',
        updatedAt: 300,
        contextWindow: 200_000,
        contextBudgetStatus: {
          estimatedPromptTokens: 147_347,
          updatedAt: 200,
        },
      }),
    ).toMatchObject({
      totalTokens: 90_362,
      usageSource: 'reported',
      usageUpdatedAt: 300,
      hasActiveRun: false,
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
