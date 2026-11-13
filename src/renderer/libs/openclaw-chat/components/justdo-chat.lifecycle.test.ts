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

test('an external open receipt keeps its place in history without driving the live footer', async () => {
  const controller = new ChatController();
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  controller.state.chatMessages = [
    { role: 'user', content: 'First request', timestamp: 1_000 },
    { role: 'assistant', content: 'First reply', timestamp: 2_000 },
    { role: 'user', content: 'Second request', timestamp: 3_000 },
    { role: 'assistant', content: 'Second reply', timestamp: 4_000 },
  ];
  vi.spyOn(controller, 'getLoadedMessages').mockReturnValue(controller.state.chatMessages);
  chat.controller = controller;
  chat.runTimings = [
    { id: 'first', sessionId: 'session', clientTurnId: 'first', state: 'completed', startedAt: 1_000, endedAt: 2_000 },
    { id: 'second', sessionId: 'session', clientTurnId: 'second', state: 'running', startedAt: 3_000 },
  ];
  chat.useOpenRunTimingForActivity = false;
  document.body.append(chat);
  await chat.updateComplete;

  expect(chat.shadowRoot?.querySelector('.chat-group--assistant')).not.toBeNull();
  expect(chat.shadowRoot?.querySelector('.active-turn__footer')).toBeNull();

  chat.useOpenRunTimingForActivity = true;
  await chat.updateComplete;
  expect(chat.shadowRoot?.querySelector('.active-turn__footer')).not.toBeNull();
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
