import { describe, expect, it, vi } from 'vitest';

import {
  createSingleFlightTtlLookup,
  loadCoworkSessionDetails,
  queryGatewaySession,
  readAvailableUsage,
  readGatewaySessionId,
  readSessionGoal,
  readUsage,
} from './sessionRuntime';

describe('loadCoworkSessionDetails', () => {
  const localSession = {
    id: 'local-session-1',
    title: 'Session',
    status: 'completed' as const,
    pinned: false,
    cwd: 'E:\\workspace',
    executionMode: 'local' as const,
    permissionMode: 'full' as const,
    activeSkillIds: [],
    agentId: 'main',
    createdAt: 1,
    updatedAt: 2,
  };

  it('uses raw Gateway usage for statistics, tokens, models, and Session ID', async () => {
    const getGatewaySessionUsage = vi.fn().mockResolvedValue({
      input: 30,
      output: 3,
      cacheRead: 4,
      cacheWrite: 0,
      totalTokens: 41,
      messageCounts: { total: 4, user: 2, assistant: 2, toolCalls: 1 },
      modelUsage: [
        { provider: 'openai', model: 'gpt-5', count: 1 },
        { provider: 'anthropic', model: 'claude-sonnet-4', count: 1 },
      ],
    });
    const result = await loadCoworkSessionDetails(
      {
        getCoworkStore: () =>
          ({
            getSession: () => localSession,
            getSessionRuns: () => [],
            getAgent: () => null,
          }) as never,
        getCoworkEngineRouter: () =>
          ({
            getSessionModel: vi.fn().mockResolvedValue({
              ok: true,
              modelRef: 'google/gemini-2.5-pro',
              source: 'gateway',
            }),
          }) as never,
        getRuntime: () => null,
        getGatewaySessionUsage,
        lookupGatewaySession: vi.fn().mockResolvedValue({
          session: {
            key: 'agent:main:justdo:local-session-1',
            sessionId: 'gateway-session-1',
            modelProvider: 'openai',
            model: 'gpt-5',
          },
        }),
      },
      localSession.id,
    );

    expect(result).toMatchObject({
      success: true,
      gatewaySessionId: 'gateway-session-1',
      stats: {
        summary: null,
        messageCount: 4,
        userMessageCount: 2,
        assistantMessageCount: 2,
        toolCallCount: 1,
        models: ['openai/gpt-5', 'anthropic/claude-sonnet-4'],
        tokenUsage: { input: 30, output: 3, cacheRead: 4, cacheWrite: 0 },
        totalTokens: 37,
        hasTokenUsage: true,
      },
    });
    expect(getGatewaySessionUsage).toHaveBeenCalledWith('agent:main:justdo:local-session-1');
  });

  it('reports Gateway statistics as unavailable instead of manufacturing local zeros', async () => {
    const result = await loadCoworkSessionDetails(
      {
        getCoworkStore: () =>
          ({
            getSession: () => localSession,
            getSessionRuns: () => [],
            getAgent: () => ({ model: 'fallback/model' }),
          }) as never,
        getCoworkEngineRouter: () =>
          ({ getSessionModel: vi.fn().mockRejectedValue(new Error('offline')) }) as never,
        getRuntime: () => null,
        getGatewaySessionUsage: vi.fn().mockRejectedValue(new Error('offline')),
        lookupGatewaySession: vi.fn().mockResolvedValue({
          session: {
            key: 'agent:main:justdo:local-session-1',
            sessionId: 'gateway-session-1',
          },
        }),
      },
      localSession.id,
    );

    expect(result).toEqual({ success: false, error: 'offline' });
  });

  it('reports statistics as unavailable when the Gateway session cannot be resolved', async () => {
    const result = await loadCoworkSessionDetails(
      {
        getCoworkStore: () =>
          ({
            getSession: () => localSession,
            getSessionRuns: () => [],
            getAgent: () => null,
          }) as never,
        getCoworkEngineRouter: () =>
          ({ getSessionModel: vi.fn().mockResolvedValue(null) }) as never,
        getRuntime: () => null,
        lookupGatewaySession: vi.fn().mockResolvedValue({ error: 'Gateway offline' }),
      },
      localSession.id,
    );

    expect(result).toEqual({ success: false, error: 'Gateway offline' });
  });
});

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

  it('does not mistake a generic row id for the Gateway Session ID', () => {
    expect(readGatewaySessionId({ sessionId: ' ', id: 'gateway-session-2' })).toBeUndefined();
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
  it('keeps the persisted context snapshot when a live prompt estimate is present', () => {
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
      totalTokens: 12_000,
      contextTokens: 200_000,
      totalTokensFresh: false,
      usageSource: 'reported',
      compactionCount: 0,
    });
  });

  it('does not manufacture idle context usage from a budget estimate alone', () => {
    expect(
      readUsage({
        contextBudgetStatus: {
          justdoUsageBootstrap: true,
          estimatedPromptTokens: 211_701,
          contextTokenBudget: 180_000,
          provider: 'anthropic',
          model: 'claude-sonnet-4',
        },
      }),
    ).toEqual({
      totalTokens: 0,
      contextTokens: 0,
      totalTokensFresh: true,
      usageSource: 'reported',
      compactionCount: 0,
    });
  });

  it('ignores active budget state that was not provenance-guarded by JustDo', () => {
    expect(
      readUsage({
        hasActiveRun: true,
        contextWindow: 200_000,
        contextBudgetStatus: {
          estimatedPromptTokens: 211_701,
          updatedAt: 200,
        },
      }),
    ).toMatchObject({
      totalTokens: 0,
      usageSource: 'reported',
      hasActiveRun: true,
    });
  });

  it('does not replace an active zero when the budget marker is missing', () => {
    expect(
      readUsage({
        totalTokens: 0,
        totalTokensFresh: true,
        hasActiveRun: true,
        contextWindow: 200_000,
        contextBudgetStatus: {
          estimatedPromptTokens: 18_500,
          updatedAt: 200,
        },
      }),
    ).toMatchObject({
      totalTokens: 0,
      totalTokensFresh: true,
      usageSource: 'reported',
      hasActiveRun: true,
    });
  });

  it('does not bootstrap from stale running status after Gateway reports the run idle', () => {
    expect(
      readUsage({
        hasActiveRun: false,
        status: 'running',
        contextWindow: 200_000,
        contextBudgetStatus: {
          justdoUsageBootstrap: true,
          estimatedPromptTokens: 18_500,
          updatedAt: 200,
        },
      }),
    ).toMatchObject({
      totalTokens: 0,
      usageSource: 'reported',
      hasActiveRun: false,
    });
  });

  it('does not bootstrap from inferred status when the active-run projection is unavailable', () => {
    expect(
      readUsage({
        status: 'running',
        contextWindow: 200_000,
        contextBudgetStatus: {
          justdoUsageBootstrap: true,
          estimatedPromptTokens: 18_500,
          updatedAt: 200,
        },
      }),
    ).toMatchObject({
      totalTokens: 0,
      usageSource: 'reported',
      hasActiveRun: true,
    });
  });

  it('uses a live estimate only to bootstrap the first active context snapshot', () => {
    expect(
      readUsage({
        sessionId: 'gateway-session-1',
        hasActiveRun: true,
        contextWindow: 200_000,
        modelProvider: 'openai',
        model: 'gpt-5',
        contextBudgetStatus: {
          justdoUsageBootstrap: true,
          estimatedPromptTokens: 18_500,
          updatedAt: 200,
          provider: 'anthropic',
          model: 'claude-sonnet-4',
        },
      }),
    ).toEqual({
      totalTokens: 18_500,
      contextTokens: 200_000,
      totalTokensFresh: false,
      usageSource: 'estimate',
      usageUpdatedAt: 200,
      hasActiveRun: true,
      compactionCount: 0,
      gatewaySessionId: 'gateway-session-1',
      modelRef: 'openai/gpt-5',
    });
  });

  it('replaces an active bootstrap zero with the provenance-guarded prompt estimate', () => {
    expect(
      readUsage({
        totalTokens: 0,
        totalTokensFresh: true,
        hasActiveRun: true,
        contextWindow: 200_000,
        contextBudgetStatus: {
          justdoUsageBootstrap: true,
          estimatedPromptTokens: 9_500,
          updatedAt: 200,
        },
      }),
    ).toMatchObject({
      totalTokens: 9_500,
      totalTokensFresh: false,
      usageSource: 'estimate',
      usageUpdatedAt: 200,
    });
  });

  it('keeps an idle zero-token snapshot ahead of a stale marked estimate', () => {
    expect(
      readUsage({
        totalTokens: 0,
        totalTokensFresh: true,
        hasActiveRun: false,
        contextWindow: 200_000,
        contextBudgetStatus: {
          justdoUsageBootstrap: true,
          estimatedPromptTokens: 9_500,
          updatedAt: 200,
        },
      }),
    ).toMatchObject({
      totalTokens: 0,
      totalTokensFresh: true,
      usageSource: 'reported',
      hasActiveRun: false,
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

  it('does not let an active run replace a confirmed context snapshot with an estimate', () => {
    expect(
      readUsage({
        totalTokens: 21_000,
        totalTokensFresh: true,
        hasActiveRun: true,
        contextWindow: 200_000,
        contextBudgetStatus: {
          justdoUsageBootstrap: true,
          estimatedPromptTokens: 32_500,
        },
      }),
    ).toMatchObject({
      totalTokens: 21_000,
      totalTokensFresh: true,
      usageSource: 'reported',
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

  it('keeps an explicit idle registry flag ahead of stale active status', () => {
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
      totalTokens: 21_000,
      usageSource: 'reported',
      hasActiveRun: false,
    });
  });

  it('ignores announce budget usage and model identity on the parent session', () => {
    expect(
      readUsage({
        totalTokens: 90_362,
        totalTokensFresh: true,
        hasActiveRun: true,
        updatedAt: 300,
        contextWindow: 200_000,
        modelProvider: 'openai',
        model: 'gpt-5',
        contextBudgetStatus: {
          estimatedPromptTokens: 211_701,
          updatedAt: 400,
          provider: 'anthropic',
          model: 'claude-sonnet-4',
        },
      }),
    ).toMatchObject({
      totalTokens: 90_362,
      totalTokensFresh: true,
      usageSource: 'reported',
      usageUpdatedAt: 300,
      modelRef: 'openai/gpt-5',
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

  it('uses the reported snapshot timestamp during both active and idle states', () => {
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
      totalTokens: 90_362,
      usageSource: 'reported',
      usageUpdatedAt: 300,
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

describe('readAvailableUsage', () => {
  it('keeps OpenClaw zero-token snapshots available to the UI', () => {
    expect(
      readAvailableUsage({ totalTokens: 0, totalTokensFresh: true, contextTokens: 200_000 }),
    ).toMatchObject({
      totalTokens: 0,
      totalTokensFresh: true,
      usageSource: 'reported',
    });
  });

  it('distinguishes a missing snapshot from a reported zero', () => {
    expect(readAvailableUsage({ contextTokens: 200_000 })).toBeUndefined();
  });
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
