import { describe, expect, test, vi } from 'vitest';

import type { CoworkStore } from '../../data/coworkStore';
import { searchCoworkSessionMessages } from './openclawSessionSearch';

const summary = (id: string, agentId: string) => ({
  id,
  title: id,
  status: 'idle' as const,
  pinned: false,
  agentId,
  createdAt: 1,
  updatedAt: 1,
});

describe('searchCoworkSessionMessages', () => {
  test('searches each agent scope and maps Gateway keys back to local session ids', async () => {
    const store = {
      listSessions: () => [summary('main-session', 'main'), summary('work-session', 'Worker_ONE')],
    } as unknown as CoworkStore;
    const requestGateway = vi.fn(async (_method: string, params?: unknown) => {
      const agentId = (params as { agentId: string }).agentId;
      const localSessionId = agentId === 'main' ? 'main-session' : 'work-session';
      return {
        results: [
          {
            sessionKey: `agent:${agentId}:justdo:${localSessionId}`,
            sessionId: `gateway-${agentId}`,
            messageId: `message-${agentId}`,
            role: agentId === 'main' ? 'user' : 'assistant',
            timestamp: 100,
            snippet: `${agentId} matched`,
            score: 2,
          },
        ],
      };
    });

    await expect(
      searchCoworkSessionMessages({ query: ' matched ', store, requestGateway }),
    ).resolves.toMatchObject({
      matches: [
        { sessionId: 'main-session', role: 'user' },
        { sessionId: 'work-session', role: 'assistant' },
      ],
    });
    expect(requestGateway).toHaveBeenCalledTimes(2);
    expect(requestGateway).toHaveBeenCalledWith('sessions.search', {
      agentId: 'main',
      sessionKeys: ['agent:main:justdo:main-session'],
      query: 'matched',
      limit: 25,
    });
    expect(requestGateway).toHaveBeenCalledWith('sessions.search', {
      agentId: 'worker_one',
      sessionKeys: ['agent:worker_one:justdo:work-session'],
      query: 'matched',
      limit: 25,
    });
  });

  test('returns immediately for an empty query', async () => {
    const requestGateway = vi.fn();
    const store = { listSessions: vi.fn() } as unknown as CoworkStore;

    await expect(
      searchCoworkSessionMessages({ query: '  ', store, requestGateway }),
    ).resolves.toEqual({
      matches: [],
      indexing: false,
      truncated: false,
      partial: false,
    });
    expect(store.listSessions).not.toHaveBeenCalled();
    expect(requestGateway).not.toHaveBeenCalled();
  });

  test('rejects queries beyond the Gateway protocol bound', async () => {
    const requestGateway = vi.fn();
    const store = { listSessions: vi.fn() } as unknown as CoworkStore;

    await expect(
      searchCoworkSessionMessages({ query: 'x'.repeat(4097), store, requestGateway }),
    ).rejects.toThrow('must not exceed 4096');
    expect(store.listSessions).not.toHaveBeenCalled();
    expect(requestGateway).not.toHaveBeenCalled();
  });

  test('bisects truncated batches so one verbose session cannot hide another', async () => {
    const store = {
      listSessions: () => [summary('first', 'main'), summary('second', 'main')],
    } as unknown as CoworkStore;
    const requestGateway = vi.fn(async (_method: string, params?: unknown) => {
      const sessionKeys = (params as { sessionKeys: string[] }).sessionKeys;
      if (sessionKeys.length > 1) {
        return {
          results: Array.from({ length: 25 }, (_, index) => ({
            sessionKey: sessionKeys[0],
            sessionId: 'gateway-first',
            messageId: `root-${index}`,
            role: 'assistant',
            timestamp: index,
            snippet: `root ${index}`,
            score: 1,
          })),
          truncated: true,
        };
      }
      const localId = sessionKeys[0].endsWith(':first') ? 'first' : 'second';
      return {
        results: [
          {
            sessionKey: sessionKeys[0],
            sessionId: `gateway-${localId}`,
            messageId: `message-${localId}`,
            role: 'user',
            timestamp: localId === 'first' ? 10 : 20,
            snippet: `${localId} match`,
            score: localId === 'first' ? 1 : 2,
          },
        ],
      };
    });

    const result = await searchCoworkSessionMessages({
      query: 'match',
      store,
      requestGateway,
    });

    expect(result.matches.map(match => match.sessionId)).toEqual(['second', 'first']);
    expect(result.truncated).toBe(false);
    expect(requestGateway).toHaveBeenCalledTimes(3);
  });

  test('chunks large agent scopes at the Gateway session-key bound', async () => {
    const store = {
      listSessions: () =>
        Array.from({ length: 201 }, (_, index) => summary(`session-${index}`, 'main')),
    } as unknown as CoworkStore;
    const requestGateway = vi.fn().mockResolvedValue({ results: [] });

    await searchCoworkSessionMessages({ query: 'match', store, requestGateway });

    expect(requestGateway).toHaveBeenCalledTimes(2);
    expect((requestGateway.mock.calls[0][1] as { sessionKeys: string[] }).sessionKeys).toHaveLength(
      200,
    );
    expect((requestGateway.mock.calls[1][1] as { sessionKeys: string[] }).sessionKeys).toHaveLength(
      1,
    );
  });

  test('preserves successful agent results when another agent search fails', async () => {
    const store = {
      listSessions: () => [summary('main-session', 'main'), summary('work-session', 'work')],
    } as unknown as CoworkStore;
    const requestGateway = vi.fn(async (_method: string, params?: unknown) => {
      const agentId = (params as { agentId: string }).agentId;
      if (agentId === 'work') throw new Error('work agent unavailable');
      return {
        results: [
          {
            sessionKey: 'agent:main:justdo:main-session',
            sessionId: 'gateway-main',
            messageId: 'message-main',
            role: 'assistant',
            timestamp: 10,
            snippet: 'main match',
            score: 1,
          },
        ],
      };
    });

    await expect(
      searchCoworkSessionMessages({ query: 'match', store, requestGateway }),
    ).resolves.toMatchObject({
      matches: [{ sessionId: 'main-session' }],
      partial: true,
    });
  });
});
