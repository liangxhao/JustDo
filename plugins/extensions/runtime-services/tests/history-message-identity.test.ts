import { beforeEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ session: vi.fn(), transcript: vi.fn() }));
vi.mock('openclaw/plugin-sdk/logging-core', () => ({
  redactSensitiveText: (value: string) => value,
}));
vi.mock('openclaw/plugin-sdk/session-store-runtime', () => ({
  getSessionEntry: native.session,
  loadTranscriptEventsSync: vi.fn(),
}));
vi.mock('openclaw/plugin-sdk/session-transcript-runtime', () => ({
  readVisibleSessionTranscriptMessageEntries: native.transcript,
}));
vi.mock('openclaw/plugin-sdk/ssrf-runtime', () => ({
  fetchWithSsrFGuard: vi.fn(),
  ssrfPolicyFromHttpBaseUrlAllowedHostname: vi.fn(),
}));
vi.mock('../agent-team', () => ({ registerAgentTeamRuntimeServices: vi.fn() }));
vi.mock('../external-mcp', () => ({ registerExternalMcp: vi.fn() }));
vi.mock('../mcp-app-history', () => ({ registerMcpAppHistory: vi.fn() }));
vi.mock('../model-auth', () => ({ buildBuiltinModelAuthProvider: vi.fn() }));
vi.mock('../replay-admission-observations', () => ({
  registerReplayAdmissionObservations: vi.fn(),
}));
vi.mock('../scheduled-task-history', () => ({ registerScheduledTaskHistory: vi.fn() }));

import plugin from '../index';

function fixture() {
  const handlers = new Map<
    string,
    (input: { params: unknown; respond: ReturnType<typeof vi.fn> }) => Promise<void>
  >();
  plugin.register({
    registerProvider: vi.fn(),
    registerEmbeddingProvider: vi.fn(),
    on: vi.fn(),
    registerGatewayMethod: (name: string, handler: never) => handlers.set(name, handler),
    logger: { info: vi.fn() },
  } as never);
  return async (params: Record<string, unknown>) => {
    const respond = vi.fn();
    await handlers.get('runtimeServices.historyMessage')!({ params, respond });
    return respond;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  native.session.mockReturnValue({ sessionId: 'physical-original' });
  native.transcript.mockResolvedValue([
    { entryId: 'message', message: { role: 'toolResult', content: 'original' } },
  ]);
});

it.each([null, 5, '', ' '])(
  'rejects an invalid explicit physical session identity: %s',
  async sessionId => {
    const respond = await fixture()({ sessionKey: 'key', sessionId, messageId: 'message' });
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: 'INVALID_REQUEST' }),
    );
    expect(native.transcript).not.toHaveBeenCalled();
  },
);

it('refuses a fallback after the native physical session rotates, even for the same message id', async () => {
  native.session.mockReturnValue({ sessionId: 'physical-successor' });
  const respond = await fixture()({
    sessionKey: 'key',
    sessionId: 'physical-original',
    messageId: 'message',
  });

  expect(respond).toHaveBeenCalledWith(true, { ok: false, unavailableReason: 'not_found' });
  expect(native.transcript).not.toHaveBeenCalled();
});

it('binds every chunk to the requested physical session and retires a transfer after reset', async () => {
  const request = fixture();
  const first = await request({
    sessionKey: 'key',
    sessionId: 'physical-original',
    messageId: 'message',
    maxChars: 5,
  });
  const result = first.mock.calls[0][1];
  expect(result).toMatchObject({ ok: true, complete: false, nextCursor: 5 });
  expect(native.transcript).toHaveBeenCalledExactlyOnceWith({
    sessionKey: 'key',
    sessionId: 'physical-original',
  });
  native.session.mockReturnValue({ sessionId: 'physical-successor' });

  const next = await request({
    sessionKey: 'key',
    sessionId: 'physical-original',
    messageId: 'message',
    cursor: 5,
    transferId: result.transferId,
  });

  expect(next).toHaveBeenCalledWith(true, { ok: false, unavailableReason: 'not_found' });
  expect(native.transcript).toHaveBeenCalledOnce();
});
