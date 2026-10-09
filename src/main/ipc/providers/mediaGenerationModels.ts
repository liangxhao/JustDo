import { ipcMain } from 'electron';

import {
  type MediaGenerationModelConfiguration,
  type MediaGenerationModelConfigurationResult,
  type MediaGenerationModelKind,
  MediaGenerationModelsIpc,
  OpenAiCompatibleMediaConfigProviderIds,
} from '../../../shared/providers/mediaGenerationModels';
import { t } from '../../core/i18n';
import type { OpenClawRuntimeAdapter } from '../../engine/openclaw/openclawRuntimeAdapter';

interface Dependencies {
  getRuntime: () => OpenClawRuntimeAdapter | null;
  requestGateway: <T>(method: string, params?: unknown) => Promise<T>;
  runConfigMutationExclusive?: <T>(operation: () => Promise<T>) => Promise<T>;
}

const MAX_MODEL_REF_LENGTH = 512;
const MAX_FALLBACKS = 16;
const MAX_TIMEOUT_MS = 3_600_000;
const MAX_BASE_URL_LENGTH = 2_048;
const MAX_API_KEY_LENGTH = 16_384;
const UNSUPPORTED_VIDEO_IPC_PROVIDER_IDS = new Set<string>([
  'openai',
  'justdo-video-openai',
  OpenAiCompatibleMediaConfigProviderIds.video,
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const isKind = (value: unknown): value is MediaGenerationModelKind =>
  value === 'image' || value === 'video' || value === 'music';

const readConfiguration = (
  config: unknown,
  kind: MediaGenerationModelKind,
): MediaGenerationModelConfiguration => {
  if (!isRecord(config) || !isRecord(config.agents) || !isRecord(config.agents.defaults)) {
    return { primary: '', fallbacks: [] };
  }
  const mediaModels = isRecord(config.agents.defaults.mediaModels)
    ? config.agents.defaults.mediaModels
    : {};
  const value = mediaModels[kind];
  if (typeof value === 'string') return { primary: value, fallbacks: [] };
  if (!isRecord(value)) return { primary: '', fallbacks: [] };
  return {
    primary: typeof value.primary === 'string' ? value.primary : '',
    fallbacks: Array.isArray(value.fallbacks)
      ? value.fallbacks.filter((item): item is string => typeof item === 'string')
      : [],
    ...(typeof value.timeoutMs === 'number' && Number.isInteger(value.timeoutMs)
      ? { timeoutMs: value.timeoutMs }
      : {}),
  };
};

const validateConfiguration = (
  value: MediaGenerationModelConfiguration,
): MediaGenerationModelConfiguration | null => {
  const primary = typeof value?.primary === 'string' ? value.primary.trim() : '';
  const fallbacks = Array.isArray(value?.fallbacks)
    ? value.fallbacks.map(item => (typeof item === 'string' ? item.trim() : ''))
    : [];
  const timeoutMs = value?.timeoutMs;
  const baseUrl = typeof value?.baseUrl === 'string' ? value.baseUrl.trim() : '';
  const apiKey = typeof value?.apiKey === 'string' ? value.apiKey.trim() : '';
  if (!primary && fallbacks.length === 0) return null;
  const modelRefPattern = /^[a-z][a-z0-9_-]{0,63}\/.+$/;
  if (
    !primary ||
    primary.length > MAX_MODEL_REF_LENGTH ||
    !modelRefPattern.test(primary) ||
    fallbacks.length > MAX_FALLBACKS ||
    fallbacks.some(
      item => !item || item.length > MAX_MODEL_REF_LENGTH || !modelRefPattern.test(item),
    ) ||
    (timeoutMs !== undefined &&
      (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS))
  ) {
    throw new Error('Invalid media generation model configuration.');
  }
  if (baseUrl) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error('Invalid media generation provider URL.');
    }
    if (
      baseUrl.length > MAX_BASE_URL_LENGTH ||
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      apiKey.length > MAX_API_KEY_LENGTH
    ) {
      throw new Error('Invalid media generation provider configuration.');
    }
  }
  return {
    primary,
    fallbacks,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
  };
};

export function registerMediaGenerationModelHandlers({
  getRuntime,
  requestGateway,
  runConfigMutationExclusive,
}: Dependencies): void {
  const requireRuntime = (): void => {
    if (!getRuntime()) throw new Error('OpenClaw Gateway is unavailable.');
  };

  ipcMain.handle(
    MediaGenerationModelsIpc.GetConfiguration,
    async (
      _event,
      kind: MediaGenerationModelKind,
    ): Promise<MediaGenerationModelConfigurationResult> => {
      if (!isKind(kind)) throw new Error('Invalid media generation model kind.');
      try {
        requireRuntime();
        const snapshot = await requestGateway<{ config?: unknown }>('config.get');
        const configuration = readConfiguration(snapshot.config, kind);
        return { ...configuration, available: true };
      } catch (error) {
        return {
          primary: '',
          fallbacks: [],
          available: false,
          error: error instanceof Error ? error.name : 'GatewayError',
        };
      }
    },
  );

  ipcMain.handle(
    MediaGenerationModelsIpc.SaveConfiguration,
    async (
      _event,
      kind: MediaGenerationModelKind,
      value: MediaGenerationModelConfiguration,
    ): Promise<void> => {
      if (!isKind(kind)) throw new Error('Invalid media generation model kind.');
      requireRuntime();
      const configuration = validateConfiguration(value);
      if (
        kind === 'video' &&
        configuration &&
        (configuration.baseUrl ||
          configuration.apiKey ||
          [configuration.primary, ...configuration.fallbacks].some(reference =>
            UNSUPPORTED_VIDEO_IPC_PROVIDER_IDS.has(reference.split('/')[0]),
          ))
      ) {
        throw new Error(t('nativeVideoLegacyUnsupported'));
      }
      const mutate = async (): Promise<void> => {
        const snapshot = await requestGateway<{ hash?: unknown; config?: unknown }>('config.get');
        if (typeof snapshot.hash !== 'string' || !snapshot.hash) {
          throw new Error('Media generation model configuration is unavailable.');
        }
        const isolatedProviderId =
          kind === 'image' ? OpenAiCompatibleMediaConfigProviderIds[kind] : undefined;
        const mediaConfiguration = configuration
          ? {
              primary: configuration.primary,
              fallbacks: configuration.fallbacks,
              ...(configuration.timeoutMs === undefined
                ? {}
                : { timeoutMs: configuration.timeoutMs }),
            }
          : null;
        const isolatedProviderConfiguration =
          isolatedProviderId && configuration?.baseUrl
            ? {
                [isolatedProviderId]: {
                  baseUrl: configuration.baseUrl,
                  ...(configuration.apiKey ? { apiKey: configuration.apiKey } : {}),
                  api: 'openai-completions',
                  request: { allowPrivateNetwork: true },
                },
              }
            : isolatedProviderId && !configuration
              ? { [isolatedProviderId]: null }
              : undefined;
        await requestGateway('config.patch', {
          raw: JSON.stringify({
            agents: { defaults: { mediaModels: { [kind]: mediaConfiguration } } },
            ...(isolatedProviderConfiguration
              ? {
                  models: { providers: isolatedProviderConfiguration },
                  ...(configuration ? { plugins: { entries: { openai: { enabled: true } } } } : {}),
                }
              : {}),
          }),
          baseHash: snapshot.hash,
        });
      };
      await (runConfigMutationExclusive ? runConfigMutationExclusive(mutate) : mutate());
    },
  );
}
