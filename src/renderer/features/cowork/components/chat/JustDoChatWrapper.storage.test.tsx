// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';

import JustDoChatWrapper, { type JustDoChatWrapperRef } from './JustDoChatWrapper';

vi.mock('./ChatMessageDisplay', () => ({ default: () => <div /> }));
const fixture = vi.hoisted(() => ({ session: { id: 'old', agentId: 'main' } }));
vi.mock('react-redux', () => ({ useSelector: () => fixture.session }));
vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

beforeEach(() => {
  fixture.session = { id: 'old', agentId: 'main' };
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

it('blocks export and sending while history is loading or failed, and retry only reloads history', async () => {
  let controller!: ChatController;
  const publish = () => (controller as unknown as { notify: () => void }).notify();
  const connect = vi.spyOn(ChatController.prototype, 'connect').mockImplementation(async function (
    this: ChatController,
  ) {
    this.state.connected = true;
    (this as unknown as { notify: () => void }).notify();
  });
  const send = vi.spyOn(ChatController.prototype, 'sendMessage').mockResolvedValue();
  const reload = vi.spyOn(ChatController.prototype, 'loadHistory').mockResolvedValue(true);
  const ref = createRef<JustDoChatWrapperRef>();
  const onReady = vi.fn();
  render(<JustDoChatWrapper ref={ref} onHistoryReadyChange={onReady} />);
  await waitFor(() => expect(connect).toHaveBeenCalled());
  controller = connect.mock.instances[0] as ChatController;
  expect(ref.current?.getExportSnapshot().isLoading).toBe(true);
  await expect(ref.current?.sendMessage('do not send')).rejects.toThrow();
  await expect(ref.current?.sendSideQuestion('do not send', 'side-run')).rejects.toThrow();
  act(() => {
    controller.state.initialHistoryReady = true;
    controller.state.historyReadFailed = true;
    publish();
  });
  expect(screen.getByText('storageHistoryFailed')).toBeTruthy();
  expect(ref.current?.getExportSnapshot().isLoading).toBe(true);
  await expect(ref.current?.sendSideQuestion('do not send', 'side-run')).rejects.toThrow();
  fireEvent.click(screen.getByText('storageHistoryRetry'));
  expect(reload).toHaveBeenCalledWith(true);
  expect(send).not.toHaveBeenCalled();
  act(() => {
    controller.state.historyReadFailed = false;
    publish();
  });
  expect(ref.current?.getExportSnapshot().isLoading).toBe(false);
  expect(onReady).toHaveBeenLastCalledWith('agent:main:justdo:old', true);
  await ref.current?.sendMessage('continue');
  expect(send).toHaveBeenCalledTimes(1);
});

it('delays real history loading notices and resets them when switching sessions', async () => {
  vi.useFakeTimers();
  const connect = vi.spyOn(ChatController.prototype, 'connect').mockImplementation(async function (
    this: ChatController,
  ) {
    this.state.connected = true;
  });
  vi.spyOn(ChatController.prototype, 'switchSession').mockResolvedValue();
  const view = render(<JustDoChatWrapper />);
  await act(async () => {});
  const controller = connect.mock.instances[0] as ChatController;
  const publish = () => (controller as unknown as { notify(): void }).notify();
  // Initial connection alone must not display a history notice.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(screen.queryByRole('status')).toBeNull();
  act(() => {
    controller.state.chatLoading = true;
    publish();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_999);
  });
  expect(screen.queryByRole('status')).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(screen.getByText('storageHistoryLoading')).toBeTruthy();
  expect(screen.getByRole('status').querySelector('svg[aria-hidden="true"]')).toBeTruthy();

  fixture.session = { id: 'other', agentId: 'main' };
  view.rerender(<JustDoChatWrapper />);
  expect(screen.queryByRole('status')).toBeNull();
  act(() => {
    controller.state.sessionKey = 'agent:main:justdo:other';
    publish();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3_000);
  });
  expect(screen.getByRole('status')).toBeTruthy();
  act(() => {
    controller.state.chatLoading = false;
    controller.state.initialHistoryReady = true;
    publish();
  });
  expect(screen.queryByRole('status')).toBeNull();
});

it.each(['quick', 'new-turn'])('never flashes a notice for %s history reads', async mode => {
  vi.useFakeTimers();
  const connect = vi.spyOn(ChatController.prototype, 'connect').mockImplementation(async function (
    this: ChatController,
  ) {
    this.state.connected = true;
  });
  render(<JustDoChatWrapper />);
  await act(async () => {});
  const controller = connect.mock.instances[0] as ChatController;
  const publish = () => (controller as unknown as { notify(): void }).notify();
  act(() => {
    controller.state.chatLoading = true;
    if (mode === 'new-turn') controller.setPendingUserMessage('new conversation');
    publish();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  if (mode === 'quick') {
    act(() => {
      controller.state.chatLoading = false;
      controller.state.initialHistoryReady = true;
      publish();
    });
  }
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(screen.queryByRole('status')).toBeNull();
});
