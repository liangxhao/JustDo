// @vitest-environment jsdom
import './justdo-chat';

import { afterEach, expect, test, vi } from 'vitest';

import { ChatController } from '../gateway/chat-controller';
import type { JustDoChatElement } from './justdo-chat';
import { NATIVE_WIDGET_DRAFT_EVENT, type NativeWidgetContext } from './native-widget/host';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

test('a standalone chat receives confirmed widget drafts through its captured owner', async () => {
  const controller = new ChatController();
  Object.assign(controller.state, {
    connected: true,
    client: { generation: 1, request: vi.fn(), stop: vi.fn() },
    sessionKey: 'agent:main:history',
    currentSessionId: 'incarnation',
  });
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.controller = controller;
  chat.canDraftWidget = () => true;
  const received = vi.fn();
  chat.addEventListener(NATIVE_WIDGET_DRAFT_EVENT, received);
  document.body.append(chat);
  await chat.updateComplete;
  const context = (chat as unknown as { widgetContext: () => NativeWidgetContext }).widgetContext();
  expect(context.addDraft?.('Reviewed selection')).toBe(true);
  expect(received).toHaveBeenCalledOnce();
  expect(received.mock.calls[0][0].detail).toEqual({
    sessionKey: 'agent:main:history',
    text: 'Reviewed selection',
  });
  expect(context.addDraft?.('/run something')).toBe(false);
  chat.canDraftWidget = () => false;
  expect(context.addDraft?.('Read only')).toBe(false);
  chat.canDraftWidget = () => true;
  controller.state.currentSessionId = 'replacement';
  expect(context.addDraft?.('Stale incarnation')).toBe(false);
  chat.remove();
  expect(context.addDraft?.('Detached chat')).toBe(false);
  expect(received).toHaveBeenCalledOnce();
});
