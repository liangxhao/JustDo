import { describe, expect, it, vi } from 'vitest';

import { defaultLocalSpeechSettings } from '../../shared/speech/localSpeechSettings';
import {
  advanceSpeechConfigurationRevision,
  getSpeechConfigurationRevision,
  onSpeechConfigurationChanged,
} from './speechConfigurationRevision';

describe('speech configuration revisions', () => {
  it('invalidates active requests when an inherited provider protocol changes', () => {
    const makeProvider = (protocolId: string, inputTranscriptionModel?: string) => ({
      providers: {
        office: {
          displayName: 'Office',
          baseUrl: 'http://speech.internal/v1',
          apiKey: '',
          protocolId,
          models: [
            {
              id: 'model',
              name: 'Model',
              voices: [{ id: 'voice', name: 'Voice' }],
              ...(inputTranscriptionModel ? { inputTranscriptionModel } : {}),
            },
          ],
        },
      },
    });
    const a = {
      voice: {
        ...defaultLocalSpeechSettings,
        inputEnabled: true,
        recognitionMode: 'online',
        onlineAsrModelRef: 'office/model',
        outputEnabled: true,
        synthesisMode: 'online',
        onlineTtsModelRef: 'office/model',
        onlineTtsVoiceSelection: { kind: 'preset', voiceId: 'voice' },
        realtimeEnabled: true,
        realtimeModelRef: 'office/model',
        realtimeVoiceSelection: { kind: 'preset', voiceId: 'voice' },
      },
      onlineModelProviders: {
        'speech-recognition': makeProvider('openai-transcription-http'),
        'speech-synthesis': makeProvider('openai-speech-http'),
        'realtime-voice': makeProvider('openai-voice-realtime', 'captions'),
      },
    };
    const b = structuredClone(a);
    b.onlineModelProviders['speech-recognition'].providers.office.protocolId =
      'openai-transcription-realtime';
    Object.assign(b.onlineModelProviders['speech-synthesis'].providers.office, {
      protocolId: 'unsupported',
    });
    b.onlineModelProviders['realtime-voice'].providers.office.protocolId = 'unsupported';
    const scopes = ['input', 'output', 'realtime'] as const;
    const before = scopes.map(getSpeechConfigurationRevision);
    advanceSpeechConfigurationRevision(b, a);
    expect(scopes.map(getSpeechConfigurationRevision)).toEqual(
      before.map(revision => revision + 1),
    );
  });
  it('invalidates selected voice removal but preserves display and unselected catalog changes', () => {
    const a = {
      voice: {
        ...defaultLocalSpeechSettings,
        outputEnabled: true,
        synthesisMode: 'online',
        onlineTtsModelRef: 'service/speech',
        onlineTtsBindingId: 'tts',
        onlineTtsVoiceSelection: { kind: 'preset', voiceId: 'selected' },
      },
      onlineModelProviders: {
        'speech-synthesis': {
          providers: {
            service: {
              displayName: 'Original',
              baseUrl: 'http://speech.internal/v1',
              apiKey: '',
              models: [
                {
                  id: 'speech',
                  name: 'Speech',
                  bindings: [{ id: 'tts', protocolId: 'openai-speech-http' }],
                  voices: [{ id: 'selected', name: 'Selected' }],
                },
              ],
            },
          },
        },
      },
    };
    const b = structuredClone(a);
    b.onlineModelProviders['speech-synthesis'].providers.service.displayName = 'Renamed';
    b.onlineModelProviders['speech-synthesis'].providers.service.models[0].voices.push({
      id: 'other',
      name: 'Other',
    });
    const callback = vi.fn();
    const unsubscribe = onSpeechConfigurationChanged('output', callback);
    const revision = getSpeechConfigurationRevision('output');
    advanceSpeechConfigurationRevision(b, a);
    expect(getSpeechConfigurationRevision('output')).toBe(revision);
    b.onlineModelProviders['speech-synthesis'].providers.service.models[0].voices = [
      { id: 'other', name: 'Other' },
    ];
    advanceSpeechConfigurationRevision(b, a);
    expect(getSpeechConfigurationRevision('output')).toBe(revision + 1);
    expect(callback).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it('retains a monotonic epoch when a failed change rolls B back to A', () => {
    const a = {
      voice: {
        ...defaultLocalSpeechSettings,
        outputEnabled: true,
        synthesisMode: 'online',
        onlineTtsModelRef: 'a',
      },
    };
    const b = { voice: { ...a.voice, onlineTtsModelRef: 'b' } };
    const before = getSpeechConfigurationRevision('output');
    advanceSpeechConfigurationRevision(b, a);
    advanceSpeechConfigurationRevision(a, b);
    expect(getSpeechConfigurationRevision('output')).toBe(before + 2);
  });
});
