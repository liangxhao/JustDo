import { expect, test, vi } from 'vitest';

import { hasSessionBranchCreationResponse, readSessionBranchRunIds } from './sessionBranching';

const sessionKey = 'agent:main:justdo:branch';
const cut = { role: 'assistant', __openclaw: { id: 'cut', runId: 'selected' } };
const page = (overrides = {}) => ({
  sessionId: 'physical',
  messages: [cut],
  deltaCursor: 'snapshot',
  totalMessages: 1,
  hasMore: false,
  ...overrides,
});
const unchanged = (overrides = {}) => ({
  kind: 'delta',
  messages: [],
  deltaCursor: 'current',
  sessionInfo: { sessionId: 'physical' },
  ...overrides,
});

test('reads bounded native pages and returns only run identities in the stable target branch', async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(
      page({
        totalMessages: 2,
        hasMore: true,
        nextOffset: 1,
      }),
    )
    .mockResolvedValueOnce(
      page({
        messages: [{ role: 'assistant', __openclaw: { id: 'earlier', runId: 'kept' } }],
        totalMessages: 2,
      }),
    )
    .mockResolvedValueOnce(unchanged());
  expect(await readSessionBranchRunIds(request, sessionKey, 'physical', 'cut')).toEqual(
    new Set(['selected', 'kept']),
  );
  expect(request).toHaveBeenNthCalledWith(1, 'chat.history', {
    sessionKey,
    limit: 250,
    maxChars: 1,
    maxBytes: 262144,
  });
  expect(request).toHaveBeenNthCalledWith(2, 'chat.history', {
    sessionKey,
    offset: 1,
    limit: 250,
    maxChars: 1,
    maxBytes: 262144,
  });
  expect(request).toHaveBeenLastCalledWith('chat.history', {
    sessionKey,
    cursor: 'snapshot',
    limit: 1,
    maxChars: 1,
    maxBytes: 4096,
  });
});

test.each([
  page({ sessionId: 'replaced' }),
  page({ messages: [{ ...cut, role: 'user' }] }),
  page({ messages: [{ role: 'assistant', __openclaw: { id: 'other', runId: 'wrong' } }] }),
  page({ messages: [{ role: 'assistant', __openclaw: { id: 'cut' } }] }),
  page({ deltaCursor: undefined }),
  page({ hasMore: true, nextOffset: 0 }),
  page({ hasMore: true, nextOffset: 1 }),
])('does not infer membership from incomplete or foreign native pages: %j', async raw => {
  const request = vi.fn().mockResolvedValueOnce(raw).mockResolvedValue(unchanged());
  expect(await readSessionBranchRunIds(request, sessionKey, 'physical', 'cut')).toEqual(new Set());
});

test.each([
  unchanged({ kind: 'reset' }),
  unchanged({ sessionInfo: { sessionId: 'replacement' } }),
  unchanged({ sessionInfo: { sessionId: 'physical', hasActiveRun: true } }),
  unchanged({ messages: [{ role: 'assistant', runId: 'new' }] }),
  unchanged({ activity: [{}] }),
])(
  'discards collected identities when final cursor verification changes: %j',
  async verification => {
    const request = vi.fn().mockResolvedValueOnce(page()).mockResolvedValueOnce(verification);
    expect(await readSessionBranchRunIds(request, sessionKey, 'physical', 'cut')).toEqual(
      new Set(),
    );
  },
);

test('discards earlier page identities when a later page fails or changes total', async () => {
  for (const failure of [new Error('disconnected'), page({ totalMessages: 3 })]) {
    const request = vi
      .fn()
      .mockResolvedValueOnce(page({ totalMessages: 2, hasMore: true, nextOffset: 1 }));
    if (failure instanceof Error) request.mockRejectedValueOnce(failure);
    else request.mockResolvedValueOnce(failure);
    expect(await readSessionBranchRunIds(request, sessionKey, 'physical', 'cut')).toEqual(
      new Set(),
    );
  }
});

test('caps optional metadata scanning instead of walking an unbounded history', async () => {
  const request = vi.fn(async (_method, params) =>
    page({
      totalMessages: 100000,
      hasMore: true,
      nextOffset: (params.offset ?? 0) + 1,
    }),
  );
  expect(await readSessionBranchRunIds(request, sessionKey, 'physical')).toEqual(new Set());
  expect(request).toHaveBeenCalledTimes(40);
});

test('whole copies also require a stable native membership set', async () => {
  const request = vi.fn().mockResolvedValueOnce(page()).mockResolvedValueOnce(unchanged());
  expect(await readSessionBranchRunIds(request, sessionKey, 'physical')).toEqual(
    new Set(['selected']),
  );
});

test('distinguishes a correlated Gateway rejection from a lost response', () => {
  expect(
    hasSessionBranchCreationResponse(
      Object.assign(new Error('rejected'), { gatewayCode: 'INVALID_REQUEST' }),
    ),
  ).toBe(true);
  expect(
    hasSessionBranchCreationResponse(Object.assign(new Error('offline'), { requestSent: false })),
  ).toBe(true);
  expect(
    hasSessionBranchCreationResponse(
      Object.assign(new Error('timeout'), { code: 'CLIENT_TIMEOUT', requestSent: true }),
    ),
  ).toBe(false);
});
