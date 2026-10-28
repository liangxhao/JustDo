import { describe, expect, it } from 'vitest';

import { normalizeNativeTtsConfig } from './nativeTtsConfig';

describe('native TTS configuration projection', () => {
  it('clones current provider parameters, credentials and persona configuration without changing the source', () => {
    const original = {
      auto: 'off', provider: 'openai', timeoutMs: 120_000,
      providers: {
        openai: { speakerVoice: 'speaker', apiKey: { source: 'exec', provider: 'internal', id: 'speech' }, custom: 7 },
        'tts-local-cli': { command: 'tts.exe', args: ['--sid=3'] },
      },
      personas: { narrator: { provider: 'openai', providers: { openai: { speakerVoice: 'narrator' } } } },
    };
    const before = structuredClone(original);
    const projected = normalizeNativeTtsConfig(original)!;
    expect(projected).toEqual(original);
    expect(projected).not.toBe(original);
    expect(projected.providers).not.toBe(original.providers);
    expect(projected.personas).not.toBe(original.personas);
    expect(normalizeNativeTtsConfig(projected)).toEqual(projected);
    expect(original).toEqual(before);
  });

  it('leaves invalid values visible to native validation and introduces no provider or endpoint', () => {
    const input = { auto: 'invalid', providers: { invalid: false } };
    expect(normalizeNativeTtsConfig(input)).toEqual(input);
    expect(normalizeNativeTtsConfig({})).toEqual({});
  });

  it.each([undefined, null, false, [], 'invalid'])('does not project non-object TTS configuration: %j', input => {
    expect(normalizeNativeTtsConfig(input)).toBeNull();
  });
});
