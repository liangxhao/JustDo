import { isRecord } from '../configShape';
import { normalizeNativeTtsConfig } from './nativeTtsConfig';

export const resolveManagedOpenClawTtsConfig = (
  existingConfig: Record<string, unknown> | null,
  localTtsConfig: Record<string, unknown> | null,
  outputState: { enabled: boolean; mode: 'local' | 'online' } = {
    enabled: true,
    mode: 'online',
  },
): Record<string, unknown> | null => {
  const existingTts = normalizeNativeTtsConfig(existingConfig?.tts);
  if (!outputState.enabled) return existingTts ? { ...existingTts, auto: 'off' } : null;
  if (outputState.mode === 'local') {
    if (!localTtsConfig) return existingTts ? { ...existingTts, auto: 'off' } : null;
    const localTts = normalizeNativeTtsConfig(localTtsConfig)!;
    const existingProviders = isRecord(existingTts?.providers) ? existingTts.providers : {};
    const localProviders = isRecord(localTts.providers) ? localTts.providers : {};
    return {
      ...(existingTts ?? {}),
      ...localTts,
      providers: { ...existingProviders, ...localProviders },
    };
  }
  if (!existingTts) return null;
  const currentProvider =
    typeof existingTts.provider === 'string' ? existingTts.provider.trim() : '';
  if (currentProvider === 'openai') {
    return existingTts;
  }
  const providers = isRecord(existingTts.providers) ? existingTts.providers : {};
  const onlineProvider = isRecord(providers.openai) ? 'openai' : undefined;
  return onlineProvider
    ? { ...existingTts, provider: onlineProvider }
    : { ...existingTts, auto: 'off' };
};

export const MANAGED_TTS_PLUGIN_IDS = new Set(['openai']);

export const buildManagedOpenClawTtsPluginEntries = (
  ttsConfig: Record<string, unknown> | null,
): Record<string, { enabled: true }> => {
  const provider = typeof ttsConfig?.provider === 'string' ? ttsConfig.provider.trim() : '';
  return provider && MANAGED_TTS_PLUGIN_IDS.has(provider) ? { [provider]: { enabled: true } } : {};
};

export const buildManagedOnlineAsrPluginEntries = (
  existingPlugins: Record<string, unknown>,
): Record<string, Record<string, unknown>> => {
  const entries = isRecord(existingPlugins.entries) ? existingPlugins.entries : {};
  const voiceCall = isRecord(entries['voice-call']) ? entries['voice-call'] : null;
  const config = voiceCall && isRecord(voiceCall.config) ? voiceCall.config : null;
  const streaming = config && isRecord(config.streaming) ? config.streaming : null;
  const provider = typeof streaming?.provider === 'string' ? streaming.provider.trim() : '';
  const providers = isRecord(streaming?.providers) ? streaming.providers : null;
  return provider && providers && isRecord(providers[provider]) ? { 'voice-call': voiceCall! } : {};
};
