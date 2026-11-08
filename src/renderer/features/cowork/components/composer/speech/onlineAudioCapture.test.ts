// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

import { bytesToBase64, floatToG711Ulaw, OnlineAsrAudioPump } from './onlineAudioCapture';

afterEach(() => vi.unstubAllGlobals());

it('encodes browser samples using the OpenClaw G.711 mu-law contract', () => {
  expect([...floatToG711Ulaw(new Float32Array([0, 1, -1]))]).toEqual([255, 128, 0]);
});

it('encodes binary audio as base64 without changing bytes', () => {
  expect(bytesToBase64(new Uint8Array([0, 127, 128, 255]))).toBe('AH+A/w==');
});

it('does not close the next audio context when a cancelled resume finishes late', async () => {
  let resumeOld!: () => void;
  const contexts: FakeAudioContext[] = [];
  class FakeAudioContext {
    sampleRate = 8000;
    state = 'suspended';
    destination = {};
    constructor() {
      contexts.push(this);
    }
    resume = () =>
      contexts.length === 1
        ? new Promise<void>(resolve => {
            resumeOld = resolve;
          })
        : Promise.resolve().then(() => {
            this.state = 'running';
          });
    close = vi.fn().mockImplementation(() => {
      this.state = 'closed';
      return Promise.resolve();
    });
    createScriptProcessor = () => ({ connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null });
    createGain = () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() });
  }
  vi.stubGlobal('AudioContext', FakeAudioContext);
  const pump = new OnlineAsrAudioPump();
  pump.prepare();
  const old = pump.start([], vi.fn());
  const rejected = expect(old).rejects.toThrow('cancelled');
  pump.stop();
  pump.prepare();
  await pump.start([], vi.fn());
  resumeOld();
  await rejected;
  expect(contexts[0].close).toHaveBeenCalledOnce();
  expect(contexts[1].close).not.toHaveBeenCalled();
  pump.stop();
});
