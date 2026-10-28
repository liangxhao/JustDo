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
