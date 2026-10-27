import { describe, expect, it } from 'vitest';

import {
  defaultLocalSpeechExtensionSettings,
  mergeLocalSpeechExtensionSettingsPatch,
  normalizeLocalSpeechExtensionSettings,
  parseLocalSpeechExtensionSettingsPatch,
} from './localSpeechExtensionSettings';

describe('local speech extension preferences', () => {
  it('uses independent defaults for missing or invalid saved values', () => {
    expect(normalizeLocalSpeechExtensionSettings(undefined)).toEqual(
      defaultLocalSpeechExtensionSettings,
    );
    expect(
      normalizeLocalSpeechExtensionSettings({ sttModelId: 'arbitrary-command', ttsModelId: null }),
    ).toEqual(defaultLocalSpeechExtensionSettings);
  });

  it('keeps sparse model patches sparse for atomic Main merging', () => {
    expect(
      parseLocalSpeechExtensionSettingsPatch({ sttModelId: 'sherpa-onnx-whisper-base' }),
    ).toEqual({ sttModelId: 'sherpa-onnx-whisper-base' });
  });

  it('uses each model default when no voice was selected', () => {
    expect(
      normalizeLocalSpeechExtensionSettings({ ttsModelId: 'kokoro-int8-multi-lang-v1_1' })
        .ttsVoiceId,
    ).toBe(3);
    expect(
      normalizeLocalSpeechExtensionSettings({ ttsModelId: 'vits-icefall-zh-aishell3' }).ttsVoiceId,
    ).toBe(0);
    expect(
      normalizeLocalSpeechExtensionSettings({ ttsModelId: 'vits-piper-en_US-lessac-medium-int8' })
        .ttsVoiceId,
    ).toBe(0);
  });

  it('preserves saved valid voices and repairs invalid persisted voices with the model default', () => {
    expect(normalizeLocalSpeechExtensionSettings({ ttsVoiceId: 102 }).ttsVoiceId).toBe(102);
    expect(normalizeLocalSpeechExtensionSettings({ ttsVoiceId: 103 }).ttsVoiceId).toBe(3);
    expect(
      normalizeLocalSpeechExtensionSettings({
        ttsModelId: 'vits-icefall-zh-aishell3',
        ttsVoiceId: 173,
      }).ttsVoiceId,
    ).toBe(173);
    expect(
      normalizeLocalSpeechExtensionSettings({
        ttsModelId: 'vits-piper-en_US-lessac-medium-int8',
        ttsVoiceId: 3,
      }).ttsVoiceId,
    ).toBe(0);
  });

  it('validates sparse explicit voices against the currently selected model', () => {
    expect(
      parseLocalSpeechExtensionSettingsPatch(
        { ttsVoiceId: 173 },
        {
          ttsModelId: 'vits-icefall-zh-aishell3',
        },
      ),
    ).toEqual({ ttsVoiceId: 173 });
    expect(() => parseLocalSpeechExtensionSettingsPatch({ ttsVoiceId: 173 })).toThrow();
    expect(() =>
      parseLocalSpeechExtensionSettingsPatch(
        {
          ttsModelId: 'vits-piper-en_US-lessac-medium-int8',
          ttsVoiceId: 3,
        },
        { ttsModelId: 'kokoro-int8-multi-lang-v1_1' },
      ),
    ).toThrow();
  });

  it('resets a model-only switch to its own default without resetting a same-model or STT patch', () => {
    const original = { ...defaultLocalSpeechExtensionSettings, ttsVoiceId: 102 };
    expect(
      mergeLocalSpeechExtensionSettingsPatch(original, { ttsModelId: 'vits-icefall-zh-aishell3' }),
    ).toEqual({
      ...original,
      ttsModelId: 'vits-icefall-zh-aishell3',
      ttsVoiceId: 0,
    });
    expect(
      mergeLocalSpeechExtensionSettingsPatch(original, { ttsModelId: original.ttsModelId }),
    ).toEqual(original);
    expect(
      mergeLocalSpeechExtensionSettingsPatch(original, { sttModelId: 'sherpa-onnx-whisper-base' }),
    ).toEqual({
      ...original,
      sttModelId: 'sherpa-onnx-whisper-base',
    });
    expect(original.ttsVoiceId).toBe(102);
  });

  it('honors an explicit voice paired with a new model', () => {
    expect(
      mergeLocalSpeechExtensionSettingsPatch(undefined, {
        ttsModelId: 'vits-icefall-zh-aishell3',
        ttsVoiceId: 173,
      }),
    ).toEqual({
      ...defaultLocalSpeechExtensionSettings,
      ttsModelId: 'vits-icefall-zh-aishell3',
      ttsVoiceId: 173,
    });
  });

  it.each([-1, 103, 1.5, NaN, Infinity, '3', null, undefined, {}, []])(
    'rejects invalid explicit Kokoro voices before persistence (%j)',
    ttsVoiceId => {
      expect(() => parseLocalSpeechExtensionSettingsPatch({ ttsVoiceId })).toThrow();
    },
  );

  it.each([null, [], { sttModelId: 'bad' }, { ttsModelId: 'bad' }, { enabled: true }])(
    'rejects invalid preferences before persistence (%j)',
    input => {
      expect(() => parseLocalSpeechExtensionSettingsPatch(input)).toThrow();
    },
  );
});
