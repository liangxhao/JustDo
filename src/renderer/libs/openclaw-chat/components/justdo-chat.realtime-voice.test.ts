/** @vitest-environment jsdom */
import './justdo-chat';

import type { RealtimeVoiceEvent, RealtimeVoiceSession } from '@shared/speech/realtimeVoice';
import { afterEach, expect, test, vi } from 'vitest';

import { ChatController } from '../gateway/chat-controller';
import type { JustDoChatElement } from './justdo-chat';

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

test('streams admitted voice as ordinary chat rows and yields to native history without sending another message', async () => {
  const nativeMessages: unknown[] = [];
  const request = vi.fn(async (method: string) => method === 'chat.history'
    ? { messages: nativeMessages, sessionId: 'native-1' } : {});
  const controller = new ChatController();
  const session: RealtimeVoiceSession = { requestId: 'request-1', voiceSessionId: 'voice-1',
    source: { productSessionId: 'product-1', sessionKey: 'agent:main:voice-chat', sessionId: 'native-1' },
    model: 'live', voice: 'calm', inputEncoding: 'pcm16', inputSampleRateHz: 24000,
    outputEncoding: 'pcm16', outputSampleRateHz: 24000 };
  Object.assign(controller.state, { sessionKey: session.source.sessionKey, currentSessionId: session.source.sessionId,
    connected: true, client: { request, generation: 1, stop: vi.fn() }, initialHistoryReady: true });
  controller.state.transcript.sessionKey = session.source.sessionKey;
  controller.state.transcript.sessionId = session.source.sessionId;
  const chat = document.createElement('justdo-chat') as JustDoChatElement;
  chat.controller = controller;
  document.body.append(chat);
  const event = (patch: Partial<RealtimeVoiceEvent>) => controller.acceptRealtimeVoiceUpdate({ type: 'event',
    event: { ...session, type: 'transcript', role: 'assistant', turnId: 'turn-1', text: '', ...patch } });
  const persisted = (role: string, text: string, number: number) => {
    const message = { role, content: [{ type: 'text', text }], provenance: { kind: 'realtime_voice', sourceChannel: 'talk' },
      __openclaw: { id: `voice:voice-1:${number}`, seq: number } };
    nativeMessages.push(message);
    (controller as unknown as { handleEvent(event: { event: string; payload: unknown }): void })
      .handleEvent({ event: 'session.message', payload: { sessionKey: session.source.sessionKey,
        sessionId: session.source.sessionId, hasActiveRun: false, messageId: `voice:voice-1:${number}`,
        messageSeq: number, message } });
  };
  try {
    controller.acceptRealtimeVoiceUpdate({ type: 'opened', session });
    event({ role: 'user', text: 'My spoken question', final: true, transcriptId: 'voice:voice-1:1' });
    await chat.updateComplete;
    expect(chat.shadowRoot?.querySelector('.chat-group--user')?.textContent).toContain('My spoken question');
    expect(chat.shadowRoot?.querySelector('.chat-group__footer')).toBeNull();
    persisted('user', 'My spoken question', 1);
    event({ text: 'Streaming' });
    await chat.updateComplete;
    expect(chat.shadowRoot?.querySelector('.chat-group--assistant')?.textContent).toContain('Streaming');
    event({ text: ' spoken answer' });
    await chat.updateComplete;
    expect(chat.shadowRoot?.textContent).toContain('Streaming spoken answer');
    // The direct Gateway notification may arrive before the final Main caption.
    persisted('assistant', 'Streaming spoken answer', 2);
    event({ text: 'Streaming spoken answer', final: true, transcriptId: 'voice:voice-1:2' });
    await controller.loadHistory(true);
    await chat.updateComplete;
    expect(chat.shadowRoot?.querySelectorAll('.chat-group--user')).toHaveLength(1);
    expect(chat.shadowRoot?.querySelectorAll('.chat-group--assistant')).toHaveLength(1);
    expect(controller.getLoadedMessages()).toHaveLength(2);
    expect(controller.state.transcript.activeTurn).toBeNull();
    expect(controller.state.chatSending).toBe(false);
    expect(request.mock.calls.some(([method]) => method === 'chat.send')).toBe(false);
    controller.acceptRealtimeVoiceUpdate({ type: 'ended', session });
    event({ text: 'Late words' });
    await chat.updateComplete;
    expect(chat.shadowRoot?.textContent).not.toContain('Late words');
  } finally { controller.disconnect(); }
});
