import { expect, it } from 'vitest';

import { getRealtimeVoiceConfigurationKey } from './realtimeVoiceConfiguration';

it('preserves an active call for unrelated catalog edits but invalidates its effective voice and credentials', () => {
  const config = { voice: { realtimeEnabled: true, realtimeModelRef: 'office/live', realtimeBindingId: 'duplex',
    realtimeVoiceSelection: { kind: 'preset', voiceId: 'selected' } }, onlineModelProviders: { 'realtime-voice': {
    providers: { office: { displayName: 'Office', baseUrl: 'wss://speech.internal/v1', apiKey: '', models: [{
      id: 'live', name: 'Live', voices: [{ id: 'selected', name: 'Selected' }],
      bindings: [{ id: 'duplex', protocolId: 'openai-voice-realtime', inputTranscriptionModel: 'stt' }],
    }] } },
  } } };
  const before = getRealtimeVoiceConfigurationKey(config);
  const provider = config.onlineModelProviders['realtime-voice'].providers.office;
  provider.displayName = 'Renamed'; provider.models[0].name = 'New label';
  provider.models[0].voices.push({ id: 'unselected', name: 'Another' });
  provider.models.push({ ...structuredClone(provider.models[0]), id: 'unselected-model' });
  expect(getRealtimeVoiceConfigurationKey(config)).toBe(before);
  provider.apiKey = 'rotated';
  expect(getRealtimeVoiceConfigurationKey(config)).not.toBe(before);
  provider.apiKey = '';
  provider.models[0].voices = [{ id: 'unselected', name: 'Another' }];
  expect(getRealtimeVoiceConfigurationKey(config)).not.toBe(before);
});
