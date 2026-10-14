import type {
  OpenClawPluginApi,
  RealtimeTranscriptionProviderPlugin,
} from 'openclaw/plugin-sdk/core';
import type { PluginCapabilityCatalogHostContext } from 'openclaw/plugin-sdk/plugin-entry';

import { OpenAiCompatibleMediaConfigProviderIds } from '../../src/shared/providers/mediaGenerationModels';

type ImageProvider = Parameters<OpenClawPluginApi['registerImageGenerationProvider']>[0];
type TranscriptionEntry = Parameters<OpenClawPluginApi['registerRealtimeTranscriptionProvider']>[0];
type OpenClawConfig = Parameters<ImageProvider['generateImage']>[0]['cfg'];

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const transcriptionBaseUrl = (config: Record<string, unknown>): string | undefined => {
  const raw = asRecord(asRecord(config.providers)?.openai) ?? asRecord(config.openai) ?? config;
  return typeof raw.baseUrl === 'string' ? raw.baseUrl.trim() || undefined : undefined;
};

export const resolveTranscriptionUrl = (baseUrl: string): string => {
  const url = new URL(baseUrl);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = pathname.endsWith('/realtime') ? pathname : `${pathname}/realtime`;
  url.searchParams.set('intent', 'transcription');
  return url.toString();
};

const imageConfig = (cfg: OpenClawConfig | undefined): OpenClawConfig => {
  const providers = { ...cfg?.models?.providers };
  delete providers.openai;
  const isolated = providers[OpenAiCompatibleMediaConfigProviderIds.image];
  if (isolated) providers.openai = isolated;
  return { ...cfg, models: { ...cfg?.models, providers } };
};

/** Retain native image generation and admission, with a request-local credential view. */
export const isolateImageProvider = (provider: ImageProvider): ImageProvider => ({
  ...provider,
  isConfigured: ctx =>
    Boolean(ctx.cfg?.models?.providers?.[OpenAiCompatibleMediaConfigProviderIds.image]) &&
    (provider.isConfigured?.({ ...ctx, cfg: imageConfig(ctx.cfg) }) ?? false),
  generateImage: req => provider.generateImage({ ...req, cfg: imageConfig(req.cfg) }),
});

/** Scope transport overrides to one session; concurrent endpoints never share mutable state. */
export const configureTranscriptionProvider = (
  entry: TranscriptionEntry,
): ((context: PluginCapabilityCatalogHostContext) => RealtimeTranscriptionProviderPlugin) => {
  if (typeof entry !== 'function')
    throw new Error('Native OpenAI transcription factory is required');
  return context => {
    const provider = entry(context);
    return {
      ...provider,
      resolveConfig: ctx => ({
        ...provider.resolveConfig?.(ctx),
        ...(transcriptionBaseUrl(ctx.rawConfig)
          ? { baseUrl: transcriptionBaseUrl(ctx.rawConfig) }
          : {}),
      }),
      createSession: req => {
        const baseUrl = transcriptionBaseUrl(req.providerConfig);
        if (!baseUrl) return provider.createSession(req);
        const url = resolveTranscriptionUrl(baseUrl);
        const sessionContext: PluginCapabilityCatalogHostContext = {
          ...context,
          createRealtimeTranscriptionWebSocketSession: options =>
            context.createRealtimeTranscriptionWebSocketSession({ ...options, url }),
          resolveProviderRequestHeaders: options =>
            context.resolveProviderRequestHeaders({
              ...options,
              ...(options.capability === 'audio' && options.transport === 'websocket'
                ? { baseUrl: url }
                : {}),
            }),
        };
        return entry(sessionContext).createSession(req);
      },
    } satisfies RealtimeTranscriptionProviderPlugin;
  };
};

/** Compose native registration once, keeping all other OpenAI capabilities untouched. */
export const withMediaAdapters = (api: OpenClawPluginApi): OpenClawPluginApi => ({
  ...api,
  registerImageGenerationProvider: provider =>
    api.registerImageGenerationProvider(isolateImageProvider(provider)),
  registerRealtimeTranscriptionProvider: provider =>
    api.registerRealtimeTranscriptionProvider(configureTranscriptionProvider(provider)),
});
