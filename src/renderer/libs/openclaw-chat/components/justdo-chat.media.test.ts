/** @vitest-environment jsdom */

import './justdo-chat';

import { afterEach, expect, test, vi } from 'vitest';

import { ChatController } from '../gateway/chat-controller';
import { beginAssistantTurn, createChatTranscriptState } from '../model/chat-transcript-state';
import type { JustDoChatElement } from './justdo-chat';
import type { MessageMedia } from './message/message-media';

const sessionKey = 'agent:main:media-session';
const source = `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/11111111-1111-4111-8111-111111111111/full`;
const controllers: ChatController[] = [];

afterEach(async () => {
  document.body.replaceChildren();
  await Promise.resolve();
  for (const controller of controllers.splice(0)) controller.disconnect();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function playbackBridge() {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  const prepareAssistantMediaPlayback = vi.fn().mockResolvedValue({
    success: true,
    url: 'localmedia://gateway/media-lease',
  });
  const releaseAssistantMediaPlayback = vi.fn().mockResolvedValue({ success: true });
  vi.stubGlobal('electron', {
    openclaw: { engine: { prepareAssistantMediaPlayback, releaseAssistantMediaPlayback } },
  });
  return { prepareAssistantMediaPlayback, releaseAssistantMediaPlayback };
}

test('binds persisted playback to the current native session and revokes it after a session change', async () => {
  const bridge = playbackBridge();
  const controller = new ChatController();
  controllers.push(controller);
  controller.state.sessionKey = sessionKey;
  controller.state.connected = true;
  (controller as unknown as {
    setCurrentSessionMessages(messages: unknown[], options: { resetLoadedHistory: boolean }): void;
  }).setCurrentSessionMessages([
    {
      role: 'assistant',
      content: [{ type: 'audio', url: source, mimeType: 'audio/wav', fileName: 'voice.wav' }],
      __openclaw: { id: 'media-message', seq: 1 },
    },
  ], { resetLoadedHistory: true });
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.controller = controller;
  document.body.append(chat);
  await chat.updateComplete;
  await vi.waitFor(() => expect(bridge.prepareAssistantMediaPlayback).toHaveBeenCalledWith({
    source, sessionKey, kind: 'audio',
  }));
  const reader = chat.shadowRoot!.querySelector<MessageMedia>('justdo-message-media')!;
  expect(reader.sessionKey).toBe(sessionKey);

  controller.state.sessionKey = 'agent:main:other-session';
  (controller as unknown as { notify(): void }).notify();
  await chat.updateComplete;

  await vi.waitFor(() => expect(bridge.releaseAssistantMediaPlayback).toHaveBeenCalledWith({
    url: 'localmedia://gateway/media-lease',
  }));
  expect(chat.shadowRoot!.querySelector<MessageMedia>('justdo-message-media')?.sessionKey)
    .toBe('agent:main:other-session');
  expect(bridge.prepareAssistantMediaPlayback).toHaveBeenCalledTimes(1);
});

test('passes the active native session to media in live tool details', async () => {
  const bridge = playbackBridge();
  const transcript = createChatTranscriptState(sessionKey, 'native-session');
  const turn = beginAssistantTurn(transcript, { runId: 'media-run' }, {
    now: () => 1, createId: prefix => prefix,
  });
  turn.items.push({
    id: 'audio-tool', runId: turn.runId, firstSeq: 1, lastSeq: 1, startedAt: 1, updatedAt: 1,
    type: 'tool', status: 'running', toolCallId: 'audio-call', name: 'tts',
    presentation: { media: [{ path: source, mimeType: 'audio/wav', fileName: 'voice.wav' }] },
  });
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.activeTurn = turn;
  document.body.append(chat);
  await chat.updateComplete;

  await vi.waitFor(() => expect(bridge.prepareAssistantMediaPlayback).toHaveBeenCalledWith({
    source, sessionKey, kind: 'audio',
  }));
  expect(chat.shadowRoot!.querySelector<MessageMedia>('justdo-message-media')?.sessionKey)
    .toBe(sessionKey);
});
