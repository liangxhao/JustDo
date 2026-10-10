// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';

import JustDoChatWrapper, { type JustDoChatWrapperRef } from './JustDoChatWrapper';

const nativeKey = 'agent:main:native-worktree-fixture';
const fixture = vi.hoisted(() => ({
  session: { id: 'native-product-session', agentId: 'main', nativeSessionKey: '' },
}));
vi.mock('react-redux', () => ({ useSelector: () => fixture.session }));
vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));
vi.mock('./ChatMessageDisplay', () => ({ default: () => <div /> }));

beforeEach(() => {
  fixture.session.nativeSessionKey = nativeKey;
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
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
