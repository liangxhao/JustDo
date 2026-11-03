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

import { OnlineAsrIpc } from '../../../shared/speech/onlineAsr';
import { EXTENSION_SECRET_PROVIDER } from '../../plugins/extensions/extensionSecretFile';
import { registerOnlineAsrHandlers } from './onlineAsr';

const profile = () => ({ baseUrl: 'wss://speech.internal/v1', model: 'internal-asr', apiKey: '' });
const nativeConfig = (transcription: unknown = profile()) => ({
  plugins: { entries: { openai: { config: { transcription } } } },
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
  const getModelCategory = vi.fn();
  const send = vi.fn();
  const sender = { isDestroyed: () => false, once: vi.fn(), send };
  let stateDir: string;
  const register = (runConfigMutationExclusive?: <T>(operation: () => Promise<T>) => Promise<T>) =>
    registerOnlineAsrHandlers({
      getRuntime: () => runtime as never,
      getModelCategory,
      getStateDir: () => stateDir,
      requestGateway,
      runConfigMutationExclusive,
    });
  const invoke = (channel: string, ...args: unknown[]) =>
    handlers.get(channel)?.(...(args as never[]));
  const mockReady = () => {
    requestGateway.mockImplementation((method: string) => {
      if (method === 'talk.catalog') return Promise.resolve(catalog());
      if (method === 'config.get')
        return Promise.resolve({ hash: 'config-hash', config: nativeConfig() });
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
    requestGateway.mockReset();
    getModelCategory.mockReset().mockReturnValue(category());
    send.mockReset();
    sender.once.mockReset();
    runtime.removeAllListeners();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-ipc-'));
    register();
  });
  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('does not invent providers or models when no transcription plugin is registered', async () => {
    requestGateway
      .mockResolvedValueOnce({ transcription: { ready: false, providers: [] } })
      .mockResolvedValueOnce({ config: {} });
    expect(await invoke(OnlineAsrIpc.GetConfiguration)).toEqual({
      available: false,
      providers: [],
      credentialConfigured: false,
    });
  });

  it('reports the explicit OpenAI profile without a phone plugin or exposing credentials', async () => {
    mockReady();
    await expect(invoke(OnlineAsrIpc.GetStatus)).resolves.toEqual({
      available: true,
      provider: 'openai',
    });
    await expect(invoke(OnlineAsrIpc.GetConfiguration)).resolves.toEqual({
      available: true,
      provider: 'openai',
      selectedProvider: 'openai',
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

  it('does not borrow a registered preset or a legacy phone configuration', async () => {
    requestGateway.mockResolvedValueOnce(catalog()).mockResolvedValueOnce({
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
        config: nativeConfig(transcription),
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
    models.providers.office.baseUrl = '  wss://speech.internal/v1/?route=/  ';
    getModelCategory.mockReturnValue(models);
    mockReady();

    await invoke(OnlineAsrIpc.SaveConfiguration, { sender }, { modelRef: 'office/internal-asr' });

    expect(publishedPatch().plugins.entries.openai.config.transcription.baseUrl).toBe(
      'wss://speech.internal/v1/?route=/',
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
});
