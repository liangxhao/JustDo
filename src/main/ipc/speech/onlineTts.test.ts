import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: never[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: never[]) => unknown) =>
      handlers.set(channel, handler),
    ),
  },
}));
vi.mock('../../plugins/extensions/extensionSecretFile', () => ({
  EXTENSION_SECRET_PROVIDER: 'test-extension-secrets',
  saveExtensionSecrets: vi.fn((config, _stateDir, _extensionId, values) => {
    config.secrets = {
      providers: {
        'test-extension-secrets': {
          source: 'file',
          path: 'private-state/extension-secrets.json',
          mode: 'json',
        },
      },
    };
    return {
      changed: true,
      references: Object.fromEntries(
        Object.keys(values).map(slot => [
          slot,
          { source: 'file', provider: 'test-extension-secrets', id: `/${slot}` },
        ]),
      ),
    };
  }),
}));

import { OnlineTtsIpc } from '../../../shared/speech/onlineTts';
import { saveExtensionSecrets } from '../../plugins/extensions/extensionSecretFile';
import { registerOnlineTtsHandlers } from './onlineTts';

describe('isolated online reply speech configuration', () => {
  const requestGateway = vi.fn();
  const runExclusive = vi.fn(async (operation: () => Promise<void>) => operation());
  let category: {
    providers: Record<
      string,
      {
        displayName: string;
        baseUrl: string;
        apiKey: string;
        models: Array<{ id: string; name: string; voices: Array<{ id: string; name: string }> }>;
      }
    >;
  };
  let nativeConfig: Record<string, unknown>;
  let providers: unknown[];

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    providers = [
      { id: 'openai', configured: false, models: ['vendor-default'], voices: ['vendor-voice'] },
    ];
    category = {
      providers: {
        internal: {
          displayName: 'Internal',
          baseUrl: 'http://speech.internal/v1',
          apiKey: 'private-key',
          models: [
            { id: 'tts/model', name: 'Internal TTS', voices: [{ id: 'voice-1', name: 'Voice' }] },
          ],
        },
      },
    };
    nativeConfig = {
      tts: {
        provider: 'tts-local-cli',
        providers: { 'tts-local-cli': { mode: 'online', model: 'assistant-model' } },
      },
    };
    requestGateway.mockImplementation(async method => {
      if (method === 'tts.providers') return { active: 'tts-local-cli', providers };
      if (method === 'config.get') return { hash: 'config-hash', config: nativeConfig };
      return { ok: true };
    });
    registerOnlineTtsHandlers({
      getRuntime: () => ({}) as never,
      getModelCategory: () => category,
      getStateDir: () => 'private-state',
      requestGateway,
      runConfigMutationExclusive: runExclusive,
    });
  });

  const save = (value: unknown = { modelRef: 'internal/tts/model', voice: 'voice-1' }) =>
    handlers.get(OnlineTtsIpc.SaveConfiguration)?.({} as never, value as never);
  const patch = () =>
    JSON.parse(requestGateway.mock.calls.find(call => call[0] === 'config.patch')![1].raw);

  it('resolves model identity in Main and publishes only the isolated read-aloud profile', async () => {
    await save();
    const published = patch();
    expect(published).not.toHaveProperty('tts');
    expect(published.plugins.entries['runtime-services'].config.replySpeech).toMatchObject({
      baseUrl: 'http://speech.internal/v1',
      model: 'tts/model',
      speakerVoice: 'voice-1',
      apiKey: { source: 'file', provider: 'test-extension-secrets' },
    });
    expect(published.plugins.entries).not.toHaveProperty('tts-local-cli');
    expect(published.plugins.entries.openai).toEqual({ enabled: true });
    expect(JSON.stringify(published)).not.toContain('private-key');
    expect(runExclusive).toHaveBeenCalledOnce();
    expect(saveExtensionSecrets).toHaveBeenCalledWith(
      expect.any(Object),
      'private-state',
      'runtime-services',
      expect.objectContaining({
        [Object.keys(vi.mocked(saveExtensionSecrets).mock.calls[0][3])[0]]: 'private-key',
      }),
    );
  });

  it('accepts a configured service with no API key and removes the previous profile reference', async () => {
    category.providers.internal.apiKey = '';
    await save();
    expect(patch().plugins.entries['runtime-services'].config.replySpeech.apiKey).toBe('');
    expect(saveExtensionSecrets).not.toHaveBeenCalled();
  });

  it.each([
    { modelRef: 'internal/missing', voice: 'voice-1' },
    { modelRef: 'internal/tts/model', voice: 'removed-voice' },
    { modelRef: 'internal/tts/model', voice: '' },
    { modelRef: 'internal/tts/model', voice: 'voice-1', baseUrl: 'http://arbitrary.invalid' },
    { provider: 'openai', baseUrl: 'http://old.invalid', model: 'old-contract', voice: 'voice-1' },
  ])('rejects invalid or obsolete selection payloads without publishing a profile', async input => {
    await expect(save(input)).rejects.toThrow();
    expect(requestGateway).not.toHaveBeenCalledWith('config.patch', expect.anything());
    expect(saveExtensionSecrets).not.toHaveBeenCalled();
  });

  it('rejects a non-HTTP service before querying Gateway', async () => {
    category.providers.internal.baseUrl = 'wss://speech.internal/v1';
    await expect(save()).rejects.toThrow();
    expect(requestGateway).not.toHaveBeenCalled();
  });

  it('does not use unregistered adapter defaults', async () => {
    providers = [];
    await expect(save()).rejects.toThrow('Unknown online speech provider.');
    expect(requestGateway).not.toHaveBeenCalledWith('config.patch', expect.anything());
  });

  it('reports read-aloud availability from its own profile rather than the assistant provider', async () => {
    nativeConfig.plugins = {
      entries: {
        'runtime-services': {
          config: {
            replySpeech: {
              baseUrl: 'http://reader.internal/v1',
              model: 'reader',
              speakerVoice: 'reader-voice',
              apiKey: { source: 'file', id: '/private-ref' },
            },
          },
        },
      },
    };
    await expect(handlers.get(OnlineTtsIpc.GetStatus)?.()).resolves.toEqual({
      available: true,
      provider: 'openai',
    });
    const configuration = await handlers.get(OnlineTtsIpc.GetConfiguration)?.();
    expect(configuration).toMatchObject({
      model: 'reader',
      voice: 'reader-voice',
      available: true,
    });
    expect(JSON.stringify(configuration)).not.toContain('private-ref');
  });

  it('returns no invented model or voice when the read-aloud profile is absent', async () => {
    const configuration = await handlers.get(OnlineTtsIpc.GetConfiguration)?.();
    expect(configuration).toMatchObject({ available: false });
    expect(configuration).not.toHaveProperty('model');
    expect(configuration).not.toHaveProperty('voice');
  });

  it('clears only the reply profile and preserves the assistant tool configuration', async () => {
    await handlers.get(OnlineTtsIpc.ClearConfiguration)?.();
    expect(patch()).toEqual({
      plugins: { entries: { 'runtime-services': { config: { replySpeech: null } } } },
    });
  });

  it('uses a different immutable credential slot when endpoint or key changes', async () => {
    await save();
    const first = patch().plugins.entries['runtime-services'].config.replySpeech.apiKey.id;
    requestGateway.mockClear();
    category.providers.internal.baseUrl = 'http://second.internal/v1';
    category.providers.internal.apiKey = 'new-key';
    await save();
    const second = patch().plugins.entries['runtime-services'].config.replySpeech.apiKey.id;
    expect(first).not.toBe(second);
  });
});
