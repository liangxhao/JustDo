import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  encodeAudioBufferToWav,
  LOCAL_ASR_SAMPLE_RATE,
  normalizeAudioForLocalAsr,
  recordedAudioToWavChunks,
} from './localAudioCapture';

afterEach(() => vi.unstubAllGlobals());

function decodedBuffer(channels: Float32Array[], sampleRate = LOCAL_ASR_SAMPLE_RATE): AudioBuffer {
  return {
    numberOfChannels: channels.length,
    length: channels[0]?.length ?? 0,
    sampleRate,
    getChannelData: (channel: number) => channels[channel],
    copyToChannel: (samples: Float32Array, channel: number) => channels[channel].set(samples),
  } as unknown as AudioBuffer;
}

describe('shared local audio capture', () => {
  it('encodes and downmixes browser audio into mono PCM16 WAV', () => {
    const audio = {
      numberOfChannels: 2,
      length: 2,
      sampleRate: 16_000,
      getChannelData: (channel: number) =>
        channel === 0 ? new Float32Array([1, -1]) : new Float32Array([0, 0]),
    } as AudioBuffer;

    const wav = encodeAudioBufferToWav(audio);
    const view = new DataView(wav.buffer);

    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(wav.slice(8, 12))).toBe('WAVE');
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(40, true)).toBe(4);
    expect(view.getInt16(44, true)).toBe(16_383);
    expect(view.getInt16(46, true)).toBe(-16_384);
  });

  it('normalizes browser-rate audio to the ASR sample rate', () => {
    const audio = {
      numberOfChannels: 1,
      length: 6,
      sampleRate: 48_000,
      getChannelData: () => new Float32Array([1, 1, 1, -1, -1, -1]),
    } as unknown as AudioBuffer;

    expect([...normalizeAudioForLocalAsr(audio)]).toEqual([1, -1]);
    const wav = encodeAudioBufferToWav(audio);
    const view = new DataView(wav.buffer);
    expect(view.getUint32(24, true)).toBe(LOCAL_ASR_SAMPLE_RATE);
    expect(view.getUint32(40, true)).toBe(4);
  });

  it('keeps every imported sample in fixed 30-second WAV chunks and retains the final tail', async () => {
    const framesPerChunk = 30 * LOCAL_ASR_SAMPLE_RATE;
    const samples = new Float32Array(framesPerChunk * 2 + 4_000);
    samples.fill(0.25, 0, framesPerChunk);
    samples.fill(-0.5, framesPerChunk, framesPerChunk * 2);
    samples.fill(0.75, framesPerChunk * 2);
    const close = vi.fn(async () => {});
    vi.stubGlobal(
      'AudioContext',
      class {
        decodeAudioData = vi.fn(async () => decodedBuffer([samples]));
        close = close;
        createBuffer = (channels: number, length: number, sampleRate: number) =>
          decodedBuffer(
            Array.from({ length: channels }, () => new Float32Array(length)),
            sampleRate,
          );
      },
    );

    const chunks = await recordedAudioToWavChunks(new Blob(['encoded fixture']));

    expect(chunks).toHaveLength(3);
    const payloadSizes = chunks.map(chunk => new DataView(chunk.buffer).getUint32(40, true));
    expect(payloadSizes).toEqual([framesPerChunk * 2, framesPerChunk * 2, 8_000]);
    expect(payloadSizes.reduce((sum, size) => sum + size, 0)).toBe(samples.length * 2);
    for (const [index, chunk] of chunks.entries()) {
      const view = new DataView(chunk.buffer);
      expect(view.getUint16(22, true)).toBe(1);
      expect(view.getUint32(24, true)).toBe(LOCAL_ASR_SAMPLE_RATE);
      expect(view.getInt16(44, true)).toBe([8191, -16384, 24575][index]);
      expect(view.getInt16(chunk.length - 2, true)).toBe([8191, -16384, 24575][index]);
    }
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes the decoding context after an imported file fails to decode', async () => {
    const close = vi.fn(async () => {});
    vi.stubGlobal(
      'AudioContext',
      class {
        decodeAudioData = vi.fn(async () => {
          throw new Error('Invalid fixture audio');
        });
        close = close;
      },
    );

    await expect(recordedAudioToWavChunks(new Blob(['invalid fixture']))).rejects.toThrow(
      'Invalid fixture audio',
    );
    expect(close).toHaveBeenCalledOnce();
  });
});
