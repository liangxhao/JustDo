import { afterEach, expect, it, vi } from 'vitest';

import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';

import { sendCollaborationMemberMessage } from './collaborationContinueSubmission';

vi.mock('@/features/cowork/coworkService', () => ({ coworkService: {} }));

const target = {
  sourceSessionId: 'source',
  sourceAgentId: 'main',
  roomId: 'room',
  targetAgentId: 'reviewer',
  targetSessionId: 'peer',
  targetSessionKey: 'agent:reviewer:justdo:peer',
};
const controllers: ChatController[] = [];
afterEach(() => {
  controllers.splice(0).forEach(controller => controller.disconnect());
});

function fixture() {
  const controller = new ChatController();
  controllers.push(controller);
  const request = vi.fn().mockResolvedValue({ runId: 'native-member-run', status: 'accepted' });
  Object.assign(controller.state, {
    client: { request, stop: vi.fn() },
    connected: true,
    sessionKey: target.targetSessionKey,
    currentSessionId: 'native-peer',
    initialHistoryReady: true,
  });
  const service = {
    reconcileSessionPermissionMode: vi.fn().mockResolvedValue({ success: true }),
    beginSessionRun: vi.fn().mockResolvedValue({ id: 'member-timing' }),
    bindSessionRun: vi.fn().mockResolvedValue(undefined),
    markSessionRunUnknown: vi.fn().mockResolvedValue(undefined),
    failSessionRun: vi.fn().mockResolvedValue(undefined),
  };
  const beforeSend = vi.fn().mockResolvedValue(undefined);
  const send = () =>
    sendCollaborationMemberMessage(
      controller,
      target,
      'Review this change',
      [],
      'agent-team-member-request',
      vi.fn(),
      beforeSend,
      service,
    );
  return { controller, request, service, beforeSend, send };
}

it('sends native chat.send only to the selected peer and records its run under the peer', async () => {
  const { request, service, send } = fixture();
  expect(await send()).toBe('target_accepted');
  expect(request).toHaveBeenCalledExactlyOnceWith(
    'chat.send',
    expect.objectContaining({
      sessionKey: target.targetSessionKey,
      sessionId: 'native-peer',
      message: 'Review this change',
      idempotencyKey: 'agent-team-member-request',
    }),
  );
  expect(service.reconcileSessionPermissionMode).toHaveBeenCalledExactlyOnceWith('peer');
  expect(service.beginSessionRun).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ sessionId: 'peer' }),
  );
  expect(service.bindSessionRun).toHaveBeenCalledExactlyOnceWith(
    'member-timing',
    'native-member-run',
    'peer',
  );
});

it.each(['source-key', 'loading', 'busy', 'queued', 'disconnected', 'history-error'])(
  'rejects %s before recording or sending a turn',
  async condition => {
    const { controller, request, service, send } = fixture();
    if (condition === 'source-key') controller.state.sessionKey = 'agent:main:justdo:source';
    if (condition === 'loading') controller.state.initialHistoryReady = false;
    if (condition === 'busy') controller.state.chatSending = true;
    if (condition === 'queued')
      vi.spyOn(controller, 'hasUnconfirmedQueuedInput').mockReturnValue(true);
    if (condition === 'disconnected') controller.state.connected = false;
    if (condition === 'history-error') controller.state.historyReadFailed = true;
    await expect(send()).rejects.toThrow('collaborationContinuationUnavailable');
    expect(request).not.toHaveBeenCalled();
    expect(service.beginSessionRun).not.toHaveBeenCalled();
  },
);

it('does not send after a member incarnation changes during permission preparation', async () => {
  const { controller, request, service, send } = fixture();
  service.reconcileSessionPermissionMode.mockImplementation(async () => {
    controller.state.currentSessionId = 'replacement-peer';
    return { success: true };
  });
  await expect(send()).rejects.toThrow('collaborationContinuationUnavailable');
  expect(request).not.toHaveBeenCalled();
  expect(service.beginSessionRun).not.toHaveBeenCalled();
});

it('invalidates a prepared send across a reconnect on the same client', async () => {
  const { controller, request, service, send } = fixture();
  service.beginSessionRun.mockImplementation(async () => {
    controller.state.hello = {} as never;
    return { id: 'member-timing' };
  });
  await expect(send()).rejects.toThrow('collaborationContinuationUnavailable');
  expect(request).not.toHaveBeenCalled();
  expect(service.failSessionRun).toHaveBeenCalledExactlyOnceWith('peer', 'member-timing');
});

it('rechecks the original stop generation after permission and run preparation before sending', async () => {
  const { request, service, beforeSend, send } = fixture();
  beforeSend.mockRejectedValue(new Error('collaborationStateConflict'));
  await expect(send()).rejects.toThrow('collaborationStateConflict');
  expect(service.reconcileSessionPermissionMode).toHaveBeenCalledWith('peer');
  expect(service.beginSessionRun).toHaveBeenCalledOnce();
  expect(beforeSend).toHaveBeenCalledOnce();
  expect(request).not.toHaveBeenCalled();
  expect(service.failSessionRun).toHaveBeenCalledExactlyOnceWith('peer', 'member-timing');
});

it('retains a lost native ACK as unknown for the peer, without a retry or source fallback', async () => {
  const { request, service, send } = fixture();
  request.mockRejectedValue(new Error('connection lost'));
  expect(await send()).toBe('unknown');
  expect(request).toHaveBeenCalledOnce();
  expect(service.markSessionRunUnknown).toHaveBeenCalledExactlyOnceWith({
    sessionId: 'peer',
    id: 'member-timing',
  });
  expect(service.failSessionRun).not.toHaveBeenCalled();
});

it('keeps a transport-confirmed unsent message retryable instead of freezing it as unknown', async () => {
  const { controller, request, service, send } = fixture();
  request.mockRejectedValue(Object.assign(new Error('not connected'), { requestSent: false }));
  await expect(send()).rejects.toThrow('not connected');
  expect(request).toHaveBeenCalledOnce();
  expect(service.markSessionRunUnknown).not.toHaveBeenCalled();
  expect(service.failSessionRun).toHaveBeenCalledExactlyOnceWith('peer', 'member-timing');
  expect(controller.state.chatSending).toBe(false);
});

it('settles a definitive native rejection only against the peer receipt', async () => {
  const { request, service, send } = fixture();
  request.mockRejectedValue(
    Object.assign(new Error('rejected'), { gatewayCode: 'INVALID_REQUEST' }),
  );
  await expect(send()).rejects.toThrow('rejected');
  expect(service.failSessionRun).toHaveBeenCalledExactlyOnceWith('peer', 'member-timing');
  expect(service.markSessionRunUnknown).not.toHaveBeenCalled();
});
