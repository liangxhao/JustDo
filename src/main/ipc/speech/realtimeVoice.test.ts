import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultLocalSpeechSettings } from '../../../shared/speech/localSpeechSettings';
import { RealtimeVoiceIpc } from '../../../shared/speech/realtimeVoice';

const handlers = new Map<string, (...args: never[]) => unknown>();
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: never[]) => unknown) => handlers.set(name, fn) } }));
import { buildSpeechCredentialSlot } from '../../openclaw/config/speech/speechCredentialSlot';
import { advanceSpeechConfigurationRevision } from '../../speech/speechConfigurationRevision';
import { registerRealtimeVoiceHandlers } from './realtimeVoice';

class Owner extends EventEmitter {
  mainFrame = {};
  send = vi.fn();
  isDestroyed = () => false;
  getType = () => 'window';
}
const owners: Owner[] = [];
const source = { productSessionId: 'product-1', sessionKey: 'agent:main:exact-chat', sessionId: 'native-chat' };
const deferred = <T>() => { let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve(); };

function fixture() {
  const owner = new Owner();
  owners.push(owner);
  const runtime = new EventEmitter();
  let generation = 1;
  let identity = 'exact-native-source';
  const settings = { ...defaultLocalSpeechSettings, realtimeEnabled: true,
    realtimeModelRef: 'office/live', realtimeBindingId: 'duplex',
    realtimeVoiceSelection: { kind: 'preset' as const, voiceId: 'calm' } };
  const category = { providers: { office: { displayName: 'Office', baseUrl: 'ws://speech.internal/v1', apiKey: '',
    models: [{ id: 'live', name: 'Live', voices: [{ id: 'calm', name: 'Calm' }], bindings: [{ id: 'duplex',
      protocolId: 'openai-voice-realtime', inputTranscriptionModel: 'input-stt', voicePolicy: 'preset' }] }] } } };
  const profile = { protocolId: 'openai-voice-realtime', baseUrl: 'ws://speech.internal/v1',
    configurationId: buildSpeechCredentialSlot('realtimeVoice', category.providers.office.baseUrl, ''),
    model: 'live', speakerVoice: 'calm', inputTranscriptionModel: 'input-stt', apiKey: '' };
  const config = { plugins: { entries: { openai: { config: { realtimeVoice: profile as unknown } } } },
    talk: { realtime: { provider: 'openai', consultRouting: 'force-agent-consult' } } };
  const snapshot: { config: typeof config; configRevisionHash?: string; appliedConfigHash?: string } = {
    config, configRevisionHash: 'published-revision', appliedConfigHash: 'published-revision',
  };
  const result = { sessionId: 'voice-1', relaySessionId: 'voice-1', provider: 'openai',
    audio: { inputEncoding: 'pcm16', inputSampleRateHz: 24000, outputEncoding: 'pcm16', outputSampleRateHz: 24000 } };
  const request = vi.fn(async (method: string, _params?: unknown, _options?: unknown): Promise<unknown> => {
    if (method === 'talk.catalog') return { realtime: { providers: [{ id: 'openai', configured: true }] } };
    if (method === 'config.get') return snapshot;
    if (method === 'talk.session.create') return result;
    if (method === 'talk.client.toolCall') return { runId: 'consult-1', agentId: 'main', agentSessionKey: source.sessionKey };
    return {};
  });
  const client = { request };
  const prepareSession = vi.fn(async () => ({ sessionKey: 'agent:main:exact-chat', gatewaySessionId: 'native-chat' }));
  Object.assign(runtime, { getGatewayClient: () => client, getGatewayClientGeneration: () => generation,
    prepareSession, captureGatewayResponseContext: () => ({ isResponseError: () => false }) });
  const lock = vi.fn(async (operation: () => Promise<unknown>) => operation());
  registerRealtimeVoiceHandlers({ getRuntime: () => runtime as never, getSettings: () => settings,
    getModelCategory: () => category, getSessionIdentity: () => identity,
    runConfigMutationExclusive: lock as never });
  const invoke = (channel: string, value?: unknown, selectedOwner = owner, frame = selectedOwner.mainFrame) =>
    handlers.get(channel)!({ sender: selectedOwner, senderFrame: frame } as never, value as never);
  const start = () => invoke(RealtimeVoiceIpc.Start, { requestId: 'request-1', productSessionId: 'product-1' });
  const event = (payload: Record<string, unknown>) => runtime.emit('gatewayEvent', { event: 'talk.event',
    payload: { relaySessionId: 'voice-1', ...payload } });
  const chat = (payload: Record<string, unknown>) => runtime.emit('gatewayEvent', { event: 'chat',
    payload: { sessionKey: source.sessionKey, ...payload } });
  const toolCall = (callId = 'call-1') => event({ type: 'toolCall', callId,
    name: 'openclaw_agent_consult', args: { question: 'Check this request.' },
    forced: true, talkEvent: { turnId: 'turn-1' } });
  return { owner, runtime, request, result, settings, category, config, snapshot, prepareSession, lock, invoke, start, event, chat, toolCall,
    changeGeneration: () => { generation += 1; }, changeSource: () => { identity = 'replaced-native-source'; } };
}

beforeEach(() => handlers.clear());
afterEach(() => { owners.splice(0).forEach(owner => owner.emit('destroyed')); vi.useRealTimers(); });
describe('realtime voice Main ownership and admission', () => {
  it('requires the own profile and concrete provider, never a top-level realtime mode claim', async () => {
    const f = fixture();
    f.config.plugins.entries.openai.config.realtimeVoice = null;
    await expect(f.invoke(RealtimeVoiceIpc.GetStatus)).resolves.toEqual(expect.objectContaining({ available: false }));
    await expect(f.start()).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalledWith('talk.session.create', expect.anything(), expect.anything());
  });

  it.each(['model', 'voice', 'endpoint'] as const)(
    'does not prepare a conversation or create a session without the selected %s', async missing => {
      const f = fixture();
      if (missing === 'model') {
        f.category.providers.office.models[0].id = '';
        f.settings.realtimeModelRef = 'office/';
      } else if (missing === 'voice') f.category.providers.office.models[0].voices = [];
      else f.category.providers.office.baseUrl = '';
      await expect(f.invoke(RealtimeVoiceIpc.GetStatus)).resolves.toMatchObject({ available: false, reason: 'unconfigured' });
      await expect(f.start()).rejects.toThrow();
      expect(f.prepareSession).not.toHaveBeenCalled();
      expect(f.request).not.toHaveBeenCalled();
    },
  );

  it.each([{ model: 'different-model' }, { speakerVoice: 'different-voice' }, { inputTranscriptionModel: 'different-transcriber' }])(
    'rejects native parameters that differ from the explicit selection (%j)', async changed => {
      const f = fixture();
      Object.assign(f.config.plugins.entries.openai.config.realtimeVoice as object, changed);
      await expect(f.invoke(RealtimeVoiceIpc.GetStatus)).resolves.toMatchObject({ available: false });
      await expect(f.start()).rejects.toThrow();
      expect(f.prepareSession).not.toHaveBeenCalled();
      expect(f.request.mock.calls.some(([method]) => method === 'talk.session.create')).toBe(false);
    },
  );
  it('does not create a realtime session from a native profile carrying a deprecated field', async () => {
    const f = fixture();
    Object.assign(f.config.plugins.entries.openai.config.realtimeVoice as object, { compatibilityProfile: 'removed' });
    await expect(f.invoke(RealtimeVoiceIpc.GetStatus)).resolves.toMatchObject({ available: false });
    await expect(f.start()).rejects.toThrow();
    expect(f.request.mock.calls.some(([method]) => method === 'talk.session.create')).toBe(false);
  });
  it.each([
    { name: 'missing hashes', revision: undefined, applied: undefined },
    { name: 'blank hashes', revision: ' ', applied: ' ' },
    { name: 'a pending application', revision: 'published-revision', applied: 'previous-revision' },
  ])('rejects status and Start with $name even when the saved profile matches', async ({ revision, applied }) => {
    const f = fixture();
    f.snapshot.configRevisionHash = revision;
    f.snapshot.appliedConfigHash = applied;
    await expect(f.invoke(RealtimeVoiceIpc.GetStatus)).resolves.toMatchObject({ available: false });
    await expect(f.start()).rejects.toThrow();
    expect(f.prepareSession).not.toHaveBeenCalled();
    expect(f.request.mock.calls.some(([method]) => method === 'talk.session.create')).toBe(false);
    f.snapshot.configRevisionHash = 'published-revision';
    f.snapshot.appliedConfigHash = 'published-revision';
    await expect(f.invoke(RealtimeVoiceIpc.GetStatus)).resolves.toMatchObject({ available: true });
  });
  it('pins the prepared native conversation and explicit model/voice under the configuration lock', async () => {
    const f = fixture(); await f.start();
    expect(f.lock).toHaveBeenCalledTimes(1);
    expect(f.prepareSession).toHaveBeenCalledWith('product-1');
    expect(f.request).toHaveBeenCalledWith('talk.session.create', {
      mode: 'realtime', transport: 'gateway-relay', brain: 'agent-consult', provider: 'openai',
      model: 'live', voice: 'calm', sessionKey: 'agent:main:exact-chat',
    }, { timeoutMs: 15000 });
  });
  it('requires the published credential version even when redacted native keys and endpoint/model match', async () => {
    const f = fixture();
    await expect(f.invoke(RealtimeVoiceIpc.GetStatus)).resolves.toMatchObject({ available: true });
    f.category.providers.office.apiKey = 'rotated-fixture-key';
    const profile = f.config.plugins.entries.openai.config.realtimeVoice as Record<string, unknown>;
    profile.apiKey = { source: 'file', provider: 'fixture', id: '__OPENCLAW_REDACTED__' };
    await expect(f.invoke(RealtimeVoiceIpc.GetStatus)).resolves.toMatchObject({ available: false });
    await expect(f.start()).rejects.toThrow();
    expect(f.prepareSession).not.toHaveBeenCalled();
    profile.configurationId = buildSpeechCredentialSlot('realtimeVoice',
      f.category.providers.office.baseUrl, f.category.providers.office.apiKey);
    await expect(f.invoke(RealtimeVoiceIpc.GetStatus)).resolves.toMatchObject({ available: true });
  });
  it('retains only early lifecycle flags until the create response establishes the exact owner', async () => {
    const f = fixture(); const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async method => {
      if (method === 'talk.session.create') {
        f.event({ type: 'transcript', role: 'user', text: 'unadmitted', final: true });
        f.event({ type: 'ready' });
      }
      return original(method);
    });
    await f.start();
    expect(f.owner.send).toHaveBeenCalledWith(RealtimeVoiceIpc.Event,
      { type: 'ready', requestId: 'request-1', voiceSessionId: 'voice-1', source });
    expect(f.owner.send.mock.calls.some(([, event]) => event.type === 'transcript')).toBe(false);
  });
  it('rejects non-main frames and cross-window control', async () => {
    const f = fixture();
    await expect(f.invoke(RealtimeVoiceIpc.Start, { requestId: 'x', productSessionId: 'product-1' }, f.owner, {})).rejects.toThrow();
    await f.start();
    await expect(f.invoke(RealtimeVoiceIpc.AppendAudio, { requestId: 'request-1', voiceSessionId: 'voice-1',
      audioBase64: 'AAA=' }, new Owner())).rejects.toThrow();
  });
  it('closes an unsupported audio result rather than starting a telephone-codec playback', async () => {
    const f = fixture(); f.result.audio.outputEncoding = 'g711_ulaw';
    await expect(f.start()).rejects.toThrow();
    expect(f.request).toHaveBeenCalledWith('talk.session.close', { sessionId: 'voice-1' }, { timeoutMs: 5000 });
  });
  it('invalidates audio on same-reference credential changes and never forwards secret or tool fields', async () => {
    const f = fixture(); await f.start();
    f.event({ type: 'toolCall', callId: 'unknown-call', name: 'unknown', args: { secret: 'hidden' } });
    expect(f.owner.send).not.toHaveBeenCalled();
    f.category.providers.office.apiKey = 'rotated-key';
    f.event({ type: 'audio', audioBase64: 'AAA=' }); await flush();
    expect(f.owner.send).toHaveBeenCalledWith(RealtimeVoiceIpc.Event, expect.objectContaining({ type: 'close', reason: 'configuration-changed' }));
    expect(JSON.stringify(f.owner.send.mock.calls)).not.toContain('rotated-key');
    expect(f.owner.send.mock.calls.some(([, event]) => event.type === 'audio')).toBe(false);
  });
  it('revokes immediately on A → B → A and cannot resume the old native call when values match again', async () => {
    const f = fixture(); await f.start();
    const previous = { voice: f.settings, onlineModelProviders: { 'realtime-voice': f.category } };
    const next = structuredClone(previous);
    next.voice.realtimeVoiceSelection.voiceId = 'other';
    advanceSpeechConfigurationRevision(next, previous);
    advanceSpeechConfigurationRevision(previous, next);
    f.event({ type: 'audio', audioBase64: 'AAA=' });
    expect(f.owner.send.mock.calls.filter(([, event]) => event.type === 'close')).toHaveLength(1);
    expect(f.owner.send.mock.calls.some(([, event]) => event.type === 'audio')).toBe(false);
    await expect(f.invoke(RealtimeVoiceIpc.AppendAudio, { requestId: 'request-1', voiceSessionId: 'voice-1', audioBase64: 'AAA=' })).rejects.toThrow();
  });
  it('discards a late status query after A → B → A even when its selection matches again', async () => {
    const f = fixture();
    const catalog = deferred<unknown>();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(method => method === 'talk.catalog' ? catalog.promise : original(method));
    const pending = f.invoke(RealtimeVoiceIpc.GetStatus);
    const a = { voice: f.settings, onlineModelProviders: { 'realtime-voice': f.category } };
    const b = structuredClone(a);
    b.voice.realtimeEnabled = false;
    advanceSpeechConfigurationRevision(b, a);
    advanceSpeechConfigurationRevision(a, b);
    catalog.resolve({ realtime: { providers: [{ id: 'openai', configured: true }] } });
    await expect(pending).resolves.toMatchObject({ available: false });
    await expect(f.invoke(RealtimeVoiceIpc.GetStatus)).resolves.toMatchObject({ available: true });
  });
  it('does not let stale cancellation affect an active request and validates exact turns/marks', async () => {
    const f = fixture(); await f.start(); f.request.mockClear();
    await f.invoke(RealtimeVoiceIpc.Close, { requestId: 'older', voiceSessionId: 'voice-1' });
    expect(f.request).not.toHaveBeenCalled();
    f.event({ type: 'responseStarted', turnId: 'turn-2' });
    await f.invoke(RealtimeVoiceIpc.Interrupt, { requestId: 'request-1', voiceSessionId: 'voice-1', turnId: 'turn-1' });
    expect(f.request.mock.calls.some(([method]) => method === 'talk.session.cancelOutput')).toBe(false);
    await f.invoke(RealtimeVoiceIpc.Interrupt, { requestId: 'request-1', voiceSessionId: 'voice-1', turnId: 'turn-2' });
    expect(f.request).toHaveBeenCalledWith('talk.session.cancelOutput', { sessionId: 'voice-1', turnId: 'turn-2' }, { timeoutMs: 5000 });
    await f.invoke(RealtimeVoiceIpc.AcknowledgeMark, { requestId: 'request-1', voiceSessionId: 'voice-1', markName: 'not-issued' });
    expect(f.request.mock.calls.filter(([method]) => method === 'talk.session.acknowledgeMark')).toHaveLength(0);
  });
  it('closes a late creation after its pending request was cancelled', async () => {
    const f = fixture(); const creation = deferred<unknown>();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(method => method === 'talk.session.create' ? creation.promise : original(method));
    const starting = f.start(); await flush();
    await f.invoke(RealtimeVoiceIpc.Close, { requestId: 'request-1' });
    creation.resolve(f.result);
    await expect(starting).rejects.toThrow();
    expect(f.request).toHaveBeenCalledWith('talk.session.close', { sessionId: 'voice-1' }, { timeoutMs: 5000 });
  });
  it('does not prepare or create a conversation when cancelled during the readiness query', async () => {
    const f = fixture(); const catalog = deferred<unknown>();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(method => method === 'talk.catalog' ? catalog.promise : original(method));
    const starting = f.start(); await flush();
    await f.invoke(RealtimeVoiceIpc.Close, { requestId: 'request-1' });
    catalog.resolve({ realtime: { providers: [{ id: 'openai', configured: true }] } });
    await expect(starting).rejects.toThrow();
    expect(f.prepareSession).not.toHaveBeenCalled();
    expect(f.request.mock.calls.some(([method]) => method === 'talk.session.create')).toBe(false);
  });
  it('keeps unknown creation occupied until the gateway generation changes, without retrying', async () => {
    const f = fixture(); const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(method => method === 'talk.session.create' ? Promise.reject(new Error('timeout')) : original(method));
    await expect(f.start()).rejects.toThrow('outcome is unknown');
    await expect(f.start()).rejects.toThrow('already active or unresolved');
    expect(f.request.mock.calls.filter(([method]) => method === 'talk.session.create')).toHaveLength(1);
    await expect(f.invoke(RealtimeVoiceIpc.GetStatus)).resolves.toMatchObject({ available: false, reason: 'unknown' });
    f.changeGeneration();
    await expect(f.invoke(RealtimeVoiceIpc.GetStatus)).resolves.toMatchObject({ available: true });
  });
  it('rejects old native events after conversation identity replacement or navigation', async () => {
    const f = fixture(); await f.start(); f.changeSource();
    f.event({ type: 'transcript', role: 'user', text: 'late', final: true });
    expect(f.owner.send.mock.calls.some(([, event]) => event.type === 'transcript')).toBe(false);
    expect(f.request).toHaveBeenCalledWith('talk.session.close', { sessionId: 'voice-1' }, { timeoutMs: 5000 });
  });
  it('never dispatches an old session close through a replacement gateway connection', async () => {
    const f = fixture(); await f.start(); f.request.mockClear(); f.changeGeneration();
    f.event({ type: 'audio', audioBase64: 'AAA=' }); await flush();
    expect(f.owner.send).toHaveBeenCalledWith(RealtimeVoiceIpc.Event,
      expect.objectContaining({ type: 'close', reason: 'connection-changed' }));
    expect(f.request).not.toHaveBeenCalled();
  });

  it('returns and forwards only the exact Main-prepared native source, including explicit close', async () => {
    const f = fixture();
    await expect(f.start()).resolves.toMatchObject({ source });
    f.event({ type: 'transcript', role: 'assistant', text: 'native text', source: { sessionKey: 'forged' }, final: false });
    expect(f.owner.send).toHaveBeenCalledWith(RealtimeVoiceIpc.Event,
      expect.objectContaining({ source, type: 'transcript', text: 'native text' }));
    await f.invoke(RealtimeVoiceIpc.Close, { requestId: 'request-1', voiceSessionId: 'voice-1' });
    expect(f.owner.send).toHaveBeenCalledWith(RealtimeVoiceIpc.Event,
      expect.objectContaining({ source, type: 'close', reason: 'completed' }));
  });

  it('releases the call when its captured transport rejects close synchronously', async () => {
    const f = fixture(); await f.start(); const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((method, params) => {
      if (method === 'talk.session.close') throw new Error('retired transport');
      return original(method, params);
    });
    await expect(f.invoke(RealtimeVoiceIpc.Close, { requestId: 'request-1', voiceSessionId: 'voice-1' })).resolves.toBeUndefined();
    await expect(f.invoke(RealtimeVoiceIpc.GetStatus)).resolves.toMatchObject({ available: true });
  });

  it('admits each native consult once and returns only its exact native chat result to the relay', async () => {
    const f = fixture(); await f.start();
    f.toolCall(); f.toolCall(); await flush();
    expect(f.request.mock.calls.filter(([method]) => method === 'talk.client.toolCall')).toHaveLength(1);
    expect(f.request).toHaveBeenCalledWith('talk.client.toolCall', {
      sessionKey: source.sessionKey, voiceSessionId: 'voice-1', relaySessionId: 'voice-1',
      callId: 'call-1', name: 'openclaw_agent_consult', args: { question: 'Check this request.' },
    }, { timeoutMs: 15_000 });
    const message = { role: 'assistant', content: [{ type: 'text', text: 'native answer' }] };
    f.chat({ state: 'final', runId: 'other-run', message });
    f.chat({ state: 'final', sessionKey: 'agent:main:other', runId: 'consult-1', message });
    expect(f.request.mock.calls.some(([method]) => method === 'talk.session.submitToolResult')).toBe(false);
    f.chat({ state: 'final', runId: 'consult-1', message });
    f.chat({ state: 'final', runId: 'consult-1', message }); await flush();
    expect(f.request).toHaveBeenCalledWith('talk.session.submitToolResult', {
      sessionId: 'voice-1', callId: 'call-1', result: { result: 'native answer' },
    }, { timeoutMs: 15_000 });
    expect(f.request.mock.calls.filter(([method]) => method === 'talk.session.submitToolResult')).toHaveLength(1);
    expect(f.request.mock.calls.some(([method]) => method === 'chat.send')).toBe(false);
    expect(f.owner.send.mock.calls.some(([, event]) => event.type === 'toolCall')).toBe(false);
  });

  it('routes native controls once through the owned public session and preserves the bounded result', async () => {
    const f = fixture(); await f.start(); const original = f.request.getMockImplementation()!;
    const result = { ok: true, mode: 'status', sessionKey: source.sessionKey, active: true,
      message: 'Native progress.', speak: true, show: true, suppress: false };
    f.request.mockImplementation((method, params) => method === 'talk.session.steer'
      ? Promise.resolve(result) : original(method, params));
    const event = { type: 'toolCall', callId: 'control-1', name: 'openclaw_agent_control',
      args: JSON.stringify({ message: ' Check progress. ' }), talkEvent: { turnId: 'turn-1' } };
    f.event(event); f.event(event); f.toolCall('control-1'); await flush();
    expect(f.request.mock.calls.filter(([method]) => method === 'talk.session.steer')).toHaveLength(1);
    expect(f.request).toHaveBeenCalledWith('talk.session.steer', {
      sessionId: 'voice-1', sessionKey: source.sessionKey, text: 'Check progress.',
    }, { timeoutMs: 15000 });
    expect(f.request).toHaveBeenCalledWith('talk.session.submitToolResult', {
      sessionId: 'voice-1', callId: 'control-1', result,
    }, { timeoutMs: 15000 });
    expect(f.request.mock.calls.some(([method]) => method === 'talk.client.toolCall' || method === 'chat.send')).toBe(false);
    expect(f.owner.send.mock.calls.some(([, event]) => event.type === 'toolCall')).toBe(false);
  });

  it('delivers a cancel control after its native clear retires the consultation in the same turn', async () => {
    const f = fixture(); await f.start(); f.toolCall(); await flush();
    const original = f.request.getMockImplementation()!; const response = deferred<unknown>();
    f.request.mockImplementation((method, params) => method === 'talk.session.steer' ? response.promise : original(method, params));
    f.event({ type: 'toolCall', callId: 'control-cancel', name: 'openclaw_agent_control',
      args: { text: 'Cancel that.', mode: 'cancel' }, talkEvent: { turnId: 'turn-1' } });
    f.event({ type: 'clear', talkEvent: { type: 'turn.cancelled', turnId: 'turn-1' } });
    f.chat({ state: 'final', runId: 'consult-1', message: { role: 'assistant', content: 'Retired answer.' } });
    const result = { ok: true, mode: 'cancel', sessionKey: source.sessionKey, active: false,
      aborted: true, message: 'Native cancellation.', speak: false, show: true, suppress: true };
    response.resolve(result); await flush();
    expect(f.request.mock.calls.filter(([method]) => method === 'talk.session.submitToolResult'))
      .toEqual([['talk.session.submitToolResult', { sessionId: 'voice-1', callId: 'control-cancel', result }, { timeoutMs: 15000 }]]);
    expect(f.request).toHaveBeenCalledWith('talk.session.steer', {
      sessionId: 'voice-1', sessionKey: source.sessionKey, text: 'Cancel that.', mode: 'cancel',
    }, { timeoutMs: 15000 });
  });

  it('answers unsupported calls and invalid control modes once without reflecting private fields', async () => {
    const f = fixture(); await f.start(); f.request.mockClear();
    const unsupported = { type: 'toolCall', callId: 'unknown-1', name: 'private-native-name', args: { text: 'private-native-args' } };
    f.event(unsupported); f.event(unsupported);
    f.event({ type: 'toolCall', callId: 'invalid-control', name: 'openclaw_agent_control', args: { text: 'Request', mode: 'invented-mode' } });
    await flush();
    const submissions = f.request.mock.calls.filter(([method]) => method === 'talk.session.submitToolResult');
    expect(submissions).toHaveLength(2);
    expect(submissions.every(([, params]) => typeof (params as { result: { error: unknown } }).result.error === 'string')).toBe(true);
    expect(JSON.stringify(submissions)).not.toContain('private-native-');
    expect(f.request.mock.calls.some(([method]) => method === 'talk.session.steer' || method === 'talk.client.toolCall')).toBe(false);
  });

  it('does not submit retired control results or close through a replacement connection', async () => {
    const f = fixture(); await f.start(); const original = f.request.getMockImplementation()!;
    const first = deferred<unknown>(); const second = deferred<unknown>();
    f.request.mockImplementation((method, params) => method === 'talk.session.steer'
      ? (params as { text: string }).text === 'First' ? first.promise : second.promise : original(method, params));
    f.event({ type: 'toolCall', callId: 'first-control', name: 'openclaw_agent_control', args: { text: 'First', mode: 'status' } });
    f.event({ type: 'toolCallCancelled', callId: 'first-control' }); first.resolve({ ok: true }); await flush();
    f.event({ type: 'toolCall', callId: 'second-control', name: 'openclaw_agent_control', args: { text: 'Second', mode: 'steer' } });
    f.changeGeneration(); second.resolve({ ok: true }); await flush();
    expect(f.request.mock.calls.some(([method]) => method === 'talk.session.submitToolResult' || method === 'talk.session.close')).toBe(false);
  });

  it('closes a known relay after an unknown control ACK without repeating the control or its private error', async () => {
    const f = fixture(); await f.start(); const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((method, params) => method === 'talk.session.steer'
      ? Promise.reject(new Error('private-native-error')) : original(method, params));
    const event = { type: 'toolCall', callId: 'uncertain-control', name: 'openclaw_agent_control', args: { text: 'Follow up.', mode: 'followup' } };
    f.event(event); await flush(); f.event(event);
    expect(f.request.mock.calls.filter(([method]) => method === 'talk.session.steer')).toHaveLength(1);
    expect(f.request.mock.calls.filter(([method]) => method === 'talk.session.close')).toHaveLength(1);
    expect(f.request.mock.calls.some(([method]) => method === 'talk.session.submitToolResult')).toBe(false);
    expect(JSON.stringify(f.owner.send.mock.calls)).not.toContain('private-native-error');
  });

  it('rejects an oversized native control result before submitting it to the provider', async () => {
    const f = fixture(); await f.start(); const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((method, params) => method === 'talk.session.steer'
      ? Promise.resolve({ message: 'x'.repeat(10_001) }) : original(method, params));
    f.event({ type: 'toolCall', callId: 'large-control', name: 'openclaw_agent_control', args: { text: 'Status', mode: 'status' } });
    await flush();
    expect(f.request.mock.calls.some(([method]) => method === 'talk.session.submitToolResult')).toBe(false);
    expect(f.request).toHaveBeenCalledWith('talk.session.close', { sessionId: 'voice-1' }, { timeoutMs: 5000 });
  });

  it('claims early native results by acknowledged run identity independently for concurrent calls', async () => {
    const f = fixture(); await f.start(); const original = f.request.getMockImplementation()!;
    const first = deferred<unknown>(); const second = deferred<unknown>();
    f.request.mockImplementation((method, params) => method === 'talk.client.toolCall'
      ? ((params as { callId: string }).callId === 'call-a' ? first.promise : second.promise) : original(method, params));
    f.toolCall('call-a'); f.toolCall('call-b');
    f.chat({ state: 'final', runId: 'run-b', message: { role: 'assistant', content: 'answer b' } });
    f.chat({ state: 'final', runId: 'run-a', message: { role: 'assistant', content: 'answer a' } });
    second.resolve({ runId: 'run-b', agentSessionKey: source.sessionKey });
    first.resolve({ runId: 'run-a', agentSessionKey: source.sessionKey }); await flush();
    const submitted = f.request.mock.calls.filter(([method]) => method === 'talk.session.submitToolResult').map(([, params]) => params);
    expect(submitted).toEqual(expect.arrayContaining([
      { sessionId: 'voice-1', callId: 'call-a', result: { result: 'answer a' } },
      { sessionId: 'voice-1', callId: 'call-b', result: { result: 'answer b' } },
    ]));
    expect(submitted).toHaveLength(2);
  });

  it('ignores unrelated large results and waits through empty finals for the exact native answer', async () => {
    const f = fixture(); await f.start(); f.toolCall(); await flush();
    f.chat({ state: 'final', runId: 'other-run', message: { role: 'assistant', content: 'x'.repeat(10_001) } });
    f.chat({ state: 'final', runId: 'consult-1' });
    expect(f.request.mock.calls.some(([method]) => method === 'talk.session.submitToolResult' || method === 'talk.session.close')).toBe(false);
    f.chat({ state: 'final', runId: 'consult-1', message: { role: 'assistant', content: 'actual native final' } }); await flush();
    expect(f.request).toHaveBeenCalledWith('talk.session.submitToolResult', {
      sessionId: 'voice-1', callId: 'call-1', result: { result: 'actual native final' },
    }, { timeoutMs: 15_000 });
  });

  it('bounds pending native call identities before launching another consultation', async () => {
    const f = fixture(); await f.start(); const original = f.request.getMockImplementation()!;
    const ack = deferred<unknown>();
    f.request.mockImplementation((method, params) => method === 'talk.client.toolCall' ? ack.promise : original(method, params));
    for (let index = 0; index < 5; index += 1) f.toolCall(`call-${index}`);
    await flush();
    expect(f.request.mock.calls.filter(([method]) => method === 'talk.client.toolCall')).toHaveLength(4);
    expect(f.request.mock.calls.filter(([method]) => method === 'talk.session.close')).toHaveLength(1);
    expect(f.request.mock.calls.some(([method]) => method === 'talk.session.submitToolResult')).toBe(false);
  });

  it('never retries an unknown consultation launch or leaks its native error response', async () => {
    const f = fixture(); await f.start(); const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((method, params) => method === 'talk.client.toolCall'
      ? Promise.reject(new Error('private native response')) : original(method, params));
    f.toolCall(); await flush(); f.toolCall();
    expect(f.request.mock.calls.filter(([method]) => method === 'talk.client.toolCall')).toHaveLength(1);
    expect(f.request.mock.calls.some(([method]) => method === 'talk.session.submitToolResult')).toBe(false);
    expect(f.request).toHaveBeenCalledWith('talk.session.close', { sessionId: 'voice-1' }, { timeoutMs: 5000 });
    expect(JSON.stringify(f.owner.send.mock.calls)).not.toContain('private native response');
  });

  it('fences pending consultations after connection replacement and native cancellation', async () => {
    const f = fixture(); await f.start();
    f.toolCall(); await flush();
    f.event({ type: 'toolCallCancelled', callId: 'call-1' });
    f.chat({ state: 'final', runId: 'consult-1', message: { role: 'assistant', content: 'late cancelled answer' } });
    expect(f.request.mock.calls.some(([method]) => method === 'talk.session.submitToolResult')).toBe(false);
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((method, params) => method === 'talk.client.toolCall'
      ? Promise.resolve({ runId: 'consult-2', agentSessionKey: source.sessionKey }) : original(method, params));
    f.toolCall('call-2'); await flush(); f.request.mockClear(); f.changeGeneration();
    f.chat({ state: 'final', runId: 'consult-2', message: { role: 'assistant', content: 'late old connection' } }); await flush();
    expect(f.request).not.toHaveBeenCalled();
  });

  it('bounds an unacknowledged launch and closes its known relay without sending another launch', async () => {
    vi.useFakeTimers();
    const f = fixture(); await f.start(); const original = f.request.getMockImplementation()!;
    const ack = deferred<unknown>();
    f.request.mockImplementation((method, params) => method === 'talk.client.toolCall' ? ack.promise : original(method, params));
    f.toolCall();
    await vi.advanceTimersByTimeAsync(15_000);
    ack.resolve({ runId: 'late-run', agentSessionKey: source.sessionKey }); await flush();
    expect(f.request.mock.calls.filter(([method]) => method === 'talk.client.toolCall')).toHaveLength(1);
    expect(f.request.mock.calls.some(([method]) => method === 'talk.session.submitToolResult')).toBe(false);
    expect(f.request).toHaveBeenCalledWith('talk.session.close', { sessionId: 'voice-1' }, { timeoutMs: 5000 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects an ACK for another conversation instead of delivering its result', async () => {
    const f = fixture(); await f.start(); const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((method, params) => method === 'talk.client.toolCall'
      ? Promise.resolve({ runId: 'consult-1', agentSessionKey: 'agent:main:other' }) : original(method, params));
    f.toolCall(); await flush();
    expect(f.request.mock.calls.some(([method]) => method === 'talk.session.submitToolResult')).toBe(false);
    expect(f.owner.send).toHaveBeenCalledWith(RealtimeVoiceIpc.Event,
      expect.objectContaining({ type: 'close', reason: 'error', source }));
  });
});
