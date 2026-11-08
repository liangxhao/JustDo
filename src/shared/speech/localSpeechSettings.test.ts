import { describe, expect, it } from 'vitest';

import {
  defaultLocalSpeechSettings,
  getRealtimeVoiceSettingsKey,
  normalizeLocalSpeechSettings,
  reconcileLocalSpeechCatalog,
  resolveLocalSpeechInputLanguage,
} from './localSpeechSettings';
import { resolveOnlineSpeechBinding } from './onlineSpeechModels';

describe('local speech settings', () => {
  it('ignores retired meeting settings without restoring them after persistence', () => {
    const settings = normalizeLocalSpeechSettings({
      inputEnabled: true,
      realtimeEnabled: true,
      inputSource: 'microphone-system',
      inputDeviceId: 'shared-microphone',
      meetingMode: true,
      meetingSegmentSeconds: 15,
    });
    expect(settings).toMatchObject({
      inputEnabled: true,
      realtimeEnabled: true,
      inputSource: 'microphone-system',
      inputDeviceId: 'shared-microphone',
    });
    expect(settings).not.toHaveProperty('meetingMode');
    expect(settings).not.toHaveProperty('meetingSegmentSeconds');
    expect(normalizeLocalSpeechSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
  });
  it('does not recover a legacy preset from an explicitly removed voice selection after persistence', () => {
    const settings = normalizeLocalSpeechSettings({
      onlineTtsVoice: 'legacy-speaker',
      onlineTtsVoiceSelection: { kind: 'service-default' },
      synthesisMode: 'online',
    });
    expect(settings.onlineTtsVoiceSelection).toBeNull();
    expect(settings.onlineTtsVoice).toBe('');
    expect(
      normalizeLocalSpeechSettings(JSON.parse(JSON.stringify(settings))).onlineTtsVoiceSelection,
    ).toBeNull();
  });
  it('does not turn a missing explicit binding into legacy protocol admission after catalog replacement', () => {
    const legacy = {
      providers: {
        office: {
          displayName: 'Office',
          baseUrl: 'http://speech.lan/v1',
          apiKey: '',
          models: [{ id: 'shared', name: 'Shared' }],
        },
      },
    };
    const next = reconcileLocalSpeechCatalog(
      {
        ...defaultLocalSpeechSettings,
        inputEnabled: true,
        recognitionMode: 'online',
        onlineAsrModelRef: 'office/shared',
        onlineAsrBindingId: 'recorded-chat',
      },
      { recognition: legacy },
    );
    expect(next.onlineAsrModelRef).toBe('office/shared');
    expect(next.onlineAsrBindingId).toBe('recorded-chat');
    expect(
      resolveOnlineSpeechBinding(
        legacy,
        next.onlineAsrModelRef,
        next.onlineAsrBindingId,
        'composer-asr',
      ),
    ).toBeNull();
  });
  it('loads legacy preset voices while preserving explicit empty selections and independent offline choices', () => {
    expect(
      normalizeLocalSpeechSettings({ onlineTtsVoice: 'speaker' }).onlineTtsVoiceSelection,
    ).toEqual({ kind: 'preset', voiceId: 'speaker' });
    expect(
      normalizeLocalSpeechSettings({ onlineTtsVoice: 'speaker', onlineTtsVoiceSelection: null })
        .onlineTtsVoiceSelection,
    ).toBeNull();
    const settings = normalizeLocalSpeechSettings({
      asrModelId: 'sherpa-onnx-whisper-base',
      ttsModelId: 'vits-icefall-zh-aishell3',
      voiceId: 12,
      speechRate: 1.2,
      realtimeEnabled: true,
      realtimeModelRef: 'office/voice',
      realtimeBindingId: 'conversation',
      realtimeVoiceSelection: { kind: 'preset', voiceId: 'speaker' },
    });
    expect(reconcileLocalSpeechCatalog(settings, {})).toMatchObject({
      asrModelId: 'sherpa-onnx-whisper-base',
      ttsModelId: 'vits-icefall-zh-aishell3',
      voiceId: 12,
      speechRate: 1.2,
      realtimeEnabled: true,
      realtimeModelRef: '',
      realtimeBindingId: '',
      realtimeVoiceSelection: null,
    });
    expect(getRealtimeVoiceSettingsKey(settings)).not.toBe(
      getRealtimeVoiceSettingsKey({ ...settings, realtimeBindingId: 'another' }),
    );
  });
  it('uses stable defaults for missing settings', () => {
    expect(normalizeLocalSpeechSettings(undefined)).toEqual(defaultLocalSpeechSettings);
    expect(defaultLocalSpeechSettings.asrModelId).toBe(
      'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09',
    );
  });

  it('accepts online synthesis mode and rejects unknown values', () => {
    expect(normalizeLocalSpeechSettings({ synthesisMode: 'online' }).synthesisMode).toBe('online');
    expect(normalizeLocalSpeechSettings({ synthesisMode: 'cloud' }).synthesisMode).toBe('local');
  });

  it('preserves the selected online synthesis voice', () => {
    expect(normalizeLocalSpeechSettings({ onlineTtsVoice: 'voice-three' }).onlineTtsVoice).toBe(
      'voice-three',
    );
  });

  it('clamps persisted and untrusted numeric values', () => {
    expect(
      normalizeLocalSpeechSettings({
        maxRecordingSeconds: 999,
        recognitionThreads: 0,
        synthesisThreads: 3.6,
        voiceId: -4,
        speechRate: 0.1,
      }),
    ).toMatchObject({
      maxRecordingSeconds: 120,
      recognitionThreads: 1,
      synthesisThreads: 4,
      voiceId: 0,
      speechRate: 0.5,
    });
  });

  it('resolves the app-language recognition mode', () => {
    expect(resolveLocalSpeechInputLanguage('auto', 'zh')).toBe('auto');
    expect(resolveLocalSpeechInputLanguage('app', 'zh')).toBe('zh');
    expect(resolveLocalSpeechInputLanguage('en', 'zh')).toBe('en');
    expect(resolveLocalSpeechInputLanguage('yue', 'zh')).toBe('yue');
  });

  it('falls back from Cantonese when the OpenClaw relay language contract cannot represent it', () => {
    expect(
      normalizeLocalSpeechSettings({ recognitionMode: 'online', inputLanguage: 'yue' }),
    ).toMatchObject({ recognitionMode: 'online', inputLanguage: 'app' });
  });

  it.each(['local', 'online'])(
    'restores recording for a saved file source in %s mode',
    recognitionMode => {
      expect(normalizeLocalSpeechSettings({ recognitionMode, inputSource: 'file' })).toMatchObject({
        recognitionMode,
        inputSource: 'microphone',
      });
    },
  );

  it('keeps supported model and capture-source selections while rejecting unknown values', () => {
    expect(
      normalizeLocalSpeechSettings({
        asrModelId: 'sherpa-onnx-whisper-base',
        ttsModelId: 'vits-icefall-zh-aishell3',
        inputSource: 'microphone-system',
        recognitionMode: 'online',
        inputDeviceId: 'usb-microphone',
      }),
    ).toMatchObject({
      asrModelId: 'sherpa-onnx-whisper-base',
      ttsModelId: 'vits-icefall-zh-aishell3',
      inputSource: 'microphone-system',
      recognitionMode: 'online',
      inputDeviceId: 'usb-microphone',
    });

    expect(
      normalizeLocalSpeechSettings({
        asrModelId: 'unknown',
        ttsModelId: 'unknown',
        inputSource: 'unknown',
      }),
    ).toMatchObject({
      asrModelId: defaultLocalSpeechSettings.asrModelId,
      ttsModelId: defaultLocalSpeechSettings.ttsModelId,
      inputSource: defaultLocalSpeechSettings.inputSource,
    });
  });

  it('clamps speaker IDs to the selected synthesis model', () => {
    expect(
      normalizeLocalSpeechSettings({
        ttsModelId: 'vits-icefall-zh-aishell3',
        voiceId: 999,
      }).voiceId,
    ).toBe(173);
    expect(
      normalizeLocalSpeechSettings({
        ttsModelId: 'vits-piper-en_US-lessac-medium-int8',
        voiceId: 42,
      }).voiceId,
    ).toBe(0);
  });
});
