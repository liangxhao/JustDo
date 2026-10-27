import { describe, expect, it } from 'vitest';

import {
  getOnlineSpeechModelOptions,
  getOnlineSpeechVoiceOptions,
  normalizeOnlineSpeechBaseUrl,
  resolveOnlineSpeechModel,
} from './onlineSpeechModels';

const category = {
  providers: {
    internal: {
      displayName: ' Internal ',
      baseUrl: 'https://speech.internal/v1',
      apiKey: '',
      models: [
        {
          id: ' voice/model ',
          name: ' Speech ',
          voices: [
            { id: ' a ', name: ' Alice ' },
            { id: 'a', name: 'Duplicate' },
            { id: 'b', name: '' },
          ],
        },
        { id: 'voice/model', name: 'Duplicate' },
        { id: 'asr', name: '' },
      ],
    },
    realtime: {
      displayName: 'Realtime',
      baseUrl: 'wss://speech.internal/realtime',
      apiKey: '',
      models: [{ id: 'live', name: 'Live' }],
    },
  },
};

describe('online speech model catalog', () => {
  it('resolves stable provider/model references and trims presentation fields without mutating the catalog', () => {
    expect(resolveOnlineSpeechModel(category, ' internal/voice/model ')).toMatchObject({
      providerId: 'internal',
      model: { id: 'voice/model', name: 'Speech' },
    });
    expect(category.providers.internal.models[0].id).toBe(' voice/model ');
    expect(resolveOnlineSpeechModel(category, 'internal/missing')).toBeNull();
  });

  it('deduplicates configured model and voice IDs while preserving their native order', () => {
    expect(getOnlineSpeechVoiceOptions(category.providers.internal.models[0])).toEqual([
      { value: 'a', label: 'Alice' },
      { value: 'b', label: 'b' },
    ]);
    expect(getOnlineSpeechModelOptions(category)).toEqual([
      { value: 'internal/voice/model', label: 'Internal / Speech' },
      { value: 'internal/asr', label: 'Internal / asr' },
      { value: 'realtime/live', label: 'Realtime / Live' },
    ]);
    expect(getOnlineSpeechModelOptions(category, { requireVoice: true })).toEqual([
      { value: 'internal/voice/model', label: 'Internal / Speech' },
    ]);
  });

  it('keeps realtime models available to microphone callers but excludes them from file transcription', () => {
    expect(
      getOnlineSpeechModelOptions(category, { fileTranscription: true }).map(
        option => option.value,
      ),
    ).toEqual(['internal/voice/model', 'internal/asr']);
    expect(() => normalizeOnlineSpeechBaseUrl('wss://speech.internal/realtime', 'stt')).toThrow();
  });

  it('requires HTTP speech synthesis even when a websocket catalog model declares voices', () => {
    for (const baseUrl of [
      'wss://speech.internal/realtime',
      'https://speech.internal/v1?token=unsafe',
      'https://speech.internal/v1#fragment',
    ]) {
      const input = { providers: { p: { ...category.providers.internal, baseUrl } } };
      expect(getOnlineSpeechModelOptions(input, { requireVoice: true })).toEqual([]);
    }
  });

  it.each([undefined, null, [], { providers: [] }, { providers: { bad: { models: [null] } } }])(
    'does not advertise malformed catalog data (%j)',
    value => {
      expect(getOnlineSpeechModelOptions(value)).toEqual([]);
      expect(resolveOnlineSpeechModel(value, 'bad/model')).toBeNull();
    },
  );

  it('tolerates malformed names and rejects transport credentials and invalid voice IDs', () => {
    const malformed = {
      providers: {
        p: {
          baseUrl: 'http://speech.internal/v1',
          apiKey: '',
          models: [null, { id: 'a', name: 42 }],
        },
      },
    };
    expect(resolveOnlineSpeechModel(malformed, 'p/a')?.model.name).toBe('a');
    expect(
      getOnlineSpeechVoiceOptions({ id: 'a', name: '', voices: [{ id: 'bad\nvoice', name: '' }] }),
    ).toEqual([]);
    for (const baseUrl of [
      'file:///model',
      'https://user:password@speech.internal/v1',
      'https://speech.internal/v1?key=unsafe',
      'https://speech.internal/v1#fragment',
    ]) {
      const input = { providers: { p: { baseUrl, apiKey: '', models: [{ id: 'a', name: '' }] } } };
      expect(getOnlineSpeechModelOptions(input, { fileTranscription: true })).toEqual([]);
      expect(() => normalizeOnlineSpeechBaseUrl(baseUrl, 'tts')).toThrow();
    }
  });

  it('normalizes only configured HTTP capability paths and preserves the origin', () => {
    expect(
      normalizeOnlineSpeechBaseUrl(' https://speech.internal/v1/audio/transcriptions/ ', 'stt'),
    ).toBe('https://speech.internal/v1');
    expect(normalizeOnlineSpeechBaseUrl('http://speech.internal/api/realtime', 'stt')).toBe(
      'http://speech.internal/api',
    );
    expect(normalizeOnlineSpeechBaseUrl('https://speech.internal/v1/audio/speech', 'tts')).toBe(
      'https://speech.internal/v1',
    );
  });
});
