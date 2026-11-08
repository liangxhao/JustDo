import { afterEach, expect, it, vi } from 'vitest';

import { openRealtimeVoiceAudio, RealtimePcmEncoder } from './realtimeVoiceAudio';
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it('keeps PCM24k sample continuity across arbitrary capture chunk boundaries', () => {
  const samples = new Float32Array(4410).map((_, index) => Math.sin(index / 100));
  const full = new RealtimePcmEncoder(44100).encode(samples);
  const encoder = new RealtimePcmEncoder(44100);
  const parts = [samples.slice(0, 1000), samples.slice(1000, 2048), samples.slice(2048)]
    .map(part => atob(encoder.encode(part))).join('');
  expect(parts).toBe(atob(full));
  expect(parts.length).toBe(4800);
});
it('releases the microphone and context when media node construction fails', async () => {
  const stop = vi.fn(); const close = vi.fn(async () => undefined);
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) } });
  vi.stubGlobal('AudioContext', class {
    close = close;
    createMediaStreamSource() { throw new Error('device setup failed'); }
  });
  await expect(openRealtimeVoiceAudio('')).rejects.toThrow('device setup failed');
  expect(stop).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});
it('acknowledges playback against the audio clock rather than a suspended wall clock', async () => {
  vi.useFakeTimers();
  let clock = 0;
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }) } });
  vi.stubGlobal('AudioContext', class {
    sampleRate = 24000;
    get currentTime() { return clock; }
    createMediaStreamSource = node;
    createScriptProcessor = node;
    createGain = () => ({ ...node(), gain: { value: 1 } });
    createBuffer = (_channels: number, length: number, rate: number) => ({
      duration: length / rate, getChannelData: () => new Float32Array(length),
    });
    createBufferSource = () => ({ ...node(), start: vi.fn(), stop: vi.fn() });
    close = async () => undefined;
  });
  const audio = await openRealtimeVoiceAudio('');
  audio.play('AAA=');
  const acknowledge = vi.fn();
  audio.afterPlayback(acknowledge);
  await vi.advanceTimersByTimeAsync(100);
  expect(acknowledge).not.toHaveBeenCalled();
  clock = 1;
  await vi.advanceTimersByTimeAsync(30);
  expect(acknowledge).toHaveBeenCalledOnce();
  audio.close();
});
