import { LOCAL_ASR_MODEL_IDS } from '@shared/speech/localAsr';
import { LocalSpeechModelKind } from '@shared/speech/localSpeechModels';
import { normalizeLocalSpeechSettings } from '@shared/speech/localSpeechSettings';
import { LOCAL_TTS_MODEL_ID, LOCAL_TTS_MODEL_IDS } from '@shared/speech/localTts';
import { describe, expect, it } from 'vitest';

import {
  getLocalSpeechModelCatalog,
  getLocalSpeechModelCatalogEntry,
  getLocalSpeechVoiceDisplayName,
  getLocalSpeechVoiceMetadata,
  getLocalSpeechVoiceOptions,
} from './localSpeechModelCatalog';

describe('local speech model presentation catalog', () => {
  it('covers every selectable local model under its own capability', () => {
    expect(getLocalSpeechModelCatalog(LocalSpeechModelKind.Asr).map(model => model.id)).toEqual(
      LOCAL_ASR_MODEL_IDS,
    );
    expect(getLocalSpeechModelCatalog(LocalSpeechModelKind.Tts).map(model => model.id)).toEqual(
      LOCAL_TTS_MODEL_IDS,
    );
    expect(getLocalSpeechModelCatalogEntry('unknown-model')).toBeUndefined();
  });

  it('shows the application recognition languages without claiming Cantonese for Whisper', () => {
    const asr = getLocalSpeechModelCatalog(LocalSpeechModelKind.Asr);
    expect(asr[0].languages).toEqual(['zh', 'en', 'ja', 'ko', 'yue']);
    expect(asr[1].languages).toEqual(['zh', 'en', 'ja', 'ko']);
    expect(asr.every(model => model.voices.length === 0)).toBe(true);
  });

  it('exposes all native Kokoro voices with the published language, gender and accent classifications', () => {
    const model = getLocalSpeechModelCatalogEntry(LOCAL_TTS_MODEL_ID)!;
    expect(model.languages).toEqual(['zh', 'en']);
    expect(model.voices).toHaveLength(103);
    expect(model.voices.map(voice => voice.id)).toEqual(
      Array.from({ length: 103 }, (_, id) => String(id)),
    );
    expect(new Set(model.voices.map(voice => voice.name)).size).toBe(103);
    expect(model.voices[0]).toMatchObject({
      name: 'af_maple',
      displayName: 'Maple',
      language: 'en',
      gender: 'female',
      accent: 'en-US',
    });
    expect(model.voices[1]).toMatchObject({ name: 'af_sol', displayName: 'Sol', accent: 'en-US' });
    expect(model.voices[2]).toMatchObject({
      name: 'bf_vale',
      displayName: 'Vale',
      accent: 'en-GB',
    });
    expect(model.voices.filter(voice => voice.language === 'en')).toHaveLength(3);
    expect(
      model.voices.filter(voice => voice.language === 'zh' && voice.gender === 'female'),
    ).toHaveLength(55);
    expect(
      model.voices.filter(voice => voice.language === 'zh' && voice.gender === 'male'),
    ).toHaveLength(45);
    expect(
      model.voices
        .slice(3, 58)
        .every(
          voice =>
            voice.name.startsWith('zf_') &&
            voice.language === 'zh' &&
            voice.gender === 'female' &&
            !voice.accent,
        ),
    ).toBe(true);
    expect(
      model.voices
        .slice(58)
        .every(
          voice =>
            voice.name.startsWith('zm_') &&
            voice.language === 'zh' &&
            voice.gender === 'male' &&
            !voice.accent,
        ),
    ).toBe(true);
    expect(model.voices[102]).toMatchObject({ name: 'zm_100' });
  });

  it('retains the published AISHELL-3 speaker labels without inventing voice names', () => {
    const model = getLocalSpeechModelCatalogEntry('vits-icefall-zh-aishell3')!;
    expect(model.voices).toHaveLength(174);
    expect(model.voices[0]).toEqual({ id: '0', name: 'SSB0005', language: 'zh' });
    expect(model.voices[173]).toEqual({ id: '173', name: 'SSB1956', language: 'zh' });
    expect(new Set(model.voices.map(voice => voice.name)).size).toBe(174);
    expect(model.voices.every(voice => /^SSB\d{4}$/.test(voice.name))).toBe(true);
    expect(
      model.voices.every(voice => voice.language === 'zh' && !voice.gender && !voice.accent),
    ).toBe(true);
  });

  it('lists the single Piper Lessac voice and keeps every speaker ID within its runtime model range', () => {
    const piper = getLocalSpeechModelCatalogEntry('vits-piper-en_US-lessac-medium-int8')!;
    expect(piper.voices).toEqual([{ id: '0', name: 'Lessac', language: 'en', accent: 'en-US' }]);
    expect(piper.languages).toEqual(['en']);
    for (const model of getLocalSpeechModelCatalog(LocalSpeechModelKind.Tts)) {
      for (const voice of model.voices) {
        const voiceId = Number(voice.id);
        expect(normalizeLocalSpeechSettings({ ttsModelId: model.id, voiceId }).voiceId).toBe(
          voiceId,
        );
      }
    }
  });

  it('builds consumer options from the complete catalog with stable native identities', () => {
    for (const model of getLocalSpeechModelCatalog(LocalSpeechModelKind.Tts)) {
      const options = getLocalSpeechVoiceOptions(model.id, key => `translated:${key}`);
      expect(options.map(option => option.value)).toEqual(model.voices.map(voice => voice.id));
      for (const [index, option] of options.entries()) {
        expect(option.label).toContain(model.voices[index].name);
        expect(option.label).toContain(`#${model.voices[index].id}`);
      }
    }
    const kokoro = getLocalSpeechVoiceOptions(LOCAL_TTS_MODEL_ID, key => `translated:${key}`);
    expect(kokoro[3].label).toBe('translated:voiceSpeakerChineseFemale 001 · zf_001 · #3');
    expect(kokoro[6]).toEqual({
      value: '6',
      label: 'translated:voiceSpeakerChineseFemale 004 · zf_004 · #6',
    });
    expect(kokoro[102]).toEqual({
      value: '102',
      label: 'translated:voiceSpeakerChineseMale 100 · zm_100 · #102',
    });
    expect(getLocalSpeechVoiceOptions('unknown-model', key => key)).toEqual([]);
    expect(getLocalSpeechVoiceOptions(LOCAL_ASR_MODEL_IDS[0], key => key)).toEqual([]);
  });

  it('formats every voice using source names and suffixes without confusing them with native IDs', () => {
    const translate = (key: string) =>
      ({
        voiceSpeakerChineseFemale: '中文女声',
        voiceSpeakerChineseMale: '中文男声',
        voiceSpeakerChinese: '中文音色',
        voiceAccentAmerican: '美式英语',
        voiceAccentBritish: '英式英语',
        voiceGenderFemale: '女声',
        voiceGenderMale: '男声',
        chinese: '中文',
        english: '英语',
      })[key] ?? key;
    const voices = getLocalSpeechModelCatalogEntry(LOCAL_TTS_MODEL_ID)!.voices;
    const names = voices.map(voice => getLocalSpeechVoiceDisplayName(voice, translate));
    expect(names.slice(0, 3)).toEqual(['Maple', 'Sol', 'Vale']);
    expect(names[3]).toBe('中文女声 001');
    expect(names[57]).toBe('中文女声 099');
    expect(names[58]).toBe('中文男声 009');
    expect(names[69]).toBe('中文男声 030');
    expect(names[92]).toBe('中文男声 069');
    expect(names[102]).toBe('中文男声 100');
    expect(new Set(names).size).toBe(103);
    expect(getLocalSpeechVoiceMetadata(voices[0], translate)).toBe('美式英语 · 女声');
    expect(getLocalSpeechVoiceMetadata(voices[2], translate)).toBe('英式英语 · 女声');
    expect(getLocalSpeechVoiceMetadata(voices[92], translate)).toBe('中文 · 男声');
    const options = getLocalSpeechVoiceOptions(LOCAL_TTS_MODEL_ID, translate);
    expect(options[0].label).toBe('Maple · 美式英语 · 女声 · af_maple · #0');
    expect(options[92].label).toBe('中文男声 069 · zm_069 · #92');
    const aishell = getLocalSpeechModelCatalogEntry('vits-icefall-zh-aishell3')!.voices[0];
    expect(getLocalSpeechVoiceDisplayName(aishell, translate)).toBe('中文音色 SSB0005');
    expect(getLocalSpeechVoiceMetadata(aishell, translate)).toBe('中文');
    expect(getLocalSpeechVoiceOptions('vits-piper-en_US-lessac-medium-int8', translate)).toEqual([
      { value: '0', label: 'Lessac · 美式英语 · #0' },
    ]);
  });

  it('formats partial presentation records without inventing missing language, gender or accent', () => {
    expect(getLocalSpeechVoiceDisplayName({ id: '4', name: 'source' }, key => key)).toBe('source');
    expect(getLocalSpeechVoiceMetadata({ id: '4', name: 'source' }, key => key)).toBe('');
  });
});
