// @vitest-environment jsdom
import type { SessionRunTiming } from '@shared/cowork/sessionRun';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import type { JustDoChatElement } from '@/libs/openclaw-chat/components/justdo-chat';
import { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';

import ChatMessageDisplay from './ChatMessageDisplay';

afterEach(cleanup);

it('keeps the first user bubble and live controller binding when the element callback changes', async () => {
  const controller = new ChatController();
  controller.setPendingUserMessage('First prompt');
  const firstCallback = vi.fn();
  const updatedCallback = vi.fn();
  const runTimings: SessionRunTiming[] = [];
  const view = render(
    <ChatMessageDisplay controller={controller} onChatElementChange={firstCallback} runTimings={runTimings} />,
  );
  const chat = view.container.querySelector<JustDoChatElement>('justdo-chat')!;
  await act(async () => { await chat.updateComplete; });

  view.rerender(
    <ChatMessageDisplay controller={controller} onChatElementChange={updatedCallback} runTimings={runTimings} />,
  );

  expect(firstCallback).toHaveBeenLastCalledWith(null);
  expect(updatedCallback).toHaveBeenCalledWith(chat);
  expect(view.container.querySelector('justdo-chat')).toBe(chat);
  expect(chat.shadowRoot!.querySelector('.chat-group--user')?.textContent).toContain('First prompt');
  await act(async () => {
    controller.setPendingUserMessage('Updated prompt');
    await chat.updateComplete;
  });
  expect(chat.shadowRoot!.querySelector('.chat-group--user')?.textContent).toContain('Updated prompt');
});
