import { openAIRealtimeHost } from './realtime-host.js';
import { buildOpenAIRealtimeVoiceProvider as createProvider } from './realtime-voice-provider-factory.js';

export function buildOpenAIRealtimeVoiceProvider() {
  return createProvider(openAIRealtimeHost);
}
