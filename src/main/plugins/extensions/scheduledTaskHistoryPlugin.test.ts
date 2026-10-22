import { beforeEach, expect, test, vi } from 'vitest';

import { registerScheduledTaskHistory } from '../../../../plugins/extensions/runtime-services/scheduled-task-history';

const sdk = vi.hoisted(() => ({ resolve: vi.fn(), read: vi.fn(), storePath: vi.fn() }));
vi.mock('openclaw/plugin-sdk/session-store-paths', () => ({
  resolveStorePath: sdk.storePath,
}));
vi.mock('openclaw/plugin-sdk/session-store-runtime', () => ({
  resolveTranscriptSessionKeyBySessionId: sdk.resolve,
}));
vi.mock('openclaw/plugin-sdk/session-transcript-runtime', () => ({
  readVisibleSessionTranscriptMessageEntries: sdk.read,
}));

const key = 'agent:main:cron:task:run:old-id';
const parent = 'agent:main:cron:task';
async function request(params: Record<string, unknown>, store?: string) {
  const register = vi.fn();
  registerScheduledTaskHistory({
    registerGatewayMethod: register,
    runtime: { config: { current: () => ({ session: { store } }) } },
  } as never);
  expect(register.mock.calls[0][2]).toEqual({ scope: 'operator.admin' });
  const respond = vi.fn();
  await register.mock.calls[0][1]({ params, respond });
  return respond;
}
beforeEach(() => {
  vi.resetAllMocks();
  sdk.storePath.mockReturnValue('/default/sessions.json');
});

test('reads a historical cron window whose run alias no longer exists', async () => {
  sdk.resolve.mockReturnValue(parent);
  sdk.read.mockResolvedValue([
    { entryId: 'message-1', message: { role: 'assistant', content: 'old result' } },
  ]);
  const respond = await request({ sessionKey: key, sessionId: 'old-id' });
  expect(sdk.read).toHaveBeenCalledWith({
    agentId: 'main',
    sessionKey: parent,
    sessionId: 'old-id',
    storePath: '/default/sessions.json',
  });
  expect(JSON.parse(respond.mock.calls[0][1].chunk)).toEqual([
    { id: 'message-1', role: 'assistant', content: 'old result' },
  ]);
});

test('uses the configured agent store for both ownership checks and transcript reads', async () => {
  sdk.storePath.mockReturnValue('/custom/main/sessions.json');
  sdk.resolve.mockImplementation(identity =>
    identity.storePath === '/custom/main/sessions.json' ? parent : undefined,
  );
  sdk.read.mockResolvedValue([
    { entryId: 'm', message: { role: 'assistant', content: 'configured store result' } },
  ]);

  const respond = await request(
    { sessionKey: key, sessionId: 'old-id' },
    '/custom/{agentId}/sessions.json',
  );

  expect(sdk.storePath).toHaveBeenCalledWith('/custom/{agentId}/sessions.json', {
    agentId: 'main',
  });
  expect(sdk.resolve).toHaveBeenCalledTimes(2);
  for (const [identity] of sdk.resolve.mock.calls) {
    expect(identity).toEqual({
      agentId: 'main',
      sessionId: 'old-id',
      storePath: '/custom/main/sessions.json',
    });
  }
  expect(sdk.read).toHaveBeenCalledWith({
    agentId: 'main',
    sessionId: 'old-id',
    sessionKey: parent,
    storePath: '/custom/main/sessions.json',
  });
  expect(respond.mock.calls[0][0]).toBe(true);
});

test('reports a missing online window without reading or restoring deletion archives', async () => {
  sdk.resolve.mockReturnValue(undefined);
  const respond = await request({ sessionKey: key, sessionId: 'old-id' });
  expect(respond).toHaveBeenCalledWith(true, { unavailableReason: 'not-found' });
  expect(sdk.read).not.toHaveBeenCalled();
});

test.each([
  { sessionKey: key, sessionId: 'different-id' },
  { sessionKey: 'agent:main:justdo:private', sessionId: 'old-id' },
])('rejects a mismatched or non-cron selector', async params => {
  const respond = await request(params);
  expect(respond.mock.calls[0][0]).toBe(false);
  expect(sdk.read).not.toHaveBeenCalled();
});

test('rejects a physical window owned by another task', async () => {
  sdk.resolve.mockReturnValue('agent:main:cron:other');
  const respond = await request({ sessionKey: key, sessionId: 'old-id' });
  expect(respond.mock.calls[0][0]).toBe(false);
  expect(sdk.read).not.toHaveBeenCalled();
});

test('rejects deletion during an asynchronous read', async () => {
  sdk.resolve.mockReturnValueOnce(parent).mockReturnValueOnce(undefined);
  sdk.read.mockResolvedValue([
    { entryId: 'm', message: { role: 'assistant', content: 'deleted' } },
  ]);
  expect((await request({ sessionKey: key, sessionId: 'old-id' })).mock.calls[0][0]).toBe(false);
});

test('bounds response chunks and rejects a stale next-page version', async () => {
  sdk.resolve.mockReturnValue(parent);
  sdk.read.mockResolvedValue([
    { entryId: 'm', message: { role: 'assistant', content: 'x'.repeat(300_000) } },
  ]);
  const first = (await request({ sessionKey: key, sessionId: 'old-id' })).mock.calls[0][1];
  expect(first.chunk.length).toBe(256 * 1024);
  expect(first.nextOffset).toBe(first.chunk.length);
  const stale = await request({
    sessionKey: key,
    sessionId: 'old-id',
    offset: first.nextOffset,
    version: 'stale',
  });
  expect(stale.mock.calls[0][0]).toBe(false);
});
