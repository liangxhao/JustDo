import { describe, expect, it } from 'vitest';

import {
  getLocalTtsDefaultVoiceId,
  getLocalTtsVoiceCount,
  isLocalTtsVoiceId,
  LOCAL_TTS_MODEL_IDS,
} from './localTts';

describe('local TTS voice identities', () => {
  it('admits every native model voice, including the last Kokoro and AISHELL-3 speakers', () => {
    expect(getLocalTtsVoiceCount(LOCAL_TTS_MODEL_IDS[0])).toBe(103);
    expect(getLocalTtsVoiceCount(LOCAL_TTS_MODEL_IDS[1])).toBe(174);
    expect(getLocalTtsVoiceCount(LOCAL_TTS_MODEL_IDS[2])).toBe(1);
    for (const model of LOCAL_TTS_MODEL_IDS) {
      for (let voiceId = 0; voiceId < getLocalTtsVoiceCount(model); voiceId += 1) {
        expect(isLocalTtsVoiceId(model, voiceId)).toBe(true);
      }
      expect(isLocalTtsVoiceId(model, getLocalTtsVoiceCount(model))).toBe(false);
    }
  });

  it('retains existing per-model defaults', () => {
    expect(LOCAL_TTS_MODEL_IDS.map(getLocalTtsDefaultVoiceId)).toEqual([3, 0, 0]);
  });

  it.each([-1, 1.5, NaN, Infinity, '3', null, undefined, {}, []])(
    'rejects malformed native voice IDs (%j)',
    voiceId => {
      expect(isLocalTtsVoiceId(LOCAL_TTS_MODEL_IDS[0], voiceId)).toBe(false);
    },
  );
});
