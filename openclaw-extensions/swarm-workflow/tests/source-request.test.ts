import { expect, it, vi } from 'vitest';

import { readLatestWorkflowUser } from '../service/source-request';

const sessionKey = 'agent:main:justdo:source-request';
const user = (id: string) => ({ role: 'user', content: id, idempotencyKey: id });
const preparations = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    role: 'toolResult',
    content: `Prepared ${index}`,
  }));

function fixture(messages: Array<Record<string, unknown>>) {
  const page = (params: Record<string, unknown>) => {
    const limit = Number(params.limit);
    const end = Math.max(0, messages.length - Number(params.offset ?? 0));
    const start = Math.max(0, end - limit);
    return {
      messages: messages.slice(start, end),
      hasMore: start > 0,
      ...(start > 0 ? { nextOffset: messages.length - start } : {}),
      totalMessages: messages.length,
      sessionId: 'native-source',
    };
  };
  const rpc = vi.fn(async (_method: string, params: Record<string, unknown>) => page(params));
  const assertCurrent = vi.fn();
  return {
    messages,
    page,
    rpc,
    assertCurrent,
    read: () => readLatestWorkflowUser({ sessionKey, rpc, assertCurrent }),
  };
}

it('finds the current user beyond twenty preparation records through public numeric pagination', async () => {
  const current = user('current');
  const f = fixture([current, ...preparations(45)]);

  expect(await f.read()).toBe(current);
  expect(f.rpc.mock.calls.map(([, params]) => params.offset ?? 0)).toEqual([0, 20, 0, 40, 0]);
  expect(
    f.rpc.mock.calls.every(
      ([method, params]) =>
        method === 'chat.history' && params.limit === 20 && params.sessionKey === sessionKey,
    ),
  ).toBe(true);
  expect(f.assertCurrent).toHaveBeenCalledTimes(f.rpc.mock.calls.length * 2 + 1);
});

it('returns the latest user rather than searching past it for an older launch request', async () => {
  const current = user('new-user');
  const f = fixture([user('old-launch'), ...preparations(25), current, ...preparations(24)]);

  expect(await f.read()).toBe(current);
  expect(f.rpc.mock.calls.map(([, params]) => params.offset ?? 0)).toEqual([0, 20, 0]);
});

it('returns no user only after all available pages have been read', async () => {
  const f = fixture(preparations(45));

  expect(await f.read()).toBeUndefined();
  expect(f.rpc.mock.calls.map(([, params]) => params.offset ?? 0)).toEqual([0, 20, 0, 40, 0]);
});

it('accepts a complete single page without requiring pagination metadata', async () => {
  const rpc = vi.fn(async () => ({ messages: [] }));

  expect(await readLatestWorkflowUser({ sessionKey, rpc, assertCurrent: vi.fn() })).toBeUndefined();
  expect(rpc).toHaveBeenCalledTimes(1);
});

it.each([undefined, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 100])(
  'rejects an invalid first pagination offset %s',
  async nextOffset => {
    const rpc = vi.fn(async () => ({
      messages: preparations(20),
      hasMore: true,
      totalMessages: 100,
      nextOffset,
    }));

    await expect(
      readLatestWorkflowUser({ sessionKey, rpc, assertCurrent: vi.fn() }),
    ).rejects.toThrow('pagination offset');
    expect(rpc).toHaveBeenCalledTimes(1);
  },
);

it.each([10, 20])('rejects a non-increasing subsequent offset %s', async nextOffset => {
  const f = fixture(preparations(80));
  f.rpc.mockImplementation(async (_method, params) => ({
    ...f.page(params),
    ...(params.offset === 20 ? { nextOffset } : {}),
  }));

  await expect(f.read()).rejects.toThrow('pagination offset');
  expect(f.rpc.mock.calls.map(([, params]) => params.offset ?? 0)).toEqual([0, 20, 0]);
});

it.each([undefined, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'requires a safe stable total for multiple pages: %s',
  async totalMessages => {
    const rpc = vi.fn(async () => ({
      messages: preparations(20),
      hasMore: true,
      nextOffset: 20,
      totalMessages,
    }));

    await expect(
      readLatestWorkflowUser({ sessionKey, rpc, assertCurrent: vi.fn() }),
    ).rejects.toThrow('stable message count');
    expect(rpc).toHaveBeenCalledTimes(1);
  },
);

it('rejects a changed total in an older page', async () => {
  const f = fixture([user('current'), ...preparations(25)]);
  f.rpc.mockImplementation(async (_method, params) => ({
    ...f.page(params),
    ...(params.offset ? { totalMessages: f.messages.length + 1 } : {}),
  }));

  await expect(f.read()).rejects.toThrow('history changed');
});

it('rechecks the live head before returning a user when a new user arrives during pagination', async () => {
  const f = fixture([user('old-launch'), ...preparations(25)]);
  f.rpc.mockImplementation(async (_method, params) => {
    const result = f.page(params);
    if (params.offset) f.messages.push(user('new-user'));
    return result;
  });

  await expect(f.read()).rejects.toThrow('history changed');
  expect(f.rpc.mock.calls.map(([, params]) => params.offset ?? 0)).toEqual([0, 20, 0]);
});

it('detects a changed head even when the total message count is unchanged', async () => {
  const f = fixture([user('old-launch'), ...preparations(25)]);
  f.rpc.mockImplementation(async (_method, params) => {
    const result = f.page(params);
    if (params.offset) f.messages[f.messages.length - 1] = user('replacement-user');
    return result;
  });

  await expect(f.read()).rejects.toThrow('history changed');
});

it('checks current authority before an RPC and does not issue the request when it is revoked', async () => {
  const f = fixture([user('current')]);
  f.assertCurrent.mockImplementation(() => {
    throw new Error('Admission revoked');
  });

  await expect(f.read()).rejects.toThrow('Admission revoked');
  expect(f.rpc).not.toHaveBeenCalled();
});

it('checks current authority immediately after an RPC and does not return its stale user', async () => {
  const f = fixture([user('current')]);
  f.assertCurrent
    .mockImplementationOnce(() => {})
    .mockImplementation(() => {
      throw new Error('Admission revoked');
    });

  await expect(f.read()).rejects.toThrow('Admission revoked');
  expect(f.rpc).toHaveBeenCalledTimes(1);
});

it('propagates RPC failure without retrying or bypassing the authority check', async () => {
  const f = fixture([user('current')]);
  f.rpc.mockRejectedValue(new Error('Gateway unavailable'));

  await expect(f.read()).rejects.toThrow('Gateway unavailable');
  expect(f.rpc).toHaveBeenCalledTimes(1);
  expect(f.assertCurrent).toHaveBeenCalledTimes(2);
});

it('fails at the fifty-page budget instead of treating an unsearched user as absent', async () => {
  const f = fixture([user('beyond-budget'), ...preparations(1000)]);

  await expect(f.read()).rejects.toThrow('lookup budget');
  expect(f.rpc.mock.calls.filter(([, params]) => params.offset !== undefined)).toHaveLength(49);
  expect(Math.max(...f.rpc.mock.calls.map(([, params]) => Number(params.offset ?? 0)))).toBe(980);
});

it.each([null, {}, { messages: [null] }, { messages: [], hasMore: 'true' }])(
  'rejects malformed history payloads',
  async response => {
    const rpc = vi.fn(async () => response);

    await expect(
      readLatestWorkflowUser({ sessionKey, rpc, assertCurrent: vi.fn() }),
    ).rejects.toThrow('history page');
  },
);
