import { ipcMain, type WebContents } from 'electron';

import {
  type OnlineAsrConfiguration,
  type OnlineAsrConfigurationUpdate,
  type OnlineAsrEvent,
  OnlineAsrIpc,
  type OnlineAsrSession,
  type OnlineAsrStartOptions,
  type OnlineAsrStatus,
} from '../../../shared/speech/onlineAsr';
import type { GatewayEventFrame } from '../../engine/gateway/types';
import type { OpenClawRuntimeAdapter } from '../../engine/openclaw/openclawRuntimeAdapter';

interface Dependencies {
  getRuntime: () => OpenClawRuntimeAdapter | null;
  requestGateway: <T>(method: string, params?: unknown) => Promise<T>;
  runConfigMutationExclusive?: <T>(operation: () => Promise<T>) => Promise<T>;
}

interface OwnedSession {
  owner: WebContents;
  sessionId: string;
  transcriptionSessionId: string;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

const CLOSED_SESSION_EVENT_TTL_MS = 10_000;
const MAX_AUDIO_BASE64_LENGTH = 700_000;
const MAX_PROVIDER_ID_LENGTH = 64;
const MAX_BASE_URL_LENGTH = 2_048;
const MAX_MODEL_ID_LENGTH = 256;
const MAX_API_KEY_LENGTH = 16_384;
const SUPPORTED_ONLINE_ASR_PROVIDER_IDS = new Set(['openai']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

type TalkCatalog = {
  transcription?: {
    ready?: unknown;
    activeProvider?: unknown;
    providers?: unknown;
  };
};

const parseProviders = (catalog: TalkCatalog): OnlineAsrConfiguration['providers'] => {
  const catalogProviders = Array.isArray(catalog.transcription?.providers)
    ? catalog.transcription.providers
    : [];
  const discovered = catalogProviders.flatMap(value => {
    if (
      !isRecord(value) ||
      typeof value.id !== 'string' ||
      !SUPPORTED_ONLINE_ASR_PROVIDER_IDS.has(value.id)
    ) {
      return [];
    }
    return [
      {
        id: value.id,
        label: typeof value.label === 'string' ? value.label : value.id,
        configured: value.configured === true,
      },
    ];
  });
  return [...new Map(discovered.map(provider => [provider.id, provider])).values()];
};

const readStreamingConfig = (config: unknown): Record<string, unknown> => {
  if (!isRecord(config) || !isRecord(config.plugins)) return {};
  const entries = isRecord(config.plugins.entries) ? config.plugins.entries : {};
  const voiceCall = isRecord(entries['voice-call']) ? entries['voice-call'] : {};
  const pluginConfig = isRecord(voiceCall.config) ? voiceCall.config : {};
  return isRecord(pluginConfig.streaming) ? pluginConfig.streaming : {};
};

const hasExplicitIntranetConfiguration = (
  catalog: TalkCatalog,
  config: unknown,
): { ready: boolean; provider?: string } => {
  const streaming = readStreamingConfig(config);
  const provider =
    typeof streaming.provider === 'string' && SUPPORTED_ONLINE_ASR_PROVIDER_IDS.has(streaming.provider)
      ? streaming.provider
      : undefined;
  const providerConfigs = isRecord(streaming.providers) ? streaming.providers : {};
  const providerConfig = provider && isRecord(providerConfigs[provider]) ? providerConfigs[provider] : {};
  return {
    ready:
      catalog.transcription?.ready === true &&
      SUPPORTED_ONLINE_ASR_PROVIDER_IDS.has(provider ?? '') &&
      catalog.transcription.activeProvider === provider &&
      typeof providerConfig.baseUrl === 'string' &&
      Boolean(providerConfig.baseUrl.trim()) &&
      typeof providerConfig.model === 'string' &&
      Boolean(providerConfig.model.trim()),
    ...(provider ? { provider } : {}),
  };
};

export function registerOnlineAsrHandlers({
  getRuntime,
  requestGateway,
  runConfigMutationExclusive,
}: Dependencies): void {
  const sessions = new Map<string, OwnedSession>();
  const attachedRuntimes = new WeakSet<OpenClawRuntimeAdapter>();

  const forgetSession = (session: OwnedSession): void => {
    if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
    if (sessions.get(session.sessionId) === session) sessions.delete(session.sessionId);
  };

  const handleGatewayEvent = (frame: GatewayEventFrame): void => {
    if (frame.event !== 'talk.event' || !isRecord(frame.payload)) return;
    const transcriptionSessionId = frame.payload.transcriptionSessionId;
    if (typeof transcriptionSessionId !== 'string') return;
    const session = [...sessions.values()].find(
      candidate => candidate.transcriptionSessionId === transcriptionSessionId,
    );
    if (!session) return;
    if (session.owner.isDestroyed()) {
      forgetSession(session);
      return;
    }
    const type = frame.payload.type;
    if (
      type !== 'ready' &&
      type !== 'inputAudio' &&
      type !== 'partial' &&
      type !== 'transcript' &&
      type !== 'speechStart' &&
      type !== 'error' &&
      type !== 'close'
    ) {
      return;
    }
    const event: OnlineAsrEvent = {
      transcriptionSessionId,
      type,
      ...(typeof frame.payload.text === 'string' ? { text: frame.payload.text } : {}),
      ...(frame.payload.final === true ? { final: true } : {}),
      ...(typeof frame.payload.message === 'string' ? { message: frame.payload.message } : {}),
      ...(frame.payload.reason === 'completed' || frame.payload.reason === 'error'
        ? { reason: frame.payload.reason }
        : {}),
    };
    session.owner.send(OnlineAsrIpc.Event, event);
    if (type === 'close') forgetSession(session);
  };

  const attachRuntime = (): OpenClawRuntimeAdapter => {
    const runtime = getRuntime();
    if (!runtime) throw new Error('OpenClaw Gateway is unavailable.');
    if (!attachedRuntimes.has(runtime)) {
      attachedRuntimes.add(runtime);
      runtime.on('gatewayEvent', handleGatewayEvent);
    }
    return runtime;
  };

  ipcMain.handle(OnlineAsrIpc.GetStatus, async (): Promise<OnlineAsrStatus> => {
    try {
      attachRuntime();
      const [catalog, snapshot] = await Promise.all([
        requestGateway<TalkCatalog>('talk.catalog', {}),
        requestGateway<{ config?: unknown }>('config.get'),
      ]);
      const readiness = hasExplicitIntranetConfiguration(catalog, snapshot.config);
      return {
        available: readiness.ready,
        ...(readiness.provider ? { provider: readiness.provider } : {}),
      };
    } catch (error) {
      return {
        available: false,
        error: error instanceof Error ? error.name : 'GatewayError',
      };
    }
  });

  ipcMain.handle(
    OnlineAsrIpc.GetConfiguration,
    async (): Promise<OnlineAsrConfiguration> => {
      try {
        attachRuntime();
        const [catalog, snapshot] = await Promise.all([
          requestGateway<TalkCatalog>('talk.catalog', {}),
          requestGateway<{ config?: unknown }>('config.get'),
        ]);
        const providers = parseProviders(catalog);
        const streaming = readStreamingConfig(snapshot.config);
        const configuredProvider =
          typeof streaming.provider === 'string'
            ? streaming.provider
            : typeof catalog.transcription?.activeProvider === 'string'
              ? catalog.transcription.activeProvider
              : undefined;
        const selectedProvider = providers.some(provider => provider.id === configuredProvider)
          ? configuredProvider
          : providers[0]?.id;
        const providerConfigs = isRecord(streaming.providers) ? streaming.providers : {};
        const selectedConfig =
          selectedProvider && isRecord(providerConfigs[selectedProvider])
            ? providerConfigs[selectedProvider]
            : {};
        const selectedCatalogProvider = providers.find(provider => provider.id === selectedProvider);
        const readiness = hasExplicitIntranetConfiguration(catalog, snapshot.config);
        return {
          available: readiness.ready,
          providers,
          ...(typeof catalog.transcription?.activeProvider === 'string' &&
            SUPPORTED_ONLINE_ASR_PROVIDER_IDS.has(catalog.transcription.activeProvider)
            ? { provider: catalog.transcription.activeProvider }
            : {}),
          ...(selectedProvider ? { selectedProvider } : {}),
          ...(typeof selectedConfig.baseUrl === 'string'
            ? { baseUrl: selectedConfig.baseUrl }
            : {}),
          ...(typeof selectedConfig.model === 'string' ? { model: selectedConfig.model } : {}),
          credentialConfigured: selectedCatalogProvider?.configured === true,
        };
      } catch (error) {
        return {
          available: false,
          providers: [],
          credentialConfigured: false,
          error: error instanceof Error ? error.name : 'GatewayError',
        };
      }
    },
  );

  ipcMain.handle(
    OnlineAsrIpc.SaveConfiguration,
    async (_event, update: OnlineAsrConfigurationUpdate): Promise<void> => {
      attachRuntime();
      const provider = typeof update?.provider === 'string' ? update.provider.trim() : '';
      const baseUrl = typeof update?.baseUrl === 'string' ? update.baseUrl.trim() : '';
      const apiKey = typeof update?.apiKey === 'string' ? update.apiKey.trim() : '';
      const model = typeof update?.model === 'string' ? update.model.trim() : '';
      let parsedBaseUrl: URL;
      try {
        parsedBaseUrl = new URL(baseUrl);
      } catch {
        throw new Error('Invalid online transcription service URL.');
      }
      if (
        !SUPPORTED_ONLINE_ASR_PROVIDER_IDS.has(provider) ||
        provider.length > MAX_PROVIDER_ID_LENGTH ||
        !/^[a-z][a-z0-9_-]*$/.test(provider) ||
        !baseUrl ||
        baseUrl.length > MAX_BASE_URL_LENGTH ||
        !['http:', 'https:', 'ws:', 'wss:'].includes(parsedBaseUrl.protocol) ||
        Boolean(parsedBaseUrl.username || parsedBaseUrl.password) ||
        apiKey.length > MAX_API_KEY_LENGTH ||
        !model ||
        model.length > MAX_MODEL_ID_LENGTH
      ) {
        throw new Error('Invalid online transcription configuration.');
      }
      const catalog = await requestGateway<TalkCatalog>('talk.catalog', {});
      const selectedProvider = parseProviders(catalog).find(candidate => candidate.id === provider);
      if (!selectedProvider) {
        throw new Error('Unknown online transcription provider.');
      }
      if (!apiKey && !selectedProvider.configured) {
        throw new Error('Online transcription API key is required.');
      }
      const mutate = async (): Promise<void> => {
      const snapshot = await requestGateway<{ hash?: unknown; config?: unknown }>('config.get');
      if (typeof snapshot.hash !== 'string' || !snapshot.hash) {
        throw new Error('Online transcription configuration is unavailable.');
      }
      const existingStreaming = readStreamingConfig(snapshot.config);
      const existingProvider =
        typeof existingStreaming.provider === 'string' ? existingStreaming.provider : '';
      const existingProviders = isRecord(existingStreaming.providers)
        ? existingStreaming.providers
        : {};
      const existingProviderConfig = isRecord(existingProviders[provider])
        ? existingProviders[provider]
        : {};
      const existingBaseUrl =
        typeof existingProviderConfig.baseUrl === 'string'
          ? existingProviderConfig.baseUrl.trim()
          : '';
      if (!apiKey && (existingProvider !== provider || existingBaseUrl !== baseUrl)) {
        throw new Error('Online transcription API key is required when changing the service URL.');
      }
      const providerConfig = {
        baseUrl,
        ...(apiKey ? { apiKey } : {}),
        model,
      };
      await requestGateway('config.patch', {
        raw: JSON.stringify({
          plugins: {
            entries: {
              [provider]: { enabled: true },
              'voice-call': {
                config: {
                  streaming: {
                    provider,
                    providers: { [provider]: providerConfig },
                  },
                },
              },
            },
          },
        }),
        baseHash: snapshot.hash,
      });
      };
      await (runConfigMutationExclusive ? runConfigMutationExclusive(mutate) : mutate());
    },
  );

  ipcMain.handle(OnlineAsrIpc.ClearConfiguration, async (): Promise<void> => {
    attachRuntime();
    const mutate = async (): Promise<void> => {
    const snapshot = await requestGateway<{ hash?: unknown }>('config.get');
    if (typeof snapshot.hash !== 'string' || !snapshot.hash) {
      throw new Error('Online transcription configuration is unavailable.');
    }
    await requestGateway('config.patch', {
      raw: JSON.stringify({
        plugins: { entries: { 'voice-call': { config: { streaming: null } } } },
      }),
      baseHash: snapshot.hash,
    });
    };
    await (runConfigMutationExclusive ? runConfigMutationExclusive(mutate) : mutate());
  });

  ipcMain.handle(
    OnlineAsrIpc.Start,
    async (event, options: OnlineAsrStartOptions): Promise<OnlineAsrSession> => {
      attachRuntime();
      if ([...sessions.values()].some(session => session.owner === event.sender)) {
        throw new Error('An online transcription session is already active.');
      }
      const [catalog, snapshot] = await Promise.all([
        requestGateway<TalkCatalog>('talk.catalog', {}),
        requestGateway<{ config?: unknown }>('config.get'),
      ]);
      if (!hasExplicitIntranetConfiguration(catalog, snapshot.config).ready) {
        throw new Error('Online transcription service is not configured for intranet use.');
      }
      const language = options?.language;
      if (!['auto', 'zh', 'en', 'ja', 'ko'].includes(language)) {
        throw new Error('Invalid online transcription language.');
      }
      const result = await requestGateway<Record<string, unknown>>('talk.session.create', {
        mode: 'transcription',
        transport: 'gateway-relay',
        brain: 'none',
        ...(language !== 'auto' ? { language } : {}),
      });
      const audio = isRecord(result.audio) ? result.audio : {};
      if (
        typeof result.sessionId !== 'string' ||
        audio.inputEncoding !== 'g711_ulaw' ||
        audio.inputSampleRateHz !== 8000
      ) {
        if (typeof result.sessionId === 'string') {
          void requestGateway('talk.session.close', { sessionId: result.sessionId }).catch(
            (): void => {},
          );
        }
        throw new Error('OpenClaw returned an unsupported transcription audio format.');
      }
      const transcriptionSessionId =
        typeof result.transcriptionSessionId === 'string'
          ? result.transcriptionSessionId
          : result.sessionId;
      if ([...sessions.values()].some(candidate => candidate.owner === event.sender)) {
        void requestGateway('talk.session.close', { sessionId: result.sessionId }).catch(
          (): void => {},
        );
        throw new Error('An online transcription session is already active.');
      }
      const session: OwnedSession = {
        owner: event.sender,
        sessionId: result.sessionId,
        transcriptionSessionId,
      };
      sessions.set(session.sessionId, session);
      event.sender.once('destroyed', () => {
        if (sessions.get(session.sessionId) !== session) return;
        forgetSession(session);
        void requestGateway('talk.session.close', { sessionId: session.sessionId }).catch(
          (): void => {},
        );
      });
      return {
        sessionId: session.sessionId,
        transcriptionSessionId,
        ...(typeof result.provider === 'string' ? { provider: result.provider } : {}),
        inputEncoding: 'g711_ulaw',
        inputSampleRateHz: 8000,
      };
    },
  );

  ipcMain.handle(OnlineAsrIpc.AppendAudio, async (event, sessionId: unknown, audioBase64: unknown) => {
    const session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
    if (
      !session ||
      session.owner !== event.sender ||
      typeof audioBase64 !== 'string' ||
      !audioBase64 ||
      audioBase64.length > MAX_AUDIO_BASE64_LENGTH
    ) {
      throw new Error('Invalid online transcription audio request.');
    }
    await requestGateway('talk.session.appendAudio', { sessionId, audioBase64 });
  });

  ipcMain.handle(OnlineAsrIpc.Close, async (event, sessionId: unknown) => {
    const session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
    if (!session || session.owner !== event.sender) return;
    try {
      await requestGateway('talk.session.close', { sessionId });
    } finally {
      session.cleanupTimer = setTimeout(() => forgetSession(session), CLOSED_SESSION_EVENT_TTL_MS);
    }
  });
}
