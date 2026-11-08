import type { RealtimeVoiceEvent, RealtimeVoiceSession } from '@shared/speech/realtimeVoice';
import { describe, expect, it } from 'vitest';

import { RealtimeVoiceProjection, type VoiceProjectionContext } from './realtime-voice-projection';

const session: RealtimeVoiceSession = { requestId: 'request-1', voiceSessionId: 'call-1',
  source: { productSessionId: 'product-1', sessionKey: 'agent:main:chat-1', sessionId: 'native-1' },
  model: 'live', voice: 'calm', inputEncoding: 'pcm16', inputSampleRateHz: 24000,
  outputEncoding: 'pcm16', outputSampleRateHz: 24000 };
function fixture() {
  const projection = new RealtimeVoiceProjection();
  const context: VoiceProjectionContext = { connected: true, sessionKey: session.source.sessionKey,
    sessionId: session.source.sessionId, client: {}, clientGeneration: 1, historyGeneration: 0, messages: [] };
  projection.accept({ type: 'opened', session }, context);
  const event = (patch: Partial<RealtimeVoiceEvent>) => projection.accept({ type: 'event', event: {
    ...session, type: 'transcript', role: 'assistant', turnId: 'turn-1', text: 'Hello', ...patch,
  } }, context);
  return { projection, context, event, entries: () => projection.entries(context) };
}

describe('native voice stream display projection', () => {
  it('hands off by exact native ID in either connection order without text matching', () => {
    const f = fixture();
    f.event({ text: 'Hello' }); f.event({ text: ' there' });
    expect(f.entries()).toMatchObject([{ text: 'Hello there', final: false }]);
    f.context.messages = [{ role: 'assistant', content: 'Hello there', __openclaw: { id: 'unrelated' } }];
    f.event({ text: 'Hello there', final: true, transcriptId: 'voice:call-1:1' });
    f.event({ text: 'Hello there', final: true, transcriptId: 'voice:call-1:1' });
    expect(f.entries()).toHaveLength(1);
    f.context.messages = [{ __openclaw: { id: 'voice:call-1:1' } }];
    expect(f.entries()).toHaveLength(0);

    f.event({ text: 'Next', turnId: 'turn-2' });
    f.context.messages = [{ __openclaw: { id: 'voice:call-1:2' } }];
    f.event({ text: 'Next final', turnId: 'turn-2', final: true, transcriptId: 'voice:call-1:2' });
    expect(f.entries()).toHaveLength(0);
  });

  it('ends partial display immediately, retains only native finals, and rejects late call/turn events', () => {
    const f = fixture();
    f.event({ role: 'user', text: 'Question', final: true, transcriptId: 'voice:call-1:1' });
    f.event({ text: 'First', turnId: 'turn-2' });
    f.event({ text: 'Stale', turnId: 'turn-1' });
    expect(f.entries().map(entry => entry.text)).toEqual(['Question', 'First']);
    f.projection.accept({ type: 'ended', session }, f.context);
    f.event({ text: 'Too late', turnId: 'turn-2' });
    expect(f.entries().map(entry => entry.text)).toEqual(['Question']);
    f.projection.accept({ type: 'opened', session: { ...session, requestId: 'request-2', voiceSessionId: 'call-2' } }, f.context);
    f.event({ text: 'Old call' });
    expect(f.entries()).toHaveLength(0);
  });

  it.each(['client', 'clientGeneration', 'historyGeneration', 'sessionId', 'sessionKey', 'connected'] as const)(
    'retires the stream when its %s changes and does not revive it after A → B → A', key => {
      const f = fixture(); f.event({ text: 'Current' });
      const original = f.context[key];
      Object.assign(f.context, { [key]: key === 'client' ? {} : key === 'connected' ? false :
        typeof original === 'number' ? original + 1 : 'different' });
      expect(f.entries()).toHaveLength(0);
      Object.assign(f.context, { [key]: original });
      f.event({ text: 'Late' });
      expect(f.entries()).toHaveLength(0);
    },
  );

  it('bounds pending captions and does not let output clear erase user input', () => {
    const f = fixture();
    f.event({ role: 'user', text: 'Still speaking' });
    f.event({ text: 'Output' }); f.event({ type: 'clear' });
    expect(f.entries()).toMatchObject([{ role: 'user', text: 'Still speaking' }]);
    f.event({ type: 'responseStarted' });
    for (let index = 1; index <= 45; index += 1) f.event({ text: 'x'.repeat(9_000),
      final: true, transcriptId: `voice:call-1:${index}` });
    expect(f.entries()).toHaveLength(40);
    expect(f.entries().every(entry => entry.text.length <= 8_000)).toBe(true);
    f.event({ text: 'Wrong owner', final: true, transcriptId: 'voice:other-call:1' });
    expect(f.entries().some(entry => entry.text === 'Wrong owner')).toBe(false);
  });

  it('drops cleared output until a native response starts, including a valid response within the same turn', () => {
    const f = fixture();
    f.event({ text: 'Interrupted' });
    f.event({ type: 'clear' });
    f.event({ text: 'Late interrupted output' });
    f.event({ role: 'user', text: 'New user input' });
    expect(f.entries()).toMatchObject([{ role: 'user', text: 'New user input' }]);
    // Talk can clear an initial provider response before its forced consultation replies.
    f.event({ type: 'responseStarted' });
    f.event({ text: 'Legitimate new output' });
    expect(f.entries()).toMatchObject([{ role: 'user' }, { role: 'assistant', text: 'Legitimate new output' }]);
    f.event({ role: 'user', turnId: 'turn-2', text: 'Next utterance' });
    f.event({ type: 'responseStarted', turnId: 'turn-1' });
    f.event({ turnId: 'turn-1', text: 'Retired turn' });
    expect(f.entries()).toMatchObject([{ text: 'Next utterance' }]);
  });

  it('retains both clear identities when queued playback and the active response are cleared separately', () => {
    const f = fixture();
    f.event({ text: 'Playback A', turnId: 'turn-a' });
    f.event({ type: 'clear', turnId: 'turn-a' });
    f.event({ type: 'clear', turnId: 'turn-b' });
    f.event({ text: 'Late A', turnId: 'turn-a' });
    f.event({ text: 'Late B', turnId: 'turn-b' });
    expect(f.entries()).toHaveLength(0);
    f.event({ type: 'responseStarted', turnId: 'turn-a' });
    f.event({ text: 'New A', turnId: 'turn-a' });
    f.event({ text: 'Still late B', turnId: 'turn-b' });
    expect(f.entries()).toMatchObject([{ text: 'New A' }]);
  });
});
