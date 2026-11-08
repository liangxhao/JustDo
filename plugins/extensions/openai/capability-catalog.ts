import type { PluginCapabilityCatalogHostEntry } from 'openclaw/plugin-sdk/plugin-entry';

import { buildManagedRealtimeVoiceProvider } from './managed-realtime-voice-provider.js';
import { buildOpenAIRealtimeTranscriptionProvider } from './realtime-transcription-provider-factory.js';
import { buildOpenAISpeechProvider } from './speech-provider.js';

const catalog: PluginCapabilityCatalogHostEntry = context => ({
  speechProviders: [buildOpenAISpeechProvider()],
  realtimeTranscriptionProviders: [buildOpenAIRealtimeTranscriptionProvider(context)],
  realtimeVoiceProviders: [buildManagedRealtimeVoiceProvider(context)],
});

export default catalog;
