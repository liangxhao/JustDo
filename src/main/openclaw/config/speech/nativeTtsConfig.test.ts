import { describe, expect, it } from 'vitest';

import { normalizeNativeTtsConfig } from './nativeTtsConfig';

describe('native TTS configuration projection', () => {
  it.each([
    [{ enabled: true }, {}],
    [{ enabled: false }, {}],
    [{ enabled: true, auto: 'off' }, { auto: 'off' }],
    [{ enabled: false, auto: 'inbound' }, { auto: 'inbound' }],
    [{ enabled: true, auto: 'tagged' }, { auto: 'tagged' }],
  ])('drops the removed enabled field without promoting it to an automatic mode: %j', (input, expected) => {
    expect(normalizeNativeTtsConfig(input)).toEqual(expected);
  });

  it.each([
    [{ voice: 'name' }, {}],
    [{ voiceName: 'name' }, {}],
    [{ voiceId: 'id' }, {}],
    [{ voice: 'first', voiceName: 'second', voiceId: 'id' }, {}],
    [{ speakerVoice: 'current', voice: 'old' }, { speakerVoice: 'current' }],
    [{ speakerVoiceId: 'current', voiceId: 'old' }, { speakerVoiceId: 'current' }],
  ])('keeps canonical speaker fields and discards unreleased aliases: %j', (input, expected) => {
    expect(normalizeNativeTtsConfig({
      providers: { openai: input }, personas: { narrator: { providers: { custom: input } } },
    })).toEqual({
      providers: { openai: expected }, personas: { narrator: { providers: { custom: expected } } },
    });
  });

  it('preserves custom provider parameters, credentials, and source objects across repeated projections', () => {
    const original = {
      auto: 'off', enabled: true, provider: 'openai', timeoutMs: 120_000,
      providers: {
        openai: { speakerVoice: 'speaker', voice: 'discarded', apiKey: { source: 'exec', provider: 'internal', id: 'speech' }, custom: 7 },
        local: { command: 'tts.exe', args: ['--sid=3'], voiceId: 3 },
      },
      personas: { narrator: { provider: 'openai', providers: { openai: { voiceName: 'narrator' } } } },
    };
    const before = structuredClone(original);
    const projected = normalizeNativeTtsConfig(original)!;
    expect(projected.providers).toEqual({
      openai: { speakerVoice: 'speaker', apiKey: original.providers.openai.apiKey, custom: 7 },
      local: { command: 'tts.exe', args: ['--sid=3'] },
    });
    expect(projected).toMatchObject({ auto: 'off', timeoutMs: 120_000, provider: 'openai' });
    expect(normalizeNativeTtsConfig(projected)).toEqual(projected);
    expect(original).toEqual(before);
  });

  it('does not repair invalid unrelated values or introduce a provider or endpoint', () => {
    expect(normalizeNativeTtsConfig({ auto: 'invalid', providers: { invalid: false } })).toEqual({
      auto: 'invalid', providers: { invalid: false },
    });
    expect(normalizeNativeTtsConfig({})).toEqual({});
    expect(normalizeNativeTtsConfig(undefined)).toBeNull();
  });
});
