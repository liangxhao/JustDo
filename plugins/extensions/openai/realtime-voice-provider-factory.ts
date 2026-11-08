import type { RealtimeVoiceProviderPlugin } from 'openclaw/plugin-sdk/realtime-voice';

import { buildManagedRealtimeVoiceProvider } from './managed-realtime-voice-provider.js';
import type { OpenAIRealtimeHost } from './realtime-host.js';

/** The public factory shares the same explicit profile and transport as native registration. */
export function buildOpenAIRealtimeVoiceProvider(host: OpenAIRealtimeHost): RealtimeVoiceProviderPlugin {
  return buildManagedRealtimeVoiceProvider(host);
}
