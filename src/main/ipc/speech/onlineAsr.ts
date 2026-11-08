import { createHash } from 'node:crypto';

import { ipcMain, type WebContents, type WebFrameMain } from 'electron';

import { SPEECH_PROTOCOL_IDS } from '../../../../plugins/sdk/speech-protocols';
import { OpenClawExtensionId } from '../../../shared/plugins/nativeIds';
import type { LocalSpeechSettings } from '../../../shared/speech/localSpeechSettings';
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
  resolveOnlineSpeechBinding,
} from '../../../shared/speech/onlineSpeechModels';
import type { GatewayClientLike, GatewayEventFrame } from '../../engine/gateway/types';
import type { OpenClawRuntimeAdapter } from '../../engine/openclaw/openclawRuntimeAdapter';
import { buildSpeechCredentialSlot } from '../../openclaw/config/speech/speechCredentialSlot';
import {
  EXTENSION_SECRET_PROVIDER,
  saveExtensionSecrets,
} from '../../plugins/extensions/extensionSecretFile';
import { resolveRecordedOnlineAsrProfile } from '../../speech/recordedOnlineAsrService';
import { getSpeechConfigurationRevision, onSpeechConfigurationChanged } from '../../speech/speechConfigurationRevision';

interface Dependencies {
  getRuntime: () => OpenClawRuntimeAdapter | null;
  getModelCategory: () => unknown;
  getSettings?: () => LocalSpeechSettings;
  getStateDir: () => string;
  requestGateway: <T>(method: string, params?: unknown) => Promise<T>;
  runConfigMutationExclusive?: <T>(operation: () => Promise<T>) => Promise<T>;
}

interface OwnedSession {
  owner: WebContents;
  frame: WebFrameMain;
  runtime: OpenClawRuntimeAdapter;
  client: GatewayClientLike;
  generation: number;
  revision: number;
  configurationKey: string;
  sessionId?: string;
  transcriptionSessionId?: string;
  cancelled: boolean;
  unknown: boolean;
  closing: boolean;
  closeSent: boolean;
  sending: boolean;
  detach: () => void;
  lastSequence?: number;
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
const validSessionIdentity = (value: unknown): value is string =>
  typeof value === 'string' && Boolean(value) && value === value.trim() &&
  value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);

type TalkCatalog = {
  transcription?: {
    ready?: unknown;
    activeProvider?: unknown;
    providers?: unknown;
  };
};
type RealtimeConfigSnapshot = {
  config?: unknown;
  configRevisionHash?: unknown;
  appliedConfigHash?: unknown;
};
const assertAppliedConfiguration = (snapshot: RealtimeConfigSnapshot): void => {
  if (typeof snapshot.configRevisionHash !== 'string' || !snapshot.configRevisionHash.trim() ||
    snapshot.appliedConfigHash !== snapshot.configRevisionHash)
    throw new Error('Online transcription settings have not finished applying.');
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
    /[\r\n\0]/.test(profile.model) ||
    (profile.protocolId !== undefined && profile.protocolId !== SPEECH_PROTOCOL_IDS.TRANSCRIPTION_REALTIME) ||
    Object.prototype.hasOwnProperty.call(profile, 'compatibilityProfile')
  )
    return false;
  try {
    const url = new URL(profile.baseUrl.trim());
    return (
      ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.hash && (!url.search || ([...url.searchParams.keys()].length === 1 && url.searchParams.get('intent') === 'transcription'))
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
  getSettings,
  getStateDir,
  requestGateway,
  runConfigMutationExclusive,
}: Dependencies): void {
  const sessions = new Map<string, OwnedSession>();
  const owners = new Map<WebContents, OwnedSession>();
  const attachedRuntimes = new WeakSet<OpenClawRuntimeAdapter>();
  const earlyLifecycle = new Map<string, { runtime: OpenClawRuntimeAdapter; generation: number; frame: GatewayEventFrame }>();

  const selectedInput = () => {
    const settings = getSettings?.();
    return settings?.inputEnabled && settings.recognitionMode === 'online'
      ? resolveOnlineSpeechBinding(getModelCategory(), settings.onlineAsrModelRef, settings.onlineAsrBindingId, 'composer-asr')
      : null;
  };
  const configurationKey = () => {
    const selected = selectedInput();
    return JSON.stringify(selected ? [selected.providerId, selected.model.id, selected.binding,
      selected.provider.baseUrl, selected.provider.apiKey] : null);
  };
  const connectionCurrent = (session: OwnedSession) => getRuntime() === session.runtime &&
    session.runtime.getGatewayClient() === session.client &&
    session.runtime.getGatewayClientGeneration() === session.generation;
  const current = (session: OwnedSession) => !session.cancelled && owners.get(session.owner) === session &&
    !session.owner.isDestroyed() && session.owner.mainFrame === session.frame && connectionCurrent(session) &&
    session.revision === getSpeechConfigurationRevision('input') && session.configurationKey === configurationKey();
  const profileMatches = (profile: Record<string, unknown>) => {
    if (!getSettings) return true; // Legacy integration callers have no product selection port.
    const selected = selectedInput();
    if (!selected || selected.binding.protocolId !== SPEECH_PROTOCOL_IDS.TRANSCRIPTION_REALTIME ||
      (profile.protocolId !== undefined && profile.protocolId !== SPEECH_PROTOCOL_IDS.TRANSCRIPTION_REALTIME) ||
      Object.prototype.hasOwnProperty.call(profile, 'compatibilityProfile') || profile.baseUrl !== selected.provider.baseUrl.trim() ||
      profile.model !== selected.model.id) return false;
    const apiKey = selected.provider.apiKey.trim();
    const slot = buildSpeechCredentialSlot('composerAsr', selected.provider.baseUrl.trim(), apiKey);
    if (profile.configurationId !== slot) return false;
    if (!apiKey) return profile.apiKey === '' || profile.apiKey === undefined;
    // Published credential identities bind both endpoint and key revision, without reading secret files.
    const id = createHash('sha256').update(JSON.stringify([OpenClawExtensionId.OPENAI, slot])).digest('hex');
    return profile.configurationId === slot && isRecord(profile.apiKey) && profile.apiKey.source === 'file' &&
      profile.apiKey.provider === EXTENSION_SECRET_PROVIDER &&
      (profile.apiKey.id === `/${id}` || profile.apiKey.id === '__OPENCLAW_REDACTED__');
  };

  const forgetSession = (session: OwnedSession): void => {
    if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
    session.detach();
    if (session.sessionId && sessions.get(session.sessionId) === session) sessions.delete(session.sessionId);
    if (owners.get(session.owner) === session) owners.delete(session.owner);
  };
  const revoke = (session: OwnedSession): void => {
    const canClose = connectionCurrent(session);
    session.cancelled = true;
    if (!session.sessionId) {
      if (!connectionCurrent(session) || session.owner.isDestroyed()) forgetSession(session);
      return; // A pending/unknown create retains its owner until exact evidence arrives.
    }
    if (owners.get(session.owner) === session && !session.owner.isDestroyed() && session.owner.mainFrame === session.frame)
      session.owner.send(OnlineAsrIpc.Event, { transcriptionSessionId: session.transcriptionSessionId, type: 'close', reason: 'error' });
    forgetSession(session);
    if (canClose && !session.closeSent) {
      session.closeSent = true;
      try { void session.client.request('talk.session.close', { sessionId: session.sessionId }, { timeoutMs: 5000 }).catch(() => {}); }
      catch { /* A retired captured client may synchronously reject requests. */ }
    }
  };
  const handleGatewayEvent = (runtime: OpenClawRuntimeAdapter, frame: GatewayEventFrame): void => {
    if (frame.event !== 'talk.event' || !isRecord(frame.payload)) return;
    const transcriptionSessionId = frame.payload.transcriptionSessionId;
    if (!validSessionIdentity(transcriptionSessionId)) return;
    const session = [...sessions.values()].find(
      candidate => candidate.transcriptionSessionId === transcriptionSessionId,
    );
    if (!session) {
      if (earlyLifecycle.size < 32 && ['ready', 'error', 'close'].includes(String(frame.payload.type)) &&
        [...owners.values()].some(pending => pending.runtime === runtime && !pending.sessionId && connectionCurrent(pending)))
        earlyLifecycle.set(transcriptionSessionId, { runtime, generation: runtime.getGatewayClientGeneration(),
          frame: { event: 'talk.event', seq: frame.seq, payload: { transcriptionSessionId, type: frame.payload.type, reason: frame.payload.reason } } });
      return;
    }
    if (session.runtime !== runtime) return;
    if (!current(session)) { revoke(session); return; }
    if (typeof frame.seq === 'number') {
      if (session.lastSequence !== undefined && frame.seq <= session.lastSequence) return;
      session.lastSequence = frame.seq;
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
      ...(typeof frame.payload.text === 'string' && frame.payload.text.length <= 256 * 1024 ? { text: frame.payload.text } : {}),
      ...(frame.payload.final === true ? { final: true } : {}),
      ...(type === 'error' ? { message: 'Online transcription failed.' } : {}),
      ...(frame.payload.reason === 'completed' || frame.payload.reason === 'error'
        ? { reason: frame.payload.reason }
        : {}),
    };
    session.owner.send(OnlineAsrIpc.Event, event);
    if (type === 'close') { session.closeSent = true; forgetSession(session); }
  };

  const attachRuntime = (): OpenClawRuntimeAdapter => {
    const runtime = getRuntime();
    if (!runtime) throw new Error('OpenClaw Gateway is unavailable.');
    if (!attachedRuntimes.has(runtime)) {
      attachedRuntimes.add(runtime);
      runtime.on('gatewayEvent', frame => handleGatewayEvent(runtime, frame));
    }
    return runtime;
  };

  const readRealtimeSnapshot = async () => {
    const runtime = attachRuntime();
    const client = runtime.getGatewayClient();
    const generation = runtime.getGatewayClientGeneration();
    const revision = getSpeechConfigurationRevision('input');
    const key = configurationKey();
    if (!client) throw new Error('OpenClaw Gateway is unavailable.');
    const [catalog, snapshot] = await Promise.all([
      client.request<TalkCatalog>('talk.catalog', {}, { timeoutMs: 5000 }),
      client.request<RealtimeConfigSnapshot>('config.get', {}, { timeoutMs: 5000 }),
    ]);
    if (getRuntime() !== runtime || runtime.getGatewayClient() !== client ||
      runtime.getGatewayClientGeneration() !== generation ||
      getSpeechConfigurationRevision('input') !== revision || configurationKey() !== key)
      throw new Error('Online transcription configuration or connection changed.');
    assertAppliedConfiguration(snapshot);
    return { catalog, snapshot };
  };

  ipcMain.handle(OnlineAsrIpc.GetStatus, async (): Promise<OnlineAsrStatus> => {
    try {
      const settings = getSettings?.();
      const recorded = settings ? resolveRecordedOnlineAsrProfile(settings, getModelCategory()) : null;
      if (recorded) return { available: true, inputMode: 'recording', provider: recorded.selection.protocolId };
      if (getSettings && selectedInput()?.binding.protocolId !== SPEECH_PROTOCOL_IDS.TRANSCRIPTION_REALTIME)
        return { available: false, error: 'UnconfiguredSpeechInterface' };
      const { catalog, snapshot } = await readRealtimeSnapshot();
      const readiness = hasExplicitIntranetConfiguration(catalog, snapshot.config);
      readiness.ready &&= profileMatches(readTranscriptionProfile(snapshot.config));
      return {
        available: readiness.ready,
        inputMode: 'realtime',
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
      const settings = getSettings?.();
      const recorded = settings ? resolveRecordedOnlineAsrProfile(settings, getModelCategory()) : null;
      if (recorded) return {
        available: true, inputMode: 'recording', provider: recorded.selection.protocolId,
        providers: [{ id: recorded.selection.protocolId, label: recorded.selection.protocolId, configured: true }],
        selectedProvider: recorded.selection.protocolId, baseUrl: recorded.baseUrl, model: recorded.model,
        credentialConfigured: Boolean(recorded.apiKey),
      };
      if (getSettings && selectedInput()?.binding.protocolId !== SPEECH_PROTOCOL_IDS.TRANSCRIPTION_REALTIME)
        return { available: false, providers: [], credentialConfigured: false, error: 'UnconfiguredSpeechInterface' };
      const { catalog, snapshot } = await readRealtimeSnapshot();
      const providers = parseProviders(catalog);
      const profile = readTranscriptionProfile(snapshot.config);
      const readiness = hasExplicitIntranetConfiguration(catalog, snapshot.config);
      readiness.ready &&= profileMatches(profile);
      return {
        available: readiness.ready,
        inputMode: 'realtime',
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
        (update.bindingId !== undefined && (typeof update.bindingId !== 'string' || update.bindingId.length > 64)) ||
        Object.keys(update).some(key => key !== 'modelRef' && key !== 'bindingId')
      )
        throw new Error('Invalid online transcription configuration.');
      const mutate = async (): Promise<void> => {
        const category = getModelCategory();
        const reference = update.modelRef.trim();
        if (!getOnlineSpeechModelOptions(category).some(option => option.value === reference))
          throw new Error('The selected online transcription model is unavailable.');
        const selection = resolveOnlineSpeechBinding(category, reference, update.bindingId ?? '', 'composer-asr');
        if (!selection || selection.binding.protocolId !== SPEECH_PROTOCOL_IDS.TRANSCRIPTION_REALTIME)
          throw new Error('The selected realtime transcription interface is unavailable.');
        const profile = {
          baseUrl: selection.provider.baseUrl.trim(),
          model: selection.model.id,
          protocolId: selection.binding.protocolId,
          configurationId: buildSpeechCredentialSlot('composerAsr', selection.provider.baseUrl.trim(), selection.provider.apiKey.trim()),
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
      const runtime = attachRuntime();
      const owner = event.sender;
      if (owner.isDestroyed() || owner.getType() !== 'window' || event.senderFrame !== owner.mainFrame)
        throw new Error('Online transcription requires an application window frame.');
      if (!options || Object.keys(options).some(key => key !== 'language') ||
        !['auto', 'zh', 'en', 'ja', 'ko'].includes(options.language))
        throw new Error('Invalid online transcription language.');
      if (getSettings && selectedInput()?.binding.protocolId !== SPEECH_PROTOCOL_IDS.TRANSCRIPTION_REALTIME)
        throw new Error('A realtime transcription interface is not configured.');
      const previous = owners.get(owner);
      if (previous && !connectionCurrent(previous)) forgetSession(previous);
      else if (previous) throw new Error('An online transcription session is already active or unresolved.');
      const client = runtime.getGatewayClient();
      if (!client) throw new Error('OpenClaw Gateway is unavailable.');
      const session: OwnedSession = {
        owner, frame: event.senderFrame!, runtime, client,
        generation: runtime.getGatewayClientGeneration(), revision: getSpeechConfigurationRevision('input'),
        configurationKey: configurationKey(), cancelled: false, unknown: false, closing: false, closeSent: false,
        sending: false, detach: () => {},
      };
      owners.set(owner, session);
      const cleanup = () => revoke(session);
      owner.once('destroyed', cleanup);
      owner.once('did-navigate', cleanup);
      owner.once('render-process-gone', cleanup);
      const unsubscribe = onSpeechConfigurationChanged('input', cleanup);
      session.detach = () => {
        unsubscribe();
        owner.removeListener('destroyed', cleanup);
        owner.removeListener('did-navigate', cleanup);
        owner.removeListener('render-process-gone', cleanup);
      };
      const assertCurrent = () => {
        if (!current(session)) throw new Error('Online transcription configuration or connection changed.');
      };
      let sent = false;
      const responseContext = runtime.captureGatewayResponseContext();
      try {
        const create = async () => {
          assertCurrent();
          const [catalog, snapshot] = await Promise.all([
            client.request<TalkCatalog>('talk.catalog', {}, { timeoutMs: 5000 }),
            client.request<RealtimeConfigSnapshot>('config.get', {}, { timeoutMs: 5000 }),
          ]);
          assertCurrent();
          assertAppliedConfiguration(snapshot);
          if (!hasExplicitIntranetConfiguration(catalog, snapshot.config).ready ||
            !profileMatches(readTranscriptionProfile(snapshot.config)))
            throw new Error('Online transcription service is not configured for intranet use.');
          sent = true;
          return client.request<Record<string, unknown>>('talk.session.create', {
            mode: 'transcription', provider: OpenClawExtensionId.OPENAI,
            model: readTranscriptionProfile(snapshot.config).model,
            transport: 'gateway-relay', brain: 'none',
            ...(options.language !== 'auto' ? { language: options.language } : {}),
          }, { timeoutMs: 15_000 });
        };
        const result = await (runConfigMutationExclusive ? runConfigMutationExclusive(create) : create());
        if (!validSessionIdentity(result.sessionId)) {
          session.unknown = true;
          throw new Error('Online transcription returned no session identity.');
        }
        session.sessionId = result.sessionId;
        if (result.transcriptionSessionId !== undefined && !validSessionIdentity(result.transcriptionSessionId)) {
          revoke(session);
          throw new Error('OpenClaw returned an invalid transcription session identity.');
        }
        session.transcriptionSessionId = result.transcriptionSessionId as string | undefined ?? result.sessionId;
        if (!current(session)) {
          revoke(session);
          throw new Error('Online transcription start was cancelled.');
        }
        const audio = isRecord(result.audio) ? result.audio : {};
        if (audio.inputEncoding !== 'g711_ulaw' || audio.inputSampleRateHz !== 8000 || result.provider !== OpenClawExtensionId.OPENAI) {
          revoke(session);
          throw new Error('OpenClaw returned an unsupported transcription audio format.');
        }
        sessions.set(session.sessionId, session);
        const early = earlyLifecycle.get(session.transcriptionSessionId);
        earlyLifecycle.delete(session.transcriptionSessionId);
        if (early && early.runtime === runtime && early.generation === session.generation)
          handleGatewayEvent(runtime, early.frame);
        if (owners.get(owner) !== session) throw new Error('Online transcription closed before admission.');
        return {
          sessionId: session.sessionId, transcriptionSessionId: session.transcriptionSessionId,
          provider: OpenClawExtensionId.OPENAI, inputEncoding: 'g711_ulaw', inputSampleRateHz: 8000,
        };
      } catch (error) {
        const definitive = responseContext?.isResponseError(error);
        if (!sent || definitive || session.sessionId) forgetSession(session);
        else { session.unknown = true; session.cancelled = true; }
        if (session.unknown)
          throw new Error('Online transcription start outcome is unknown. Reconnect the engine before starting again.');
        if (sent && definitive) throw new Error('Online transcription could not start.');
        throw error;
      } finally {
        if (![...owners.values()].some(pending => !pending.sessionId && !pending.unknown)) earlyLifecycle.clear();
      }
    },
  );

  ipcMain.handle(
    OnlineAsrIpc.AppendAudio,
    async (event, sessionId: unknown, audioBase64: unknown) => {
      const session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
      if (!session || session.owner !== event.sender || event.senderFrame !== session.frame ||
        typeof audioBase64 !== 'string' || !audioBase64 || audioBase64.length > MAX_AUDIO_BASE64_LENGTH ||
        session.closing || session.sending)
        throw new Error('Invalid online transcription audio request.');
      if (!current(session)) { revoke(session); throw new Error('Online transcription is no longer current.'); }
      session.sending = true;
      try {
        await session.client.request('talk.session.appendAudio', { sessionId, audioBase64 }, { timeoutMs: 5000 });
        if (!current(session)) { revoke(session); throw new Error('Online transcription is no longer current.'); }
      } catch {
        revoke(session);
        throw new Error('Online transcription audio could not be sent.');
      } finally { session.sending = false; }
    },
  );

  ipcMain.handle(OnlineAsrIpc.Close, async (event, sessionId: unknown) => {
    const session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
    if (!session || session.owner !== event.sender || event.senderFrame !== session.frame) return;
    if (!current(session)) { revoke(session); return; }
    if (session.closing) return;
    session.closing = true;
    session.closeSent = true;
    try {
      await session.client.request('talk.session.close', { sessionId }, { timeoutMs: 5000 });
    } finally {
      if (sessions.get(session.sessionId!) === session)
        session.cleanupTimer = setTimeout(() => forgetSession(session), CLOSED_SESSION_EVENT_TTL_MS);
    }
  });
}
