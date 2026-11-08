import type { RealtimeVoiceProviderPlugin } from 'openclaw/plugin-sdk/realtime-voice';
import { REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ } from 'openclaw/plugin-sdk/realtime-voice-provider';
import { normalizeResolvedSecretInputString } from 'openclaw/plugin-sdk/secret-input';

import { normalizeSpeechServiceBaseUrl, SPEECH_PROTOCOL_IDS } from '../../sdk/speech-protocols/index.js';
import type { OpenAIRealtimeHost } from './realtime-host.js';
import { OpenAIRealtimeBridge } from './realtime-voice-bridge.js';

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const boundedId = (value: unknown): value is string =>
  typeof value === 'string' && Boolean(value.trim()) && value.length <= 256 &&
  !/[\u0000-\u001f\u007f]/.test(value);

export function resolveManagedRealtimeVoiceProfile(value: unknown) {
  if (!record(value) || value.protocolId !== SPEECH_PROTOCOL_IDS.VOICE_REALTIME ||
    Object.hasOwn(value, 'compatibilityProfile') || !boundedId(value.model) ||
    !boundedId(value.speakerVoice) || !boundedId(value.inputTranscriptionModel) ||
    typeof value.baseUrl !== 'string' || value.baseUrl.length > 2048 ||
    typeof value.apiKey !== 'string') return null;
  let endpoint: URL;
  try { endpoint = new URL(normalizeSpeechServiceBaseUrl(value.baseUrl,
    { protocolId: SPEECH_PROTOCOL_IDS.VOICE_REALTIME })); } catch { return null; }
  endpoint.protocol = endpoint.protocol.replace('http', 'ws');
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, '')}/realtime`;
  let apiKey: string;
  try {
    apiKey = normalizeResolvedSecretInputString({
      value: value.apiKey,
      path: 'plugins.entries.openai.config.realtimeVoice.apiKey',
    }) ?? '';
  } catch { return null; }
  if (apiKey.length > 16384 || /[\r\n\0]/.test(apiKey)) return null;
  return {
    protocolId: SPEECH_PROTOCOL_IDS.VOICE_REALTIME,
    baseUrl: endpoint.toString(),
    model: value.model.trim(),
    speakerVoice: value.speakerVoice.trim(),
    inputTranscriptionModel: value.inputTranscriptionModel.trim(),
    apiKey,
  };
}

/** Only the application-owned profile is authoritative, including explicit withdrawal. */
export function buildManagedRealtimeVoiceProvider(host: OpenAIRealtimeHost): RealtimeVoiceProviderPlugin {
  return {
    id: 'openai',
    label: 'OpenAI compatible realtime voice',
    capabilities: {
      transports: ['gateway-relay'],
      inputAudioFormats: [REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ],
      outputAudioFormats: [REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ],
      supportsBargeIn: true,
      handlesInputAudioBargeIn: true,
      supportsToolCalls: true,
      supportsBrowserSession: false,
      supportsSessionResumption: false,
    },
    resolveConfig: ({ cfg }) => {
      const plugin = cfg.plugins?.entries?.openai?.config;
      const profile = resolveManagedRealtimeVoiceProfile(plugin?.realtimeVoice);
      return profile ?? {};
    },
    isConfigured: ({ providerConfig }) => Boolean(resolveManagedRealtimeVoiceProfile(providerConfig)),
    createBridge: req => {
      const profile = resolveManagedRealtimeVoiceProfile(req.providerConfig);
      if (!profile) throw new Error('Managed realtime voice is not configured');
      return new OpenAIRealtimeBridge({
        ...req,
        ...profile,
        managedEndpoint: true,
        voice: profile.speakerVoice,
        audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
        interruptResponseOnInputAudio: true,
        logger: { warn: () => undefined },
      }, host);
    },
  };
}
