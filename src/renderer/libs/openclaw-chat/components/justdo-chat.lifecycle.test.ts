/** @vitest-environment jsdom */

import './justdo-chat';

import { afterEach, expect, test, vi } from 'vitest';

import { ChatController } from '../gateway/chat-controller';
import { beginAssistantTurn, createChatTranscriptState } from '../model/chat-transcript-state';
import type { JustDoChatElement } from './justdo-chat';

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

test('does not resurrect rendering resources from a pending update after removal', async () => {
  const frame = vi.fn(() => 1);
  const interval = vi.fn(() => 123);
  vi.stubGlobal('requestAnimationFrame', frame);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('setInterval', interval);
  vi.stubGlobal('clearInterval', vi.fn());
  const transcript = createChatTranscriptState('agent:main:lifecycle', 'physical-session');
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.activeTurn = beginAssistantTurn(
    transcript,
    { runId: 'active-run' },
    { now: () => 1, createId: prefix => prefix },
  );
  document.body.append(chat);
  await chat.updateComplete;
  const resources = chat as unknown as {
    richMessageControls: object | null;
    activeTurnClockTimer: unknown;
  };
  expect(resources.richMessageControls).not.toBeNull();
  expect(resources.activeTurnClockTimer).toBe(123);
  frame.mockClear();
  interval.mockClear();
  chat.requestUpdate();
  chat.remove();
  await chat.updateComplete;
  await chat.historyRenderComplete;
  expect(resources.richMessageControls).toBeNull();
  expect(resources.activeTurnClockTimer).toBeNull();
  expect(frame).not.toHaveBeenCalled();
  expect(interval).not.toHaveBeenCalled();
  document.body.append(chat);
  await chat.updateComplete;
  expect(resources.richMessageControls).not.toBeNull();
  expect(interval).toHaveBeenCalledOnce();
});

test('resubscribes to the existing controller when the same element reconnects', async () => {
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const controller = new ChatController();
  const subscribe = vi.spyOn(controller, 'subscribe');
  const onStream = vi.spyOn(controller, 'onStream');
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.controller = controller;
  document.body.append(chat);
  await chat.updateComplete;
  expect(subscribe).toHaveBeenCalledOnce();
  expect(onStream).toHaveBeenCalledOnce();
  chat.remove();
  chat.requestUpdate();
  await chat.updateComplete;
  document.body.append(chat);
  await chat.updateComplete;
  expect(subscribe).toHaveBeenCalledTimes(2);
  expect(onStream).toHaveBeenCalledTimes(2);
  chat.remove();
  controller.disconnect();
});
