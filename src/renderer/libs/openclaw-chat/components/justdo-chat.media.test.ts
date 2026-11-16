/** @vitest-environment jsdom */

import './justdo-chat';

import { afterEach, expect, test, vi } from 'vitest';

import { ChatController } from '../gateway/chat-controller';
import { beginAssistantTurn, createChatTranscriptState } from '../model/chat-transcript-state';
import type { JustDoChatElement } from './justdo-chat';
import type { MessageMedia } from './message/message-media';
import { materializeDisclosureContents } from './timeline/disclosure-content';

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

test('renders the original SVG in the expanded process without opening tool parameters', async () => {
  const artifactId = 'artifact_transcript_image_fixture';
  const mimeType = 'image/svg+xml';
  const data = btoa('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10"/></svg>');
  const request = vi.fn().mockResolvedValue({
    artifact: { id: artifactId, type: 'image', mimeType, sessionKey, messageSeq: 3 },
    encoding: 'base64',
    data,
  });
  const controller = new ChatController();
  controllers.push(controller);
  Object.assign(controller.state, {
    sessionKey,
    currentSessionId: 'image-session-id',
    connected: true,
    client: { request, generation: 1, stop: vi.fn() },
    hello: { features: { methods: ['artifacts.download'] } },
  });
  (controller as unknown as {
    setCurrentSessionMessages(messages: unknown[], options: { resetLoadedHistory: boolean }): void;
  }).setCurrentSessionMessages([
    { role: 'user', content: 'Check sales', __openclaw: { id: 'request', seq: 1 } },
    { role: 'assistant', content: [
      { type: 'toolCall', id: 'trial', name: 'sales_chart', arguments: { quarter: 2 } },
    ], __openclaw: { id: 'call', seq: 2 } },
    { role: 'toolResult', toolCallId: 'trial', toolName: 'sales_chart', content: [
      { type: 'text', text: 'Chart ready' },
      { type: 'image', artifactId, mimeType, omitted: true },
    ], __openclaw: { id: 'result', seq: 3 } },
    { role: 'assistant', content: 'Sales increased.', __openclaw: { id: 'answer', seq: 4 } },
  ], { resetLoadedHistory: true });
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.controller = controller;
  document.body.append(chat);
  await chat.updateComplete;

  const root = chat.shadowRoot!;
  const process = root.querySelector<HTMLDetailsElement>('.completed-process')!;
  expect(process.open).toBe(false);
  materializeDisclosureContents(root);
  await Promise.resolve();
  expect(request).not.toHaveBeenCalled();
  expect(process.querySelector('img.chat-bubble__image')).toBeNull();

  process.querySelector('summary')!.click();
  await vi.waitFor(() => {
    expect(process.querySelector('img.chat-bubble__image')?.getAttribute('src'))
      .toBe(`data:${mimeType};base64,${data}`);
  });
  expect(request).toHaveBeenCalledExactlyOnceWith(
    'artifacts.download',
    { sessionKey, artifactId },
    { signal: expect.any(AbortSignal), timeoutMs: 30_000 },
  );
  const tool = process.querySelector<HTMLDetailsElement>('details.process-summary__tool')!;
  expect(tool.open).toBe(false);
  expect(tool.querySelector('summary')?.textContent).not.toContain('quarter');
  expect(tool.nextElementSibling?.querySelector('img.chat-bubble__image')).not.toBeNull();
  expect(root.querySelector('[data-entry-id="answer"]')?.closest('.completed-process')).toBeNull();
  tool.querySelector('summary')!.click();
  expect(tool.open).toBe(true);
  const output = tool.querySelector<HTMLElement & { text: string }>('justdo-tool-output');
  expect(output?.text).toContain('"quarter": 2');
});
