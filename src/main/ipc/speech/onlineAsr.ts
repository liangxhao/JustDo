import { ipcMain, type WebContents } from 'electron';

import { OpenClawExtensionId } from '../../../shared/plugins/nativeIds';
import {
  type OnlineAsrConfiguration,
  type OnlineAsrConfigurationUpdate,
  type OnlineAsrEvent,
  OnlineAsrIpc,
  type OnlineAsrSession,
  type OnlineAsrStartOptions,
  type OnlineAsrStatus,
} from '../../../shared/speech/onlineAsr';
import {
  getOnlineSpeechModelOptions,
  resolveOnlineSpeechModel,
} from '../../../shared/speech/onlineSpeechModels';
import type { GatewayEventFrame } from '../../engine/gateway/types';
import type { OpenClawRuntimeAdapter } from '../../engine/openclaw/openclawRuntimeAdapter';
import { buildSpeechCredentialSlot } from '../../openclaw/config/speech/speechCredentialSlot';
import {
  EXTENSION_SECRET_PROVIDER,
  saveExtensionSecrets,
} from '../../plugins/extensions/extensionSecretFile';

interface Dependencies {
  getRuntime: () => OpenClawRuntimeAdapter | null;
  getModelCategory: () => unknown;
  getStateDir: () => string;
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
const MAX_BASE_URL_LENGTH = 2_048;
const MAX_MODEL_ID_LENGTH = 256;
const MAX_API_KEY_LENGTH = 16_384;
const SUPPORTED_ONLINE_ASR_PROVIDER_IDS = new Set<string>([OpenClawExtensionId.OPENAI]);

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

const readTranscriptionProfile = (config: unknown): Record<string, unknown> => {
  if (!isRecord(config) || !isRecord(config.plugins)) return {};
  const entries = isRecord(config.plugins.entries) ? config.plugins.entries : {};
  const entry = entries[OpenClawExtensionId.OPENAI];
  const openai = isRecord(entry) ? entry : {};
  const pluginConfig = isRecord(openai.config) ? openai.config : {};
  return isRecord(pluginConfig.transcription) ? pluginConfig.transcription : {};
};

const hasExplicitProfile = (profile: Record<string, unknown>): boolean => {
  if (
    typeof profile.baseUrl !== 'string' ||
    profile.baseUrl.length > MAX_BASE_URL_LENGTH ||
    typeof profile.model !== 'string' ||
    !profile.model.trim() ||
    profile.model.length > MAX_MODEL_ID_LENGTH ||
    /[\r\n\0]/.test(profile.model)
  )
    return false;
  try {
    const url = new URL(profile.baseUrl.trim());
    return (
      ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
};

const hasExplicitIntranetConfiguration = (
  catalog: TalkCatalog,
  config: unknown,
): { ready: boolean; provider?: string } => {
  const profile = readTranscriptionProfile(config);
  const configured = hasExplicitProfile(profile);
  return {
    ready:
      configured &&
      parseProviders(catalog).some(
        provider => provider.id === OpenClawExtensionId.OPENAI && provider.configured,
      ),
    ...(configured ? { provider: OpenClawExtensionId.OPENAI } : {}),
  };
};

export function registerOnlineAsrHandlers({
  getRuntime,
  getModelCategory,
  getStateDir,
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

  ipcMain.handle(OnlineAsrIpc.GetConfiguration, async (): Promise<OnlineAsrConfiguration> => {
    try {
      attachRuntime();
      const [catalog, snapshot] = await Promise.all([
        requestGateway<TalkCatalog>('talk.catalog', {}),
        requestGateway<{ config?: unknown }>('config.get'),
      ]);
      const providers = parseProviders(catalog);
      const profile = readTranscriptionProfile(snapshot.config);
      const readiness = hasExplicitIntranetConfiguration(catalog, snapshot.config);
      return {
        available: readiness.ready,
        providers,
        ...(readiness.provider ? { provider: readiness.provider } : {}),
        ...(providers.length ? { selectedProvider: OpenClawExtensionId.OPENAI } : {}),
        ...(typeof profile.baseUrl === 'string' ? { baseUrl: profile.baseUrl } : {}),
        ...(typeof profile.model === 'string' ? { model: profile.model } : {}),
        credentialConfigured: Boolean(profile.apiKey),
      };
    } catch (error) {
      return {
        available: false,
        providers: [],
        credentialConfigured: false,
        error: error instanceof Error ? error.name : 'GatewayError',
      };
    }
  });

  ipcMain.handle(
    OnlineAsrIpc.SaveConfiguration,
    async (_event, update: OnlineAsrConfigurationUpdate): Promise<void> => {
      attachRuntime();
      if (
        !update ||
        typeof update.modelRef !== 'string' ||
        !update.modelRef.trim() ||
        update.modelRef.length > 512 ||
        Object.keys(update).some(key => key !== 'modelRef')
      )
        throw new Error('Invalid online transcription configuration.');
      const mutate = async (): Promise<void> => {
        const category = getModelCategory();
        const reference = update.modelRef.trim();
        if (!getOnlineSpeechModelOptions(category).some(option => option.value === reference))
          throw new Error('The selected online transcription model is unavailable.');
        const selection = resolveOnlineSpeechModel(category, reference);
        if (!selection) throw new Error('The selected online transcription model is unavailable.');
        const profile = {
          baseUrl: selection.provider.baseUrl.trim(),
          model: selection.model.id,
        };
        const apiKey = selection.provider.apiKey.trim();
        if (
          !hasExplicitProfile(profile) ||
          apiKey.length > MAX_API_KEY_LENGTH ||
          /[\r\n\0]/.test(selection.provider.apiKey)
        )
          throw new Error('Invalid online transcription configuration.');
        const catalog = await requestGateway<TalkCatalog>('talk.catalog', {});
        if (!parseProviders(catalog).length)
          throw new Error('Unknown online transcription provider.');
        const snapshot = await requestGateway<{ hash?: unknown; config?: unknown }>('config.get');
        if (typeof snapshot.hash !== 'string' || !snapshot.hash)
          throw new Error('Online transcription configuration is unavailable.');
        const nativeConfig = isRecord(snapshot.config) ? snapshot.config : {};
        const slot = buildSpeechCredentialSlot('composerAsr', profile.baseUrl, apiKey);
        const references: Record<string, Record<string, string>> = apiKey
          ? saveExtensionSecrets(nativeConfig, getStateDir(), OpenClawExtensionId.OPENAI, {
              [slot]: apiKey,
            }).references
          : {};
        const secrets = isRecord(nativeConfig.secrets) ? nativeConfig.secrets : {};
        const secretProviders = isRecord(secrets.providers) ? secrets.providers : {};
        await requestGateway('config.patch', {
          raw: JSON.stringify({
            ...(apiKey
              ? {
                  secrets: {
                    providers: {
                      [EXTENSION_SECRET_PROVIDER]: secretProviders[EXTENSION_SECRET_PROVIDER],
                    },
                  },
                }
              : {}),
            plugins: {
              entries: {
                [OpenClawExtensionId.OPENAI]: {
                  enabled: true,
                  config: { transcription: { ...profile, apiKey: references[slot] ?? '' } },
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
      if (typeof snapshot.hash !== 'string' || !snapshot.hash)
        throw new Error('Online transcription configuration is unavailable.');
      await requestGateway('config.patch', {
        raw: JSON.stringify({
          plugins: {
            entries: { [OpenClawExtensionId.OPENAI]: { config: { transcription: null } } },
          },
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
        provider: OpenClawExtensionId.OPENAI,
        model: readTranscriptionProfile(snapshot.config).model,
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

  ipcMain.handle(
    OnlineAsrIpc.AppendAudio,
    async (event, sessionId: unknown, audioBase64: unknown) => {
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
    },
  );

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
