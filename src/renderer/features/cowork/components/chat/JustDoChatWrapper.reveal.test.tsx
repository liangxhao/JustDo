// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { JustDoChatElement } from '@/libs/openclaw-chat/components/justdo-chat';
import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';

import JustDoChatWrapper, { type JustDoChatWrapperRef } from './JustDoChatWrapper';

const fixture = vi.hoisted(() => ({
  session: { id: 'one', agentId: 'main' },
  chat: { revealMessage: vi.fn(), updateComplete: Promise.resolve() },
}));
vi.mock('react-redux', () => ({ useSelector: () => fixture.session }));
vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));
vi.mock('./ChatMessageDisplay', async () => {
  const { useEffect } = await import('react');
  return {
    default: function ChatDisplay({
      onChatElementChange,
    }: {
      onChatElementChange: (element: JustDoChatElement | null) => void;
    }) {
      useEffect(() => {
        onChatElementChange(fixture.chat as unknown as JustDoChatElement);
        return () => onChatElementChange(null);
      }, [onChatElementChange]);
      return <div />;
    },
  };
});

beforeEach(() => {
  fixture.session = { id: 'one', agentId: 'main' };
  fixture.chat.updateComplete = Promise.resolve();
  fixture.chat.revealMessage.mockReset().mockReturnValue(true);
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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const setup = async () => {
  const connect = vi.spyOn(ChatController.prototype, 'connect').mockImplementation(async function (
    this: ChatController,
  ) {
    this.state.connected = true;
    this.state.initialHistoryReady = true;
    this.state.currentSessionId = 'native-one';
  });
  vi.spyOn(ChatController.prototype, 'switchSession').mockResolvedValue();
  const older = vi.spyOn(ChatController.prototype, 'showOlderHistory').mockResolvedValue(false);
  const ref = createRef<JustDoChatWrapperRef>();
  const view = render(<JustDoChatWrapper ref={ref} />);
  await waitFor(() => expect(connect).toHaveBeenCalledOnce());
  return { ...view, ref, older, controller: connect.mock.instances[0] as ChatController };
};
const identity = { sessionKey: 'agent:main:justdo:one', sessionId: 'native-one' };

it('loads older native history before revealing the matched entry', async () => {
  const { ref, older } = await setup();
  fixture.chat.revealMessage.mockReturnValueOnce(false).mockReturnValue(true);
  older.mockResolvedValueOnce(true);
  await act(async () => {
    expect(await ref.current!.revealMessage('entry-old', identity)).toBe(true);
  });
  expect(older).toHaveBeenCalledOnce();
  expect(fixture.chat.revealMessage).toHaveBeenCalledTimes(2);
  expect(fixture.chat.revealMessage).toHaveBeenLastCalledWith('entry-old');
});

it('rejects a match from a replaced physical session or a different native key', async () => {
  const { ref, older } = await setup();
  expect(
    await ref.current!.revealMessage('entry', { ...identity, sessionId: 'retired-native-one' }),
  ).toBe(false);
  expect(
    await ref.current!.revealMessage('entry', {
      ...identity,
      sessionKey: 'agent:main:justdo:other',
    }),
  ).toBe(false);
  expect(fixture.chat.revealMessage).not.toHaveBeenCalled();
  expect(older).not.toHaveBeenCalled();
});

it('waits for initial history before scrolling to a native message', async () => {
  const { ref, controller } = await setup();
  vi.useFakeTimers();
  controller.state.initialHistoryReady = false;
  const pending = ref.current!.revealMessage('entry', identity);
  expect(fixture.chat.revealMessage).not.toHaveBeenCalled();
  controller.state.initialHistoryReady = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(await pending).toBe(true);
  expect(fixture.chat.revealMessage).toHaveBeenCalledWith('entry');
});

it('cancels a pending reveal when navigation changes during a Lit update', async () => {
  const { ref, rerender, older } = await setup();
  let finishRender!: () => void;
  fixture.chat.updateComplete = new Promise<void>(resolve => {
    finishRender = resolve;
  });
  const pending = ref.current!.revealMessage('entry', identity);
  fixture.session = { id: 'other', agentId: 'main' };
  rerender(<JustDoChatWrapper ref={ref} />);
  await act(async () => {
    finishRender();
    expect(await pending).toBe(false);
  });
  expect(fixture.chat.revealMessage).not.toHaveBeenCalled();
  expect(older).not.toHaveBeenCalled();
});
