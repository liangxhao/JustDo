import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: never[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: never[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));
vi.mock('../../openclaw/config/models/providerSecretFile', () => ({
  restrictCredentialFile: vi.fn(),
}));

import { normalizeLocalSpeechSettings } from '../../../shared/speech/localSpeechSettings';
import { OnlineAsrIpc } from '../../../shared/speech/onlineAsr';
import { buildSpeechCredentialSlot } from '../../openclaw/config/speech/speechCredentialSlot';
import { EXTENSION_SECRET_PROVIDER, saveExtensionSecrets } from '../../plugins/extensions/extensionSecretFile';
import { advanceSpeechConfigurationRevision } from '../../speech/speechConfigurationRevision';
import { registerOnlineAsrHandlers } from './onlineAsr';

const profile = () => ({ baseUrl: 'wss://speech.internal/v1', model: 'internal-asr', apiKey: '',
  configurationId: buildSpeechCredentialSlot('composerAsr', 'wss://speech.internal/v1', '') });
const nativeConfig = (transcription: unknown = profile()) => ({
  plugins: { entries: { openai: { config: { transcription } } } },
});
const nativeSnapshot = (config: unknown = nativeConfig()) => ({
  hash: 'config-hash',
  configRevisionHash: 'applied-revision',
  appliedConfigHash: 'applied-revision',
  config,
});
const catalog = () => ({
  transcription: {
    ready: true,
    activeProvider: 'openai',
    providers: [{ id: 'openai', label: 'OpenAI', configured: true }],
  },
});
const category = () => ({
  providers: {
    office: {
      displayName: 'Office',
      baseUrl: 'wss://speech.internal/v1',
      apiKey: 'recognition-secret',
      models: [{ id: 'internal-asr', name: 'Recognition' }],
    },
  },
});

describe('OpenClaw online transcription IPC', () => {
  const runtime = new EventEmitter();
  const requestGateway = vi.fn();
  const initialClient = { request: (method: string, params?: unknown) => requestGateway(method, params) };
  let client = initialClient;
  let generation = 1;
  Object.assign(runtime, {
    getGatewayClient: () => client,
    getGatewayClientGeneration: () => generation,
    captureGatewayResponseContext: () => {
      const captured = client;
      const capturedGeneration = generation;
      return { isCurrent: () => captured === client && capturedGeneration === generation,
        isResponseError: (error: { code?: string }) => error?.code === 'NATIVE_RESPONSE' };
    },
  });
  const getModelCategory = vi.fn();
  const send = vi.fn();
  const sender = { isDestroyed: () => false, getType: () => 'window', mainFrame: {}, once: vi.fn(), removeListener: vi.fn(), send };
  let stateDir: string;
  const register = (runConfigMutationExclusive?: <T>(operation: () => Promise<T>) => Promise<T>, getSettings?: () => ReturnType<typeof normalizeLocalSpeechSettings>) =>
    registerOnlineAsrHandlers({
      getRuntime: () => runtime as never,
      getModelCategory,
      getStateDir: () => stateDir,
      requestGateway,
      runConfigMutationExclusive,
      ...(getSettings ? { getSettings } : {}),
    });
  const invoke = (channel: string, ...args: unknown[]) => {
    const event = args[0] as { sender?: typeof sender; senderFrame?: unknown } | undefined;
    if (event?.sender === sender && !('senderFrame' in event)) event.senderFrame = sender.mainFrame;
    return handlers.get(channel)?.(...(args as never[]));
  };
  const mockReady = () => {
    requestGateway.mockImplementation((method: string) => {
      if (method === 'talk.catalog') return Promise.resolve(catalog());
      if (method === 'config.get')
        return Promise.resolve(nativeSnapshot());
      return Promise.resolve({
        sessionId: 'talk-1',
        transcriptionSessionId: 'transcription-1',
        provider: 'openai',
        audio: { inputEncoding: 'g711_ulaw', inputSampleRateHz: 8000 },
      });
    });
  };
  const publishedPatch = () => {
    const patch = requestGateway.mock.calls.find(([method]) => method === 'config.patch');
    return JSON.parse((patch?.[1] as { raw: string }).raw);
  };

  beforeEach(() => {
    handlers.clear();
    client = initialClient;
    requestGateway.mockReset();
    getModelCategory.mockReset().mockReturnValue(category());
    send.mockReset();
    sender.once.mockReset();
    runtime.removeAllListeners();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-ipc-'));
    register();
  });
  afterEach(() => {
    generation += 1;
    for (const [event, callback] of sender.once.mock.calls)
      if (event === 'destroyed') callback();
    vi.useRealTimers();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('does not invent providers or models when no transcription plugin is registered', async () => {
    requestGateway
      .mockResolvedValueOnce({ transcription: { ready: false, providers: [] } })
      .mockResolvedValueOnce(nativeSnapshot({}));
    expect(await invoke(OnlineAsrIpc.GetConfiguration)).toEqual({
      available: false,
      providers: [],
      credentialConfigured: false,
      inputMode: 'realtime',
    });
  });

  it('reports the explicit OpenAI profile without a phone plugin or exposing credentials', async () => {
    mockReady();
    await expect(invoke(OnlineAsrIpc.GetStatus)).resolves.toEqual({
      available: true,
      provider: 'openai',
      inputMode: 'realtime',
    });
    await expect(invoke(OnlineAsrIpc.GetConfiguration)).resolves.toEqual({
      available: true,
      provider: 'openai',
      selectedProvider: 'openai',
      inputMode: 'realtime',
      providers: [{ id: 'openai', label: 'OpenAI', configured: true }],
      baseUrl: 'wss://speech.internal/v1',
      model: 'internal-asr',
      credentialConfigured: false,
    });
  });

  it('pins OpenAI even when an unrelated provider is the catalog default', async () => {
    mockReady();
    const ready = requestGateway.getMockImplementation()!;
    requestGateway.mockImplementation((method: string) =>
      method === 'talk.catalog'
        ? Promise.resolve({
            transcription: { ...catalog().transcription, activeProvider: 'external', ready: false },
          })
        : ready(method),
    );
    await expect(invoke(OnlineAsrIpc.GetStatus)).resolves.toMatchObject({ available: true });
  });

  it.each([
    { configRevisionHash: undefined, appliedConfigHash: undefined },
    { configRevisionHash: '', appliedConfigHash: '' },
    { configRevisionHash: 'saved-b', appliedConfigHash: 'active-a' },
  ])('rejects status and start without a matching applied native revision (%j)', async revisions => {
    getModelCategory.mockReturnValue(keylessCategory());
    register(undefined, productionSettings);
    mockReady();
    const ready = requestGateway.getMockImplementation()!;
    requestGateway.mockImplementation((method: string) => method === 'config.get'
      ? Promise.resolve({ ...nativeSnapshot(), ...revisions }) : ready(method));

    await expect(invoke(OnlineAsrIpc.GetStatus)).resolves.toMatchObject({ available: false });
    await expect(invoke(OnlineAsrIpc.GetConfiguration)).resolves.toMatchObject({ available: false });
    await expect(invoke(OnlineAsrIpc.Start, { sender }, { language: 'auto' })).rejects.toThrow('have not finished applying');
    expect(requestGateway.mock.calls.some(([method]) => method === 'talk.session.create')).toBe(false);
  });

  it('does not borrow a registered preset or a legacy phone configuration', async () => {
    requestGateway.mockResolvedValueOnce(catalog()).mockResolvedValueOnce({
      ...nativeSnapshot(),
      config: {
        plugins: {
          entries: {
            'voice-call': {
              config: { streaming: { provider: 'openai', providers: { openai: profile() } } },
            },
          },
        },
      },
    });
    const result = await invoke(OnlineAsrIpc.GetConfiguration);
    expect(result).toMatchObject({ available: false, credentialConfigured: false });
    expect(result).not.toHaveProperty('model');
  });

  it.each([null, { ...profile(), model: '' }, { ...profile(), baseUrl: 'file:///audio' }])(
    'rejects absent or invalid native profiles (%j)',
    async transcription => {
      requestGateway.mockResolvedValueOnce(catalog()).mockResolvedValueOnce({
        ...nativeSnapshot(nativeConfig(transcription)),
      });
      await expect(invoke(OnlineAsrIpc.Start, { sender }, { language: 'zh' })).rejects.toThrow(
        'Online transcription service is not configured for intranet use.',
      );
      expect(requestGateway).not.toHaveBeenCalledWith('talk.session.create', expect.anything());
    },
  );

  it('returns no fallback catalog when Gateway is unavailable', async () => {
    requestGateway.mockRejectedValue(new Error('Unavailable'));
    await expect(invoke(OnlineAsrIpc.GetConfiguration)).resolves.toMatchObject({
      available: false,
      providers: [],
      credentialConfigured: false,
    });
  });

  it.each(['model', 'endpoint'] as const)(
    'keeps the microphone unavailable with a missing %s before contacting Gateway', async missing => {
      const modelId = missing === 'model' ? '' : 'custom/transcriber';
      getModelCategory.mockReturnValue({ providers: { office: {
        displayName: 'Office', apiKey: '', protocolId: 'openai-transcription-http',
        baseUrl: missing === 'endpoint' ? 'http://speech.internal/v1/audio/speech' : 'http://speech.internal/v1',
        models: [{ id: modelId, name: 'Configured model' }],
      } } });
      const settings = normalizeLocalSpeechSettings({ inputEnabled: true, recognitionMode: 'online', onlineAsrModelRef: `office/${modelId}` });
      register(undefined, () => settings);
      await expect(invoke(OnlineAsrIpc.GetStatus)).resolves.toMatchObject({ available: false });
      await expect(invoke(OnlineAsrIpc.Start, { sender }, { language: 'zh' })).rejects.toThrow();
      expect(requestGateway).not.toHaveBeenCalled();
    },
  );

  it.each([
    {},
    { modelRef: '' },
    { modelRef: 'office/internal-asr', baseUrl: 'https://untrusted.internal' },
    { modelRef: 'office/internal-asr', apiKey: 'renderer-secret' },
  ])('rejects malformed requests and renderer-owned credentials (%j)', async update => {
    await expect(invoke(OnlineAsrIpc.SaveConfiguration, { sender }, update)).rejects.toThrow(
      'Invalid online transcription configuration.',
    );
    expect(requestGateway).not.toHaveBeenCalled();
  });

  it('rejects a deleted catalog selection before contacting Gateway', async () => {
    getModelCategory.mockReturnValue({ providers: {} });
    await expect(
      invoke(
        OnlineAsrIpc.SaveConfiguration,
        { sender },
        {
          modelRef: 'office/internal-asr',
        },
      ),
    ).rejects.toThrow('The selected online transcription model is unavailable.');
    expect(requestGateway).not.toHaveBeenCalled();
  });

  it('rejects saving when the native adapter is absent', async () => {
    requestGateway.mockResolvedValueOnce({ transcription: { providers: [] } });
    await expect(
      invoke(
        OnlineAsrIpc.SaveConfiguration,
        { sender },
        {
          modelRef: 'office/internal-asr',
        },
      ),
    ).rejects.toThrow('Unknown online transcription provider.');
    expect(requestGateway).not.toHaveBeenCalledWith('config.patch', expect.anything());
  });

  it('resolves catalog credentials in Main and patches a scoped secret reference', async () => {
    mockReady();
    await invoke(OnlineAsrIpc.SaveConfiguration, { sender }, { modelRef: 'office/internal-asr' });
    const patch = publishedPatch();
    expect(patch.plugins.entries).toEqual({
      openai: {
        enabled: true,
        config: {
          transcription: {
            ...profile(),
            protocolId: 'openai-transcription-realtime',
            configurationId: expect.any(String),
            apiKey: { source: 'file', provider: EXTENSION_SECRET_PROVIDER, id: expect.any(String) },
          },
        },
      },
    });
    expect(patch.secrets.providers[EXTENSION_SECRET_PROVIDER]).toMatchObject({
      source: 'file',
      mode: 'json',
      path: path.join(stateDir, 'extension-secrets.json'),
    });
    expect(JSON.stringify(patch)).not.toContain('recognition-secret');
    expect(requestGateway).toHaveBeenCalledWith('config.patch', {
      baseHash: 'config-hash',
      raw: expect.any(String),
    });
    const stored = JSON.parse(
      fs.readFileSync(path.join(stateDir, 'extension-secrets.json'), 'utf8'),
    );
    expect(Object.values(stored)).toEqual(['recognition-secret']);
  });

  it('supports keyless services without a synthetic key', async () => {
    const models = category();
    models.providers.office.apiKey = '';
    getModelCategory.mockReturnValue(models);
    mockReady();
    await invoke(OnlineAsrIpc.SaveConfiguration, { sender }, { modelRef: 'office/internal-asr' });
    expect(publishedPatch().plugins.entries.openai.config.transcription.apiKey).toBe('');
    expect(publishedPatch()).not.toHaveProperty('secrets');
    expect(fs.existsSync(path.join(stateDir, 'extension-secrets.json'))).toBe(false);
  });

  it('preserves the configured endpoint path and query when publishing the profile', async () => {
    const models = category();
    models.providers.office.baseUrl = '  wss://speech.internal/v1/realtime?intent=transcription  ';
    getModelCategory.mockReturnValue(models);
    mockReady();

    await invoke(OnlineAsrIpc.SaveConfiguration, { sender }, { modelRef: 'office/internal-asr' });

    expect(publishedPatch().plugins.entries.openai.config.transcription.baseUrl).toBe(
      'wss://speech.internal/v1/realtime?intent=transcription',
    );
  });

  it('does not rebind a published credential when a newer endpoint patch fails', async () => {
    mockReady();
    await invoke(OnlineAsrIpc.SaveConfiguration, { sender }, { modelRef: 'office/internal-asr' });
    const original = publishedPatch().plugins.entries.openai.config.transcription.apiKey;
    const changed = category();
    changed.providers.office.baseUrl = 'wss://changed.internal/v1';
    changed.providers.office.apiKey = 'rotated-secret';
    getModelCategory.mockReturnValue(changed);
    requestGateway.mockImplementation((method: string) => {
      if (method === 'talk.catalog') return Promise.resolve(catalog());
      if (method === 'config.get') return Promise.resolve({ hash: 'next-hash' });
      return Promise.reject(new Error('Patch failed'));
    });
    await expect(
      invoke(
        OnlineAsrIpc.SaveConfiguration,
        { sender },
        {
          modelRef: 'office/internal-asr',
        },
      ),
    ).rejects.toThrow('Patch failed');
    const stored = JSON.parse(
      fs.readFileSync(path.join(stateDir, 'extension-secrets.json'), 'utf8'),
    );
    expect(stored[original.id.slice(1)]).toBe('recognition-secret');
    expect(Object.values(stored)).toContain('rotated-secret');
  });

  it('resolves the current catalog inside the shared configuration mutation lock', async () => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => {
      release = resolve;
    });
    const exclusive = vi.fn(async <T>(operation: () => Promise<T>): Promise<T> => {
      await waiting;
      return operation();
    });
    register(exclusive);
    const saving = invoke(
      OnlineAsrIpc.SaveConfiguration,
      { sender },
      {
        modelRef: 'office/internal-asr',
      },
    );
    expect(getModelCategory).not.toHaveBeenCalled();
    getModelCategory.mockReturnValue({ providers: {} });
    release();
    await expect(saving).rejects.toThrow('The selected online transcription model is unavailable.');
    expect(exclusive).toHaveBeenCalledOnce();
    expect(requestGateway).not.toHaveBeenCalled();
  });

  it('creates an explicit transcription relay and forwards only its events', async () => {
    mockReady();
    await expect(invoke(OnlineAsrIpc.Start, { sender }, { language: 'zh' })).resolves.toMatchObject(
      {
        sessionId: 'talk-1',
        transcriptionSessionId: 'transcription-1',
        inputEncoding: 'g711_ulaw',
        inputSampleRateHz: 8000,
      },
    );
    expect(requestGateway).toHaveBeenCalledWith('talk.session.create', {
      mode: 'transcription',
      provider: 'openai',
      model: 'internal-asr',
      transport: 'gateway-relay',
      brain: 'none',
      language: 'zh',
    });
    runtime.emit('gatewayEvent', {
      event: 'talk.event',
      payload: { transcriptionSessionId: 'other', type: 'transcript', text: 'ignored' },
    });
    runtime.emit('gatewayEvent', {
      event: 'talk.event',
      payload: {
        transcriptionSessionId: 'transcription-1',
        type: 'transcript',
        text: '你好',
        final: true,
      },
    });
    expect(send).toHaveBeenCalledExactlyOnceWith(OnlineAsrIpc.Event, {
      transcriptionSessionId: 'transcription-1',
      type: 'transcript',
      text: '你好',
      final: true,
    });
  });

  it('rejects audio and close requests from a different renderer', async () => {
    mockReady();
    await invoke(OnlineAsrIpc.Start, { sender }, { language: 'auto' });
    await expect(
      invoke(OnlineAsrIpc.AppendAudio, { sender: {} }, 'talk-1', 'AQ=='),
    ).rejects.toThrow('Invalid online transcription audio request.');
    await invoke(OnlineAsrIpc.Close, { sender: {} }, 'talk-1');
    expect(requestGateway).not.toHaveBeenCalledWith('talk.session.close', expect.anything());
  });

  it('allows final transcripts after close until the exact native session closes', async () => {
    vi.useFakeTimers();
    mockReady();
    await invoke(OnlineAsrIpc.Start, { sender }, { language: 'auto' });
    await invoke(OnlineAsrIpc.Close, { sender }, 'talk-1');
    runtime.emit('gatewayEvent', {
      event: 'talk.event',
      payload: {
        transcriptionSessionId: 'transcription-1',
        type: 'transcript',
        text: 'Final',
        final: true,
      },
    });
    expect(send).toHaveBeenCalledOnce();
    runtime.emit('gatewayEvent', {
      event: 'talk.event',
      payload: { transcriptionSessionId: 'transcription-1', type: 'close' },
    });
    await expect(invoke(OnlineAsrIpc.AppendAudio, { sender }, 'talk-1', 'AQ==')).rejects.toThrow(
      'Invalid online transcription audio request.',
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes the owned native session when its renderer is destroyed', async () => {
    mockReady();
    await invoke(OnlineAsrIpc.Start, { sender }, { language: 'auto' });
    const destroyed = sender.once.mock.calls.find(([event]) => event === 'destroyed')?.[1];
    destroyed();
    expect(requestGateway).toHaveBeenCalledWith('talk.session.close', { sessionId: 'talk-1' });
    await expect(invoke(OnlineAsrIpc.AppendAudio, { sender }, 'talk-1', 'AQ==')).rejects.toThrow(
      'Invalid online transcription audio request.',
    );
  });

  it('clears only the composer profile under the shared configuration mutation lock', async () => {
    const exclusive = vi.fn(async <T>(operation: () => Promise<T>): Promise<T> => operation());
    register(exclusive);
    mockReady();
    await invoke(OnlineAsrIpc.ClearConfiguration, {});
    expect(publishedPatch()).toEqual({
      plugins: { entries: { openai: { config: { transcription: null } } } },
    });
    expect(exclusive).toHaveBeenCalledOnce();
  });

  const productionSettings = () => normalizeLocalSpeechSettings({ inputEnabled: true,
    recognitionMode: 'online', onlineAsrModelRef: 'office/internal-asr' });
  const keylessCategory = () => {
    const value = category(); value.providers.office.apiKey = ''; return value;
  };
  const nativeSession = () => ({ sessionId: 'talk-1', transcriptionSessionId: 'transcription-1',
    provider: 'openai', audio: { inputEncoding: 'g711_ulaw', inputSampleRateHz: 8000 } });

  it('requires the actually applied model and immutable credential revision before advertising or creating a session', async () => {
    register(undefined, productionSettings);
    const config = nativeConfig();
    const slot = buildSpeechCredentialSlot('composerAsr', profile().baseUrl, 'recognition-secret');
    const reference = saveExtensionSecrets(config, stateDir, 'openai', { [slot]: 'recognition-secret' }).references[slot];
    let applied: unknown = { ...profile(), model: 'stale-model', configurationId: slot, apiKey: reference };
    requestGateway.mockImplementation((method: string) => Promise.resolve(method === 'talk.catalog' ? catalog() :
      method === 'config.get' ? nativeSnapshot(nativeConfig(applied)) : nativeSession()));
    expect(await invoke(OnlineAsrIpc.GetStatus)).toMatchObject({ available: false });
    await expect(invoke(OnlineAsrIpc.Start, { sender }, { language: 'auto' })).rejects.toThrow('not configured');
    applied = { ...profile(), configurationId: slot, apiKey: { ...reference, id: '/old-credential' } };
    expect(await invoke(OnlineAsrIpc.GetStatus)).toMatchObject({ available: false });
    applied = { ...profile(), configurationId: slot, apiKey: { ...reference, id: '__OPENCLAW_REDACTED__' } };
    expect(await invoke(OnlineAsrIpc.GetStatus)).toMatchObject({ available: true });
    applied = { ...profile(), configurationId: 'old-revision', apiKey: { ...reference, id: '__OPENCLAW_REDACTED__' } };
    expect(await invoke(OnlineAsrIpc.GetStatus)).toMatchObject({ available: false });
    expect(requestGateway.mock.calls.filter(([method]) => method === 'talk.session.create')).toHaveLength(0);
  });

  it('reserves a pending owner and rejects A → B → A before submission without a second create', async () => {
    let settings = productionSettings();
    const models = keylessCategory();
    getModelCategory.mockReturnValue(models);
    register(undefined, () => settings);
    let release!: (value: unknown) => void;
    const catalogResult = new Promise(resolve => { release = resolve; });
    requestGateway.mockImplementation((method: string) => method === 'talk.catalog' ? catalogResult : Promise.resolve(nativeSnapshot()));
    const starting = invoke(OnlineAsrIpc.Start, { sender }, { language: 'auto' });
    await expect(invoke(OnlineAsrIpc.Start, { sender }, { language: 'auto' })).rejects.toThrow('already active');
    const previous = settings;
    settings = normalizeLocalSpeechSettings({ ...settings, inputEnabled: false });
    advanceSpeechConfigurationRevision({ voice: settings }, { voice: previous });
    settings = previous;
    advanceSpeechConfigurationRevision({ voice: previous }, { voice: { ...previous, inputEnabled: false } });
    release(catalog());
    await expect(starting).rejects.toThrow('configuration or connection changed');
    expect(requestGateway.mock.calls.some(([method]) => method === 'talk.session.create')).toBe(false);
  });

  it('does not close a stale create on an obsolete or replacement connection', async () => {
    mockReady();
    const ready = requestGateway.getMockImplementation()!;
    let release!: (value: unknown) => void;
    let creating!: () => void;
    const started = new Promise<void>(resolve => { creating = resolve; });
    const result = new Promise(resolve => { release = resolve; });
    requestGateway.mockImplementation((method: string) => {
      if (method === 'talk.session.create') { creating(); return result; }
      return ready(method);
    });
    const starting = invoke(OnlineAsrIpc.Start, { sender }, { language: 'auto' });
    await started;
    const replacementRequest = vi.fn();
    client = { request: replacementRequest };
    generation += 1;
    release(nativeSession());
    await expect(starting).rejects.toThrow('cancelled');
    expect(requestGateway.mock.calls.some(([method]) => method === 'talk.session.close')).toBe(false);
    expect(replacementRequest).not.toHaveBeenCalled();
  });

  it('closes a known stale configuration result exactly once while its captured connection is current', async () => {
    mockReady();
    const ready = requestGateway.getMockImplementation()!;
    let release!: (value: unknown) => void;
    let creating!: () => void;
    const started = new Promise<void>(resolve => { creating = resolve; });
    const result = new Promise(resolve => { release = resolve; });
    requestGateway.mockImplementation((method: string) => {
      if (method === 'talk.session.create') { creating(); return result; }
      return ready(method);
    });
    const starting = invoke(OnlineAsrIpc.Start, { sender }, { language: 'auto' });
    await started;
    advanceSpeechConfigurationRevision({ voice: { ...productionSettings(), inputLanguage: 'en' } }, { voice: productionSettings() });
    release(nativeSession());
    await expect(starting).rejects.toThrow('cancelled');
    expect(requestGateway.mock.calls.filter(([method]) => method === 'talk.session.close')).toHaveLength(1);
  });

  it('keeps an unknown create blocked until the connection changes, without blind retry or close', async () => {
    mockReady();
    const ready = requestGateway.getMockImplementation()!;
    requestGateway.mockImplementation((method: string) => method === 'talk.session.create'
      ? Promise.reject(new Error('transport lost after submission')) : ready(method));
    await expect(invoke(OnlineAsrIpc.Start, { sender }, { language: 'auto' })).rejects.toThrow('outcome is unknown');
    await expect(invoke(OnlineAsrIpc.Start, { sender }, { language: 'auto' })).rejects.toThrow('already active');
    expect(requestGateway.mock.calls.filter(([method]) => method === 'talk.session.create')).toHaveLength(1);
    expect(requestGateway.mock.calls.some(([method]) => method === 'talk.session.close')).toBe(false);
    generation += 1;
    mockReady();
    await expect(invoke(OnlineAsrIpc.Start, { sender }, { language: 'auto' })).resolves.toMatchObject({ sessionId: 'talk-1' });
  });

  it('releases a definitive native rejection without exposing its body or automatically retrying', async () => {
    mockReady();
    const ready = requestGateway.getMockImplementation()!;
    let rejectCreate = true;
    requestGateway.mockImplementation((method: string) => method === 'talk.session.create' && rejectCreate
      ? Promise.reject(Object.assign(new Error('provider response containing private fields'), { code: 'NATIVE_RESPONSE' })) : ready(method));
    await expect(invoke(OnlineAsrIpc.Start, { sender }, { language: 'auto' })).rejects.toThrow('Online transcription could not start.');
    expect(requestGateway.mock.calls.filter(([method]) => method === 'talk.session.create')).toHaveLength(1);
    rejectCreate = false;
    await expect(invoke(OnlineAsrIpc.Start, { sender }, { language: 'auto' })).resolves.toMatchObject({ sessionId: 'talk-1' });
  });

  it('recognizes a native close received before the create response and releases the owner', async () => {
    mockReady();
    const ready = requestGateway.getMockImplementation()!;
    let closeEarly = true;
    requestGateway.mockImplementation((method: string) => {
      if (method === 'talk.session.create' && closeEarly)
        runtime.emit('gatewayEvent', { event: 'talk.event', payload: { transcriptionSessionId: 'transcription-1', type: 'close' } });
      return ready(method);
    });
    await expect(invoke(OnlineAsrIpc.Start, { sender }, { language: 'auto' })).rejects.toThrow('closed before admission');
    closeEarly = false;
    await expect(invoke(OnlineAsrIpc.Start, { sender }, { language: 'auto' })).resolves.toMatchObject({ sessionId: 'talk-1' });
  });

  it('revokes active input on configuration changes and rejects stale connection events/audio', async () => {
    getModelCategory.mockReturnValue(keylessCategory());
    const settings = productionSettings();
    register(undefined, () => settings);
    mockReady();
    await invoke(OnlineAsrIpc.Start, { sender }, { language: 'auto' });
    advanceSpeechConfigurationRevision({ voice: { ...settings, inputLanguage: 'en' } }, { voice: settings });
    send.mockClear();
    runtime.emit('gatewayEvent', { event: 'talk.event', payload: { transcriptionSessionId: 'transcription-1', type: 'transcript', text: 'late result' } });
    expect(send).not.toHaveBeenCalled();
    await expect(invoke(OnlineAsrIpc.AppendAudio, { sender }, 'talk-1', 'AQ==')).rejects.toThrow('Invalid');
    expect(requestGateway).toHaveBeenCalledWith('talk.session.close', { sessionId: 'talk-1' });
    await invoke(OnlineAsrIpc.Start, { sender }, { language: 'auto' });
    const closesBeforeGeneration = requestGateway.mock.calls.filter(([method]) => method === 'talk.session.close').length;
    generation += 1;
    send.mockClear();
    runtime.emit('gatewayEvent', { event: 'talk.event', payload: { transcriptionSessionId: 'transcription-1', type: 'transcript', text: 'old connection' } });
    expect(send.mock.calls.some(([, event]) => event.type === 'transcript')).toBe(false);
    expect(requestGateway.mock.calls.filter(([method]) => method === 'talk.session.close')).toHaveLength(closesBeforeGeneration);
    await expect(invoke(OnlineAsrIpc.AppendAudio, { sender }, 'talk-1', 'AQ==')).rejects.toThrow('Invalid');
  });
});
