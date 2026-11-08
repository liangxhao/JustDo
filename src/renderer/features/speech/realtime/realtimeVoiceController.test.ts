import type { RealtimeVoiceBridge, RealtimeVoiceEvent, RealtimeVoiceSession } from '@shared/speech/realtimeVoice';
import { describe, expect, it, vi } from 'vitest';

import type { RealtimeVoiceAudio } from './realtimeVoiceAudio';
import { RealtimeVoiceController, type RealtimeVoiceViewState } from './realtimeVoiceController';
import { subscribeRealtimeVoiceTimeline } from './realtimeVoiceEvents';

const deferred = <T>() => { let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };
function fixture() {
  let listener!: (event: RealtimeVoiceEvent) => void;
  const audio: RealtimeVoiceAudio = { start: vi.fn(async () => undefined),
    setMicrophoneMuted: vi.fn(), setSpeakerMuted: vi.fn(), play: vi.fn(),
    afterPlayback: vi.fn(callback => callback()), clear: vi.fn(), close: vi.fn() };
  const session: RealtimeVoiceSession = { requestId: '', voiceSessionId: 'native-1', model: 'live', voice: 'calm',
    source: { productSessionId: 'conversation-1', sessionKey: 'agent:main:chat', sessionId: 'physical-session' },
    inputEncoding: 'pcm16', inputSampleRateHz: 24000, outputEncoding: 'pcm16', outputSampleRateHz: 24000 };
  const bridge: RealtimeVoiceBridge = { getStatus: vi.fn(async () => ({ available: true })),
    start: vi.fn(async request => ({ ...session, requestId: request.requestId,
      source: { ...session.source, productSessionId: request.productSessionId } })),
    appendAudio: vi.fn(async () => undefined), interrupt: vi.fn(async () => undefined),
    acknowledgeMark: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
    onEvent: callback => { listener = callback; return vi.fn(); } };
  let state: RealtimeVoiceViewState | undefined;
  const open = vi.fn(async () => audio);
  const controller = new RealtimeVoiceController(bridge, next => { state = next; }, open);
  const event = (value: Omit<RealtimeVoiceEvent, 'requestId' | 'voiceSessionId' | 'source'> & { source?: RealtimeVoiceSession['source'] }) => listener({ ...value,
    source: { ...session.source, productSessionId: vi.mocked(bridge.start).mock.calls.at(-1)![0].productSessionId },
    requestId: vi.mocked(bridge.start).mock.calls.at(-1)![0].requestId, voiceSessionId: 'native-1' });
  return { controller, bridge, audio, open, event, source: session.source, listener: () => listener, state: () => state };
}
describe('realtime voice media ownership', () => {
  it('publishes only admitted captions and retires timeline ownership synchronously before native close settles', async () => {
    const f = fixture();
    const timeline = vi.fn();
    const unsubscribe = subscribeRealtimeVoiceTimeline(timeline);
    try {
      await f.controller.start('conversation-1');
      expect(timeline).toHaveBeenCalledExactlyOnceWith({ type: 'opened', session: expect.objectContaining({ source: f.source }) });
      f.event({ type: 'responseStarted', turnId: 'turn-1' });
      expect(timeline).toHaveBeenLastCalledWith({ type: 'event', event: expect.objectContaining({ source: f.source, type: 'responseStarted', turnId: 'turn-1' }) });
      f.event({ type: 'audio', audioBase64: 'AAA=' });
      expect(timeline).toHaveBeenCalledTimes(2);
      f.event({ type: 'transcript', role: 'user', text: 'native words', final: false });
      expect(timeline).toHaveBeenLastCalledWith({ type: 'event', event: expect.objectContaining({ source: f.source, text: 'native words' }) });
      const closing = deferred<void>();
      vi.mocked(f.bridge.close).mockReturnValue(closing.promise);
      const ending = f.controller.end();
      expect(timeline).toHaveBeenLastCalledWith({ type: 'ended', session: expect.objectContaining({ source: f.source }) });
      f.event({ type: 'transcript', role: 'assistant', text: 'queued stale words', final: true });
      f.event({ type: 'ready' });
      const duplicate = f.controller.end();
      expect(timeline).toHaveBeenCalledTimes(4);
      closing.resolve(); await ending; await duplicate;
    } finally { f.controller.dispose(); unsubscribe(); }
  });
  it('keeps replying until native completion and real playback drain without treating captions as completion', async () => {
    const f = fixture();
    const played: Array<() => void> = [];
    vi.mocked(f.audio.afterPlayback).mockImplementation(callback => { played.push(callback); });
    await f.controller.start('conversation-1');
    f.event({ type: 'ready' }); await flush();
    expect(f.state()?.activity).toBe('listening');
    f.event({ type: 'responseStarted', turnId: 'turn-1' });
    expect(f.state()?.activity).toBe('responding');
    f.controller.setSpeakerMuted(true);
    f.event({ type: 'audio', turnId: 'turn-1', audioBase64: 'AAA=' });
    f.event({ type: 'transcript', role: 'assistant', text: 'reply text', final: true });
    expect(f.state()).toMatchObject({ activity: 'responding', speakerMuted: true, assistantCaption: 'reply text' });
    expect(f.bridge.interrupt).not.toHaveBeenCalled();
    expect(f.bridge.close).not.toHaveBeenCalled();
    f.event({ type: 'audioDone', turnId: 'turn-1' });
    expect(f.state()?.activity).toBe('responding');
    played.shift()!();
    expect(f.state()?.activity).toBe('listening');
    f.controller.dispose();
  });
  it('does not let an old playback or turn completion clear a new response', async () => {
    const f = fixture();
    const played: Array<() => void> = [];
    vi.mocked(f.audio.afterPlayback).mockImplementation(callback => { played.push(callback); });
    await f.controller.start('conversation-1');
    f.event({ type: 'responseStarted', turnId: 'old-turn' });
    f.event({ type: 'audioDone', turnId: 'old-turn' });
    f.event({ type: 'clear', turnId: 'old-turn' });
    expect(f.state()?.activity).toBe('listening');
    f.event({ type: 'responseStarted', turnId: 'new-turn' });
    played.shift()!();
    expect(f.state()?.activity).toBe('responding');
    f.event({ type: 'audioDone', turnId: 'old-turn' });
    expect(played).toHaveLength(0);
    f.event({ type: 'clear', turnId: 'old-turn' });
    expect(f.state()).toMatchObject({ activity: 'responding', turnId: 'new-turn' });
    f.event({ type: 'audioDone', turnId: 'new-turn' });
    await f.controller.end();
    await f.controller.start('conversation-2');
    f.event({ type: 'responseStarted', turnId: 'next-call-turn' });
    played.shift()!();
    expect(f.state()?.activity).toBe('responding');
    f.controller.dispose();
  });
  it('starts only after native readiness and keeps local mute separate from native interruption', async () => {
    const f = fixture();
    await f.controller.start('conversation-1');
    expect(f.audio.start).not.toHaveBeenCalled();
    f.event({ type: 'ready' }); await flush();
    expect(f.state()?.phase).toBe('active');
    f.controller.setMicrophoneMuted(true); f.controller.setSpeakerMuted(true);
    expect(f.bridge.interrupt).not.toHaveBeenCalled();
    f.event({ type: 'responseStarted', turnId: 'turn-1' });
    await f.controller.interrupt();
    expect(f.bridge.interrupt).toHaveBeenCalledWith(expect.objectContaining({ turnId: 'turn-1' }));
    await f.controller.end();
    expect(f.audio.close).toHaveBeenCalled();
    f.controller.dispose();
  });
  it('releases a microphone granted after the panel has closed without creating a native session', async () => {
    const f = fixture(); const capture = deferred<RealtimeVoiceAudio>();
    f.open.mockReturnValue(capture.promise);
    const starting = f.controller.start('conversation-1');
    await f.controller.end();
    capture.resolve(f.audio); await starting;
    expect(f.audio.close).toHaveBeenCalled();
    expect(f.bridge.start).not.toHaveBeenCalled();
    f.controller.dispose();
  });
  it('closes a late native creation and discards its audio after cancellation', async () => {
    const f = fixture(); const creation = deferred<RealtimeVoiceSession>();
    vi.mocked(f.bridge.start).mockReturnValue(creation.promise);
    const starting = f.controller.start('conversation-1'); await flush();
    await f.controller.end();
    creation.resolve({ requestId: 'ignored', voiceSessionId: 'late-voice', model: 'live', voice: 'calm',
      source: f.source,
      inputEncoding: 'pcm16', inputSampleRateHz: 24000, outputEncoding: 'pcm16', outputSampleRateHz: 24000 });
    await starting;
    expect(f.bridge.close).toHaveBeenCalledWith(expect.objectContaining({ voiceSessionId: 'late-voice' }));
    f.event({ type: 'audio', audioBase64: 'AAA=' });
    expect(f.audio.play).not.toHaveBeenCalled();
    f.controller.dispose();
  });
  it('replaces final captions and rejects audio from another native session', async () => {
    const f = fixture(); await f.controller.start('conversation-1');
    f.event({ type: 'transcript', role: 'user', text: 'old', final: true });
    f.event({ type: 'transcript', role: 'user', text: 'new', final: false });
    expect(f.state()?.userCaption).toBe('new');
    f.listener()({ type: 'audio', requestId: vi.mocked(f.bridge.start).mock.calls[0][0].requestId,
      source: f.source,
      voiceSessionId: 'different', audioBase64: 'AAA=' });
    expect(f.audio.play).not.toHaveBeenCalled();
    f.controller.dispose();
  });
  it('keeps early ready admission but rejects media and captions from a different native source', async () => {
    const f = fixture();
    const creation = deferred<RealtimeVoiceSession>();
    vi.mocked(f.bridge.start).mockReturnValue(creation.promise);
    const starting = f.controller.start('conversation-1'); await flush();
    f.event({ type: 'ready', source: f.source });
    f.event({ type: 'audio', source: f.source, audioBase64: 'AAA=' });
    expect(f.audio.play).not.toHaveBeenCalled();
    creation.resolve({ requestId: vi.mocked(f.bridge.start).mock.calls[0][0].requestId,
      voiceSessionId: 'native-1', source: f.source, model: 'live', voice: 'calm',
      inputEncoding: 'pcm16', inputSampleRateHz: 24000, outputEncoding: 'pcm16', outputSampleRateHz: 24000 });
    await starting;
    expect(f.state()?.phase).toBe('active');
    const requestId = vi.mocked(f.bridge.start).mock.calls[0][0].requestId;
    f.listener()({ type: 'audio', requestId, voiceSessionId: 'native-1',
      source: { ...f.source, sessionId: 'replacement-native' }, audioBase64: 'AAA=' });
    f.listener()({ type: 'transcript', requestId, voiceSessionId: 'native-1',
      source: { ...f.source, sessionKey: 'agent:main:other' }, role: 'assistant', text: 'unowned text', final: true });
    expect(f.audio.play).not.toHaveBeenCalled();
    expect(f.state()?.assistantCaption).toBe('');
    f.controller.dispose();
  });
  it('reports an unknown creation outcome and never retries automatically', async () => {
    const f = fixture();
    vi.mocked(f.bridge.start).mockRejectedValue(new Error('Realtime voice start outcome is unknown.'));
    await f.controller.start('conversation-1');
    expect(f.state()?.phase).toBe('unknown');
    expect(f.bridge.start).toHaveBeenCalledTimes(1);
    f.controller.dispose();
  });
  it('coalesces concurrent closes and cannot overwrite a later call with a stale terminal', async () => {
    const f = fixture(); await f.controller.start('conversation-1');
    const closing = deferred<void>();
    vi.mocked(f.bridge.close).mockReturnValueOnce(closing.promise);
    const first = f.controller.end();
    const duplicate = f.controller.end();
    expect(f.bridge.close).toHaveBeenCalledTimes(1);
    closing.resolve(); await first;
    const next = f.controller.start('conversation-2');
    await duplicate; await next;
    expect(f.state()?.phase).toBe('connecting');
    expect(f.bridge.start).toHaveBeenCalledTimes(2);
    f.controller.dispose();
  });
});
