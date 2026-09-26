// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';

import JustDoChatWrapper, { type JustDoChatWrapperRef } from './JustDoChatWrapper';

vi.mock('./ChatMessageDisplay', () => ({ default: () => <div /> }));
vi.mock('react-redux', () => ({ useSelector: () => ({ id: 'old', agentId: 'main' }) }));
vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('blocks export and sending while history is loading or failed, and retry only reloads history', async () => {
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
