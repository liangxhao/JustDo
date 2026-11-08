import { describe, expect, it } from 'vitest';

import { isRealtimeVoiceAudio, isRealtimeVoiceIdentity, isRealtimeVoiceRequestId } from './realtimeVoice';

describe('realtime voice IPC validation', () => {
  it('accepts bounded PCM16 frames and rejects odd bytes, malformed padding and oversized frames', () => {
    expect(isRealtimeVoiceAudio('AAA=')).toBe(true);
    for (const value of ['', 'AA==', 'AAB=', 'AAAA', '!!!!', 'AAAA\n', 'A'.repeat(128004)])
      expect(isRealtimeVoiceAudio(value)).toBe(false);
  });
  it('keeps request and native identities bounded and free of control characters', () => {
    expect(isRealtimeVoiceRequestId('recording-1')).toBe(true);
    expect(isRealtimeVoiceRequestId('bad id')).toBe(false);
    expect(isRealtimeVoiceIdentity('voice-1')).toBe(true);
    expect(isRealtimeVoiceIdentity('voice\n1')).toBe(false);
  });
});
