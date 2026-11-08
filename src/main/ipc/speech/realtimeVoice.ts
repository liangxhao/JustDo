import { ipcMain, type IpcMainInvokeEvent, type WebContents, type WebFrameMain } from 'electron';

import { getRealtimeVoiceSettingsKey, normalizeLocalSpeechSettings } from '../../../shared/speech/localSpeechSettings';
import { resolveOnlineSpeechBinding, resolveOnlineSpeechVoiceSelection } from '../../../shared/speech/onlineSpeechModels';
import {
  isRealtimeVoiceAudio, isRealtimeVoiceIdentity, isRealtimeVoiceRequestId,
type RealtimeVoiceEvent,   RealtimeVoiceIpc, type RealtimeVoiceSession,
  type RealtimeVoiceSource,
  type RealtimeVoiceStatus,
} from '../../../shared/speech/realtimeVoice';
import type { GatewayClientLike, GatewayEventFrame } from '../../engine/gateway/types';
import type { OpenClawRuntimeAdapter } from '../../engine/openclaw/openclawRuntimeAdapter';
import { buildSpeechCredentialSlot } from '../../openclaw/config/speech/speechCredentialSlot';
import { getSpeechConfigurationRevision, onSpeechConfigurationChanged } from '../../speech/speechConfigurationRevision';
import { RealtimeVoiceConsultations } from './realtimeVoiceConsultation';

interface Dependencies {
  getRuntime: () => OpenClawRuntimeAdapter | null;
  getSettings: () => unknown;
  getModelCategory: () => unknown;
  getSessionIdentity: (sessionId: string) => string | null;
  runConfigMutationExclusive?: <T>(operation: () => Promise<T>) => Promise<T>;
}
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const validKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every(key => keys.includes(key));

interface Invocation {
  owner: WebContents;
  frame: WebFrameMain;
  requestId: string;
  productSessionId: string;
  sourceIdentity: string | null;
  source?: RealtimeVoiceSource;
  runtime: OpenClawRuntimeAdapter;
  client: GatewayClientLike;
  generation: number;
  configurationKey: string;
  configurationRevision: number;
  voiceSessionId?: string;
  turnId?: string;
  cancelled: boolean;
  unknown: boolean;
  detach: () => void;
  marks: Set<string>;
  sending: boolean;
  creating: boolean;
  lastGatewaySeq?: number;
  consultations?: RealtimeVoiceConsultations;
}

export function registerRealtimeVoiceHandlers(deps: Dependencies): void {
  const owners = new Map<WebContents, Invocation>();
  const sessions = new Map<string, Invocation>();
  const attached = new WeakSet<OpenClawRuntimeAdapter>();
  // Only lifecycle flags can precede the create RPC response in one WS receive batch.
  // Audio and transcripts are never cached before exact session admission.
  const earlyLifecycle = new Map<string, { runtime: OpenClawRuntimeAdapter; generation: number; frame: GatewayEventFrame }>();

  const selection = () => {
    const settings = normalizeLocalSpeechSettings(deps.getSettings());
    if (!settings.realtimeEnabled) return null;
    const selected = resolveOnlineSpeechBinding(deps.getModelCategory(), settings.realtimeModelRef,
      settings.realtimeBindingId, 'realtime-voice');
    if (!selected || selected.binding.protocolId !== 'openai-voice-realtime' ||
      !selected.binding.inputTranscriptionModel) return null;
    const voice = resolveOnlineSpeechVoiceSelection(selected.model, selected.binding,
      settings.realtimeVoiceSelection);
    if (voice?.kind !== 'preset') return null;
    return { selected, voice: voice.voiceId, key: JSON.stringify([
      getRealtimeVoiceSettingsKey(settings), selected.provider.baseUrl,
      selected.provider.apiKey, selected.model.id, selected.binding,
    ]) };
  };
  const connectionCurrent = (call: Invocation) => deps.getRuntime() === call.runtime &&
    call.runtime.getGatewayClient() === call.client &&
    call.runtime.getGatewayClientGeneration() === call.generation;
  const current = (call: Invocation) => !call.cancelled && owners.get(call.owner) === call &&
    !call.owner.isDestroyed() && call.owner.mainFrame === call.frame && connectionCurrent(call) &&
    getSpeechConfigurationRevision('realtime') === call.configurationRevision &&
    selection()?.key === call.configurationKey &&
    deps.getSessionIdentity(call.productSessionId) === call.sourceIdentity;
  const forget = (call: Invocation) => {
    call.consultations?.close();
    call.detach();
    if (owners.get(call.owner) === call) owners.delete(call.owner);
    if (call.voiceSessionId && sessions.get(call.voiceSessionId) === call)
      sessions.delete(call.voiceSessionId);
    call.marks.clear();
  };
  const notify = (call: Invocation, event: Omit<RealtimeVoiceEvent, 'requestId' | 'voiceSessionId' | 'source'>) => {
    if (!call.voiceSessionId || !call.source || call.owner.isDestroyed() || call.owner.mainFrame !== call.frame) return;
    call.owner.send(RealtimeVoiceIpc.Event, { ...event, requestId: call.requestId,
      voiceSessionId: call.voiceSessionId, source: call.source });
  };
  const revoke = async (call: Invocation, reason?: RealtimeVoiceEvent['reason']) => {
    call.cancelled = true;
    if (reason) notify(call, { type: 'close', reason });
    if (!call.voiceSessionId) return;
    const canClose = connectionCurrent(call);
    forget(call);
    if (!canClose) return;
    try {
      await call.client.request('talk.session.close', { sessionId: call.voiceSessionId }, { timeoutMs: 5000 });
    } catch { /* A captured client may reject synchronously while its transport retires. */ }
  };
  const requireOwner = (event: IpcMainInvokeEvent) => {
    const owner = event.sender;
    if (owner.isDestroyed() || owner.getType() !== 'window' || event.senderFrame !== owner.mainFrame)
      throw new Error('Realtime voice requires an application window frame.');
    return owner;
  };
  const owned = (event: IpcMainInvokeEvent, value: unknown, extra: string[] = []) => {
    const owner = requireOwner(event);
    if (!record(value) || !validKeys(value, ['requestId', 'voiceSessionId', ...extra]) ||
      !isRealtimeVoiceRequestId(value.requestId) || !isRealtimeVoiceIdentity(value.voiceSessionId))
      throw new Error('Invalid realtime voice control request.');
    const call = owners.get(owner);
    if (!call || call.requestId !== value.requestId || call.voiceSessionId !== value.voiceSessionId)
      throw new Error('Realtime voice request has no current owner.');
    if (!current(call)) {
      void revoke(call, connectionCurrent(call) ? 'configuration-changed' : 'connection-changed');
      throw new Error('Realtime voice request is no longer current.');
    }
    return { call, value };
  };
  const forward = (runtime: OpenClawRuntimeAdapter, frame: GatewayEventFrame) => {
    if (frame.event === 'chat') {
      for (const call of sessions.values()) {
        if (call.runtime !== runtime) continue;
        if (!current(call)) {
          void revoke(call, connectionCurrent(call) ? 'configuration-changed' : 'connection-changed');
          continue;
        }
        call.consultations?.receiveChat(frame.payload);
      }
      return;
    }
    if (frame.event !== 'talk.event' || !record(frame.payload)) return;
    const payload = frame.payload;
    const relayId = payload.relaySessionId;
    const call = typeof relayId === 'string' ? sessions.get(relayId) : undefined;
    if (!call) {
      if (isRealtimeVoiceIdentity(relayId) && ['ready', 'error', 'close'].includes(String(payload.type)) &&
        earlyLifecycle.size < 32 && [...owners.values()].some(pending => pending.creating &&
          pending.runtime === runtime && connectionCurrent(pending))) {
        earlyLifecycle.set(relayId, { runtime, generation: runtime.getGatewayClientGeneration(),
          frame: { event: 'talk.event', seq: frame.seq,
            payload: { relaySessionId: relayId, type: payload.type, reason: payload.reason } } });
      }
      return;
    }
    if (call.runtime !== runtime) return;
    if (!current(call)) { void revoke(call, connectionCurrent(call) ? 'configuration-changed' : 'connection-changed'); return; }
    if (typeof frame.seq === 'number') {
      if (call.lastGatewaySeq !== undefined && frame.seq <= call.lastGatewaySeq) return;
      call.lastGatewaySeq = frame.seq;
    }
    const talk = record(payload.talkEvent) ? payload.talkEvent : {};
    if (isRealtimeVoiceIdentity(talk.turnId)) call.turnId = talk.turnId;
    if (isRealtimeVoiceIdentity(payload.turnId)) call.turnId = payload.turnId;
    const turn = call.turnId ? { turnId: call.turnId } : {};
    switch (payload.type) {
      case 'clear':
        call.marks.clear();
        if (talk.type === 'turn.cancelled') call.consultations?.cancelTurn(talk.turnId);
        notify(call, { type: 'clear', ...turn }); break;
      case 'ready': case 'responseStarted': case 'audioDone':
        notify(call, { type: payload.type, ...turn }); break;
      case 'audio':
        if (isRealtimeVoiceAudio(payload.audioBase64))
          notify(call, { type: 'audio', audioBase64: payload.audioBase64, ...turn });
        else void revoke(call, 'error');
        break;
      case 'mark':
        if (isRealtimeVoiceIdentity(payload.markName) && call.marks.size < 2048) {
          call.marks.add(payload.markName);
          notify(call, { type: 'mark', markName: payload.markName, ...turn });
        } else void revoke(call, 'error');
        break;
      case 'transcript':
        if ((payload.role === 'user' || payload.role === 'assistant') &&
          typeof payload.text === 'string' && payload.text.length <= 64_000) {
          notify(call, { type: 'transcript', role: payload.role, text: payload.text,
            final: payload.final === true,
            ...(payload.textMode === 'snapshot' ? { textMode: 'snapshot' as const } : {}),
            ...(isRealtimeVoiceIdentity(payload.transcriptId) ? { transcriptId: payload.transcriptId } : {}), ...turn });
        }
        break;
      case 'error': notify(call, { type: 'error', ...turn }); break;
      case 'toolCall': call.consultations?.accept(payload, call.turnId); break;
      case 'toolCallCancelled': call.consultations?.retire(payload.callId); break;
      case 'toolResult':
        if (talk.final === true || payload.final === true) call.consultations?.retire(payload.callId);
        break;
      case 'close':
        notify(call, { type: 'close', reason: payload.reason === 'completed' ? 'completed' : 'error' });
        call.cancelled = true;
        forget(call);
        break;
    }
  };
  const attach = (runtime: OpenClawRuntimeAdapter) => {
    if (attached.has(runtime)) return;
    attached.add(runtime);
    runtime.on('gatewayEvent', frame => forward(runtime, frame));
  };
  const probe = async (runtime: OpenClawRuntimeAdapter, client: GatewayClientLike, selected: NonNullable<ReturnType<typeof selection>>) => {
    attach(runtime);
    const [catalog, snapshot] = await Promise.all([
      client.request<Record<string, unknown>>('talk.catalog', {}, { timeoutMs: 5000 }),
      client.request<{ config?: unknown; configRevisionHash?: unknown; appliedConfigHash?: unknown }>('config.get', {}, { timeoutMs: 5000 }),
    ]);
    const realtime = record(catalog.realtime) ? catalog.realtime : {};
    const providers = Array.isArray(realtime.providers) ? realtime.providers : [];
    const config = record(snapshot.config) ? snapshot.config : {};
    const plugins = record(config.plugins) ? config.plugins : {};
    const entries = record(plugins.entries) ? plugins.entries : {};
    const plugin = record(entries.openai) ? entries.openai : {};
    const pluginConfig = record(plugin.config) ? plugin.config : {};
    const profile = record(pluginConfig.realtimeVoice) ? pluginConfig.realtimeVoice : {};
    const talk = record(config.talk) ? config.talk : {};
    const talkRealtime = record(talk.realtime) ? talk.realtime : {};
    return typeof snapshot.configRevisionHash === 'string' && Boolean(snapshot.configRevisionHash.trim()) &&
      snapshot.appliedConfigHash === snapshot.configRevisionHash &&
      providers.some(provider => record(provider) && provider.id === 'openai' && provider.configured === true) &&
      talkRealtime.provider === 'openai' && talkRealtime.consultRouting === 'force-agent-consult' &&
      !Object.prototype.hasOwnProperty.call(profile, 'compatibilityProfile') &&
      profile.protocolId === 'openai-voice-realtime' &&
      profile.baseUrl === selected.selected.provider.baseUrl.trim() &&
      profile.configurationId === buildSpeechCredentialSlot('realtimeVoice',
        selected.selected.provider.baseUrl.trim(), selected.selected.provider.apiKey.trim()) &&
      profile.model === selected.selected.model.id && profile.speakerVoice === selected.voice &&
      profile.inputTranscriptionModel === selected.selected.binding.inputTranscriptionModel;
  };
  ipcMain.handle(RealtimeVoiceIpc.GetStatus, async (event): Promise<RealtimeVoiceStatus> => {
    const owner = requireOwner(event);
    const settings = normalizeLocalSpeechSettings(deps.getSettings());
    if (!settings.realtimeEnabled) return { available: false, reason: 'disabled' };
    const selected = selection();
    if (!selected) return { available: false, reason: 'unconfigured' };
    const previous = owners.get(owner);
    if (previous && !connectionCurrent(previous)) forget(previous);
    else if (previous) return { available: false, reason: previous.unknown ? 'unknown' : 'busy',
      model: selected.selected.model.id, voice: selected.voice };
    const runtime = deps.getRuntime();
    const client = runtime?.getGatewayClient();
    if (!runtime || !client) return { available: false, reason: 'gateway-unavailable' };
    const generation = runtime.getGatewayClientGeneration();
    const revision = getSpeechConfigurationRevision('realtime');
    try {
      const ready = await probe(runtime, client, selected);
      if (deps.getRuntime() !== runtime || runtime.getGatewayClient() !== client ||
        runtime.getGatewayClientGeneration() !== generation ||
        getSpeechConfigurationRevision('realtime') !== revision || selection()?.key !== selected.key)
        return { available: false, reason: 'gateway-unavailable' };
      return { available: ready, ...(!ready ? { reason: 'unsupported' as const } : {}),
        model: selected.selected.model.id, voice: selected.voice };
    } catch { return { available: false, reason: 'gateway-unavailable' }; }
  });
  ipcMain.handle(RealtimeVoiceIpc.Start, async (event, value: unknown): Promise<RealtimeVoiceSession> => {
    const owner = requireOwner(event);
    if (!record(value) || !validKeys(value, ['requestId', 'productSessionId']) ||
      !isRealtimeVoiceRequestId(value.requestId) || !isRealtimeVoiceIdentity(value.productSessionId))
      throw new Error('Invalid realtime voice start request.');
    const previous = owners.get(owner);
    if (previous && !connectionCurrent(previous)) forget(previous);
    else if (previous) throw new Error('A realtime voice request is already active or unresolved.');
    const selected = selection();
    const runtime = deps.getRuntime();
    const client = runtime?.getGatewayClient();
    if (!selected || !runtime || !client || !deps.getSessionIdentity(value.productSessionId))
      throw new Error('Realtime voice is unavailable for this conversation.');
    const call: Invocation = { owner, frame: event.senderFrame!, requestId: value.requestId,
      productSessionId: value.productSessionId, sourceIdentity: deps.getSessionIdentity(value.productSessionId), runtime, client,
      generation: runtime.getGatewayClientGeneration(), configurationKey: selected.key,
      configurationRevision: getSpeechConfigurationRevision('realtime'),
      cancelled: false, unknown: false, detach: () => undefined, marks: new Set(), sending: false, creating: false };
    owners.set(owner, call);
    const cleanup = () => { void revoke(call); if (!call.voiceSessionId) forget(call); };
    owner.once('destroyed', cleanup);
    owner.once('did-navigate', cleanup);
    owner.once('render-process-gone', cleanup);
    const unsubscribeConfiguration = onSpeechConfigurationChanged('realtime', () => {
      if (owners.get(owner) === call) void revoke(call, 'configuration-changed');
    });
    call.detach = () => {
      unsubscribeConfiguration();
      owner.removeListener('destroyed', cleanup);
      owner.removeListener('did-navigate', cleanup);
      owner.removeListener('render-process-gone', cleanup);
    };
    let sent = false;
    const responseContext = runtime.captureGatewayResponseContext();
    try {
      const create = async () => {
        if (!await probe(runtime, client, selected)) throw new Error('Realtime voice provider is not ready.');
        if (!current(call)) throw new Error('Realtime voice start was cancelled.');
        const prepared = await runtime.prepareSession(call.productSessionId);
        call.sourceIdentity = deps.getSessionIdentity(call.productSessionId);
        if (!call.sourceIdentity || !current(call)) throw new Error('Realtime voice start was cancelled.');
        if (!isRealtimeVoiceIdentity(prepared.sessionKey) || !isRealtimeVoiceIdentity(prepared.gatewaySessionId))
          throw new Error('Realtime voice requires an exact prepared conversation.');
        call.source = Object.freeze({ productSessionId: call.productSessionId,
          sessionKey: prepared.sessionKey, sessionId: prepared.gatewaySessionId });
        sent = true;
        call.creating = true;
        return client.request<Record<string, unknown>>('talk.session.create', {
          mode: 'realtime', transport: 'gateway-relay', brain: 'agent-consult', provider: 'openai',
          model: selected.selected.model.id, voice: selected.voice, sessionKey: prepared.sessionKey,
        }, { timeoutMs: 15_000 });
      };
      const result = await (deps.runConfigMutationExclusive ? deps.runConfigMutationExclusive(create) : create());
      if (!isRealtimeVoiceIdentity(result.sessionId)) { call.unknown = true; throw new Error('Realtime voice returned no session identity.'); }
      call.voiceSessionId = result.sessionId;
      if (!current(call)) { await revoke(call); throw new Error('Realtime voice start was cancelled.'); }
      const audio = record(result.audio) ? result.audio : {};
      if (result.relaySessionId !== result.sessionId || result.provider !== 'openai' ||
        audio.inputEncoding !== 'pcm16' || audio.outputEncoding !== 'pcm16' ||
        audio.inputSampleRateHz !== 24000 || audio.outputSampleRateHz !== 24000) {
        await revoke(call);
        throw new Error('Realtime voice returned an unsupported audio contract.');
      }
      sessions.set(call.voiceSessionId, call);
      call.consultations = new RealtimeVoiceConsultations({ client, source: call.source!,
        voiceSessionId: call.voiceSessionId, isCurrent: () => current(call),
        onFailure: () => { void revoke(call, 'error'); } });
      const early = earlyLifecycle.get(call.voiceSessionId);
      earlyLifecycle.delete(call.voiceSessionId);
      if (early && early.runtime === runtime && early.generation === call.generation) forward(runtime, early.frame);
      if (call.cancelled) throw new Error('Realtime voice closed before admission.');
      return { requestId: call.requestId, voiceSessionId: call.voiceSessionId,
        source: call.source!,
        model: selected.selected.model.id, voice: selected.voice, inputEncoding: 'pcm16',
        inputSampleRateHz: 24000, outputEncoding: 'pcm16', outputSampleRateHz: 24000 };
    } catch (error) {
      if (!sent || responseContext?.isResponseError(error) || call.voiceSessionId) forget(call);
      else { call.unknown = true; call.cancelled = true; }
      throw new Error(call.unknown ? 'Realtime voice start outcome is unknown. Reconnect the engine before starting again.' :
        'Realtime voice could not start. Check the saved configuration and conversation.');
    } finally {
      call.creating = false;
      if (![...owners.values()].some(pending => pending.creating)) earlyLifecycle.clear();
    }
  });
  ipcMain.handle(RealtimeVoiceIpc.AppendAudio, async (event, input: unknown) => {
    const { call, value } = owned(event, input, ['audioBase64']);
    if (!isRealtimeVoiceAudio(value.audioBase64) || call.sending)
      throw new Error('Invalid or overlapping realtime voice audio.');
    call.sending = true;
    try {
      await call.client.request('talk.session.appendAudio', { sessionId: call.voiceSessionId,
        audioBase64: value.audioBase64 }, { timeoutMs: 5000 });
      if (!current(call)) throw new Error('Realtime voice audio is no longer current.');
    } catch { throw new Error('Realtime voice audio could not be sent.'); }
    finally { call.sending = false; }
  });
  ipcMain.handle(RealtimeVoiceIpc.Interrupt, async (event, input: unknown) => {
    const { call, value } = owned(event, input, ['turnId']);
    if (!isRealtimeVoiceIdentity(value.turnId)) throw new Error('Invalid realtime voice turn.');
    // A stale button can still clear its local playback, but must not retire a newer turn.
    if (call.turnId !== value.turnId) return;
    try {
      await call.client.request('talk.session.cancelOutput', { sessionId: call.voiceSessionId,
        turnId: value.turnId }, { timeoutMs: 5000 });
    } catch { throw new Error('Realtime voice interruption could not be confirmed.'); }
  });
  ipcMain.handle(RealtimeVoiceIpc.AcknowledgeMark, async (event, input: unknown) => {
    const { call, value } = owned(event, input, ['markName']);
    if (!isRealtimeVoiceIdentity(value.markName) || !call.marks.delete(value.markName)) return;
    try {
      await call.client.request('talk.session.acknowledgeMark', { sessionId: call.voiceSessionId,
        markName: value.markName }, { timeoutMs: 5000 });
    } catch { throw new Error('Realtime voice playback acknowledgment failed.'); }
  });
  ipcMain.handle(RealtimeVoiceIpc.Close, async (event, value: unknown) => {
    const owner = requireOwner(event);
    if (!record(value) || !validKeys(value, ['requestId', 'voiceSessionId']) ||
      !isRealtimeVoiceRequestId(value.requestId) ||
      (value.voiceSessionId !== undefined && !isRealtimeVoiceIdentity(value.voiceSessionId)))
      throw new Error('Invalid realtime voice close request.');
    const call = owners.get(owner);
    if (call?.requestId === value.requestId &&
      (value.voiceSessionId === undefined || call.voiceSessionId === value.voiceSessionId)) await revoke(call, 'completed');
  });
}
