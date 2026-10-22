import { describe, expect, it } from 'vitest';

import { bytesToBase64, floatToG711Ulaw } from './onlineAudioCapture';

describe('online audio capture', () => {
  it('encodes browser samples using the OpenClaw G.711 mu-law contract', () => {
    expect([...floatToG711Ulaw(new Float32Array([0, 1, -1]))]).toEqual([255, 128, 0]);
  });

  it('encodes binary audio as base64 without changing bytes', () => {
    expect(bytesToBase64(new Uint8Array([0, 127, 128, 255]))).toBe('AH+A/w==');
  });
});
