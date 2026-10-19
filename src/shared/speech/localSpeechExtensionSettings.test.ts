import { describe, expect, it } from 'vitest';

import {
  defaultLocalSpeechExtensionSettings,
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

  it.each([null, [], { sttModelId: 'bad' }, { ttsModelId: 'bad' }, { enabled: true }])(
    'rejects invalid preferences before persistence (%j)',
    input => {
      expect(() => parseLocalSpeechExtensionSettingsPatch(input)).toThrow();
    },
  );
});
