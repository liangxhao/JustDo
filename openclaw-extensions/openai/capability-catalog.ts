import type { PluginCapabilityCatalogHostEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { buildOpenAIRealtimeTranscriptionProvider } from './realtime-transcription-provider-factory.js';
import { buildOpenAISpeechProvider } from './speech-provider.js';

const catalog: PluginCapabilityCatalogHostEntry = context => ({
  speechProviders: [buildOpenAISpeechProvider()],
  realtimeTranscriptionProviders: [buildOpenAIRealtimeTranscriptionProvider(context)],
});

export default catalog;
