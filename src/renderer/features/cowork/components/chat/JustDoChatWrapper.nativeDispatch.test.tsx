// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';
import { McpAppSession } from '@/libs/openclaw-chat/gateway/mcp-app-session';

import JustDoChatWrapper, { type JustDoChatWrapperRef } from './JustDoChatWrapper';

const nativeKey = 'agent:main:native-worktree-fixture';
const fixture = vi.hoisted(() => ({
  session: { id: 'native-product-session', agentId: 'main', nativeSessionKey: '' },
}));
vi.mock('react-redux', () => ({ useSelector: () => fixture.session }));
vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));
vi.mock('./ChatMessageDisplay', () => ({ default: () => <div /> }));

beforeEach(() => {
  vi.spyOn(McpAppSession.prototype, 'discover').mockResolvedValue({ servers: [] });
  fixture.session.nativeSessionKey = nativeKey;
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      mcpApps: {
        questions: vi.fn().mockResolvedValue({ success: true, value: [] }),
        onQuestionsChanged: vi.fn(() => () => undefined),
      },
      openclaw: {
        engine: {
          getPort: vi.fn().mockResolvedValue({ success: true, port: 1 }),
          getToken: vi.fn().mockResolvedValue({ success: true, token: 'fixture' }),
        },
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function setup(
  request = vi.fn().mockResolvedValue({ ok: true, aborted: false, runIds: [] }),
) {
  const reload = vi.spyOn(ChatController.prototype, 'loadHistory').mockResolvedValue(true);
  const connect = vi.spyOn(ChatController.prototype, 'connect').mockImplementation(async function (
    this: ChatController,
  ) {
    this.state.connected = true;
    this.state.initialHistoryReady = true;
    this.state.currentSessionId = 'native-runtime-session';
    this.state.client = { request, stop: vi.fn() } as unknown as NonNullable<
      ChatController['state']['client']
    >;
  });
  const ref = createRef<JustDoChatWrapperRef>();
  render(<JustDoChatWrapper ref={ref} />);
  await waitFor(() => expect(connect).toHaveBeenCalledOnce());
  const controller = connect.mock.instances[0] as ChatController;
  act(() => controller.setPendingUserMessage('please stop'));
  const params = { sessionKey: nativeKey, idempotencyKey: 'initial-stop', message: 'please stop' };
  return { ref, controller, request, reload, params };
}

describe('actual wrapper initial native dispatch lifecycle', () => {
  it('admits the prepared first send after subscription while history is still loading', async () => {
    const { ref, controller, request, params } = await setup();
    controller.state.initialHistoryReady = false;
    controller.state.chatLoading = true;
    const internals = controller as unknown as {
      subscribedMessageSessionKey: string | null;
      suspendedRunId: string | null;
    };
    internals.subscribedMessageSessionKey = null;
    expect(ref.current!.isInitialDispatchReady(nativeKey)).toBe(false);
    internals.subscribedMessageSessionKey = nativeKey;
    expect(ref.current!.getExportSnapshot().isLoading).toBe(true);
    expect(ref.current!.isInitialDispatchReady(nativeKey)).toBe(true);
    expect(ref.current!.isInitialDispatchReady('other-session')).toBe(false);
    internals.suspendedRunId = 'unresolved-run';
    expect(ref.current!.isInitialDispatchReady(nativeKey)).toBe(false);
    internals.suspendedRunId = null;
    await act(async () => {
      await ref.current!.dispatchInitialTurn(params);
    });
    expect(request).toHaveBeenCalledWith('chat.send', params);
    controller.state.connected = false;
    expect(ref.current!.isInitialDispatchReady(nativeKey)).toBe(false);
  });

  it('retains the exact delegated send owner after an unknown transport failure', async () => {
    const request = vi.fn().mockRejectedValue(new Error('Transport lost'));
    const { ref, controller, params } = await setup(request);
    await expect(ref.current!.dispatchInitialTurn(params)).rejects.toMatchObject({
      requestSent: true,
    });
    expect(controller.state.chatRunId).toBe(params.idempotencyKey);
    expect(request).toHaveBeenCalledExactlyOnceWith('chat.send', params);
    const internal = controller as unknown as {
      handleClose(): void;
      suspendedRunId: string | null;
    };
    internal.handleClose();
    expect(internal.suspendedRunId).toBe(params.idempotencyKey);
    expect(controller.state.chatSending).toBe(true);
  });

  it('does not bind a send owner when preflight rejects the selected session', async () => {
    const { ref, controller, request, params } = await setup();
    await expect(
      ref.current!.dispatchInitialTurn({ ...params, sessionKey: 'other-session' }),
    ).rejects.toMatchObject({ requestSent: false });
    expect(controller.state.chatRunId).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it('retires a confirmed cancelled first send before its first native stream frame', async () => {
    const { ref, controller, params } = await setup(
      vi.fn().mockResolvedValue({ runId: 'initial-stop' }),
    );
    await ref.current!.dispatchInitialTurn(params);
    expect(controller.state.transcript.activeTurn).toBeNull();
    controller.settleConfirmedRun(nativeKey, params.idempotencyKey, 'aborted');
    controller.clearSending(nativeKey, params.idempotencyKey);
    controller.clearSending(nativeKey, null);
    expect(controller.state.chatSending).toBe(false);
    expect(controller.state.pendingUserMessage).toBeNull();
  });

  it('lets start-failure cleanup retire an owner after a definite client rejection', async () => {
    const request = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('Not sent'), { requestSent: false }));
    const { ref, controller, params } = await setup(request);
    await expect(ref.current!.dispatchInitialTurn(params)).rejects.toMatchObject({
      requestSent: false,
    });
    expect(request).toHaveBeenCalledExactlyOnceWith('chat.send', params);
    // CoworkView owns failed-start cleanup; the wrapper must propagate the
    // definite result without retrying or claiming a terminal execution.
    controller.clearSending(nativeKey);
    expect(controller.state.chatRunId).toBeNull();
    expect(controller.state.chatSending).toBe(false);
    expect(controller.state.transcript.terminalRunIds.has(params.idempotencyKey)).toBe(false);
  });

  it('connects a cold native worktree session using its persisted key', async () => {
    const { ref, controller } = await setup();
    expect(controller.state.sessionKey).toBe(nativeKey);
    expect(ref.current!.getExportSnapshot().sessionKey).toBe(nativeKey);
  });

  it('retires the optimistic initial control prompt so a normal next message can be sent', async () => {
    const { ref, controller, request, reload, params } = await setup();
    expect(controller.state.chatSending).toBe(true);
    await act(async () => {
      await expect(ref.current!.dispatchInitialTurn(params)).resolves.toEqual({
        ok: true,
        aborted: false,
        runIds: [],
      });
    });
    expect(controller.state.chatSending).toBe(false);
    expect(controller.state.pendingUserMessage).toBeNull();
    expect(reload).toHaveBeenCalledExactlyOnceWith(true);
    request.mockResolvedValueOnce({ runId: 'normal-next-message', status: 'ok' });
    await act(async () => {
      await expect(
        ref.current!.sendMessage('Now explore this scenario', [], undefined, {
          clientTurnId: 'normal-next-message',
        }),
      ).resolves.toBeUndefined();
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual(['chat.send', 'chat.send']);
  });

  it('does not clear a replacement run after a late control acknowledgement', async () => {
    let acknowledge!: (receipt: unknown) => void;
    const response = new Promise(resolve => {
      acknowledge = resolve;
    });
    const { ref, controller, params } = await setup(vi.fn(() => response));
    const pending = ref.current!.dispatchInitialTurn(params);
    controller.state.chatRunId = 'replacement-run';
    acknowledge({ ok: true, aborted: false, runIds: [] });
    await act(async () => {
      await pending;
    });
    expect(controller.state.chatSending).toBe(true);
    expect(controller.state.chatRunId).toBe('replacement-run');
    expect(controller.state.pendingUserMessage).not.toBeNull();
  });

  it('does not mutate another selected conversation after a late control acknowledgement', async () => {
    let acknowledge!: (receipt: unknown) => void;
    const response = new Promise(resolve => {
      acknowledge = resolve;
    });
    const { ref, controller, reload, params } = await setup(vi.fn(() => response));
    const pending = ref.current!.dispatchInitialTurn(params);
    controller.state.sessionKey = 'agent:main:other';
    controller.state.chatRunId = 'other-run';
    acknowledge({ ok: true, aborted: false, runIds: [] });
    await act(async () => {
      await pending;
    });
    expect(controller.state.chatSending).toBe(true);
    expect(controller.state.chatRunId).toBe('other-run');
    expect(reload).not.toHaveBeenCalled();
  });
});
