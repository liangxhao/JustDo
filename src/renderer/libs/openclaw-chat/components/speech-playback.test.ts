/** @vitest-environment jsdom */

import './justdo-chat';

import { EnginePhase, type OpenClawEngineStatus } from '@shared/openclaw/engineStatus';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { configService } from '@/services/config';

import { ChatController } from '../gateway/chat-controller';
import type { JustDoChatElement } from './justdo-chat';

const controllers: ChatController[] = [];
const audioPlayers: Array<{ pause: ReturnType<typeof vi.fn>; play: ReturnType<typeof vi.fn> }> = [];
let config: ReturnType<typeof configService.getConfig>;
let engineChanged: (status: OpenClawEngineStatus) => void;
let unsubscribeEngine: ReturnType<typeof vi.fn>;
let getStatus: ReturnType<typeof vi.fn>;

beforeEach(() => {
  const initial = configService.getConfig();
  config = {
    ...initial,
    voice: {
      ...initial.voice,
      outputEnabled: true,
      synthesisMode: 'online',
      onlineTtsModelRef: 'office/reader',
      onlineTtsVoice: 'voice-a',
    },
    onlineModelProviders: {
      'speech-synthesis': {
        providers: {
          office: {
            displayName: 'Office',
            baseUrl: 'https://speech.internal/v1',
            apiKey: 'input-key',
            models: [
              { id: 'reader', name: 'Reader', voices: [{ id: 'voice-a', name: 'Voice A' }] },
            ],
          },
        },
      },
    },
  };
  vi.spyOn(configService, 'getConfig').mockImplementation(() => config);
  getStatus = vi.fn().mockResolvedValue({ available: true });
  unsubscribeEngine = vi.fn();
  vi.stubGlobal('electron', {
    onlineTts: { getStatus },
    localTts: { getStatus },
    localSpeechModels: { onChanged: vi.fn().mockReturnValue(() => {}) },
    openclaw: {
      engine: {
        onProgress: vi.fn(callback => {
          engineChanged = callback;
          return unsubscribeEngine;
        }),
      },
    },
  });
  vi.stubGlobal(
    'Audio',
    class {
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      pause = vi.fn();
      play = vi.fn().mockResolvedValue(undefined);
      constructor() {
        audioPlayers.push(this);
      }
    },
  );
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn().mockReturnValue('blob:speech'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});

afterEach(() => {
  document.body.replaceChildren();
  for (const controller of controllers.splice(0)) controller.disconnect();
  audioPlayers.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const speechButton = (chat: JustDoChatElement) =>
  chat.shadowRoot!.querySelector<HTMLButtonElement>('.message-speech');
const audioResult = () => ({
  audioBase64: btoa('audio'),
  provider: 'openai',
  mimeType: 'audio/wav',
});
async function createChat(controller?: ChatController) {
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  if (controller) chat.controller = controller;
  else
    chat.messages = [
      { role: 'assistant', content: 'Read this reply', __openclaw: { id: 'reply' } },
    ];
  document.body.append(chat);
  await chat.updateComplete;
  return chat;
}
function speechController(speak: () => Promise<ReturnType<typeof audioResult>>) {
  const controller = new ChatController();
  controllers.push(controller);
  controller.state.sessionKey = 'agent:main:speech-test';
  controller.state.connected = true;
  (
    controller as unknown as {
      setCurrentSessionMessages(
        messages: unknown[],
        options: { resetLoadedHistory: boolean },
      ): void;
    }
  ).setCurrentSessionMessages(
    [{ role: 'assistant', content: 'Read this reply', __openclaw: { id: 'reply' } }],
    { resetLoadedHistory: true },
  );
  vi.spyOn(controller, 'speak').mockImplementation(speak);
  return controller;
}

test('shows read-aloud controls when the engine becomes ready and ignores old readiness', async () => {
  let finishInitial!: (value: { available: boolean }) => void;
  getStatus.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finishInitial = resolve;
      }),
  );
  const chat = await createChat();
  expect(speechButton(chat)).toBeNull();

  engineChanged({ phase: EnginePhase.Running, canRetry: false, version: null });
  await vi.waitFor(() => expect(speechButton(chat)).not.toBeNull());
  finishInitial({ available: false });
  await Promise.resolve();
  await chat.updateComplete;
  expect(speechButton(chat)).not.toBeNull();

  engineChanged({ phase: EnginePhase.Starting, canRetry: false, version: null });
  await chat.updateComplete;
  expect(speechButton(chat)).toBeNull();
  chat.remove();
  expect(unsubscribeEngine).toHaveBeenCalledOnce();
});

test('does not admit a disconnected element readiness response after reconnecting', async () => {
  const pending: Array<(value: { available: boolean }) => void> = [];
  getStatus.mockImplementation(
    () =>
      new Promise(resolve => {
        pending.push(resolve);
      }),
  );
  const chat = await createChat();
  chat.remove();
  document.body.append(chat);
  await chat.updateComplete;

  pending[0]({ available: true });
  await Promise.resolve();
  await chat.updateComplete;
  expect(speechButton(chat)).toBeNull();
  pending[1]({ available: true });
  await vi.waitFor(() => expect(speechButton(chat)).not.toBeNull());
});

test('stops the old local voice immediately while retaining playback for unrelated settings', async () => {
  config = { ...config, voice: { ...config.voice, synthesisMode: 'local' } };
  const controller = speechController(async () => audioResult());
  const chat = await createChat(controller);
  await vi.waitFor(() => expect(speechButton(chat)).not.toBeNull());
  speechButton(chat)!.click();
  await vi.waitFor(() => expect(audioPlayers[0]?.play).toHaveBeenCalledOnce());

  config = { ...config, theme: 'dark' };
  window.dispatchEvent(new Event('config-updated'));
  expect(audioPlayers[0].pause).not.toHaveBeenCalled();
  config = { ...config, voice: { ...config.voice, voiceId: config.voice.voiceId + 1 } };
  window.dispatchEvent(new Event('config-updated'));
  expect(audioPlayers[0].pause).toHaveBeenCalledOnce();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:speech');
});

test('discards pending audio after a credential change on the same selected online model', async () => {
  let finishSpeech!: (value: ReturnType<typeof audioResult>) => void;
  const controller = speechController(
    () =>
      new Promise(resolve => {
        finishSpeech = resolve;
      }),
  );
  const chat = await createChat(controller);
  await vi.waitFor(() => expect(speechButton(chat)).not.toBeNull());
  speechButton(chat)!.click();
  await vi.waitFor(() => expect(controller.speak).toHaveBeenCalledOnce());

  const category = config.onlineModelProviders!['speech-synthesis']!;
  config = {
    ...config,
    onlineModelProviders: {
      ...config.onlineModelProviders,
      'speech-synthesis': {
        ...category,
        providers: {
          ...category.providers,
          office: { ...category.providers.office, apiKey: 'rotated-key' },
        },
      },
    },
  };
  window.dispatchEvent(new Event('config-updated'));
  finishSpeech(audioResult());
  await Promise.resolve();
  await chat.updateComplete;
  expect(audioPlayers).toHaveLength(0);
});

test('stops online playback when the engine stops and ignores local playback for engine changes', async () => {
  const controller = speechController(async () => audioResult());
  const chat = await createChat(controller);
  await vi.waitFor(() => expect(speechButton(chat)).not.toBeNull());
  speechButton(chat)!.click();
  await vi.waitFor(() => expect(audioPlayers[0]?.play).toHaveBeenCalledOnce());
  engineChanged({ phase: EnginePhase.Error, canRetry: true, version: null });
  expect(audioPlayers[0].pause).toHaveBeenCalledOnce();
  await chat.updateComplete;
  expect(speechButton(chat)).toBeNull();

  config = { ...config, voice: { ...config.voice, synthesisMode: 'local' } };
  window.dispatchEvent(new Event('config-updated'));
  await vi.waitFor(() => expect(speechButton(chat)).not.toBeNull());
  speechButton(chat)!.click();
  await vi.waitFor(() => expect(audioPlayers[1]?.play).toHaveBeenCalledOnce());
  engineChanged({ phase: EnginePhase.Starting, canRetry: false, version: null });
  expect(audioPlayers[1].pause).not.toHaveBeenCalled();
});
