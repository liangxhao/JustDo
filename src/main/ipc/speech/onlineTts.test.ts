import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: never[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: never[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

import { OnlineTtsIpc } from '../../../shared/speech/onlineTts';
import { registerOnlineTtsHandlers } from './onlineTts';

describe('OpenClaw online speech IPC', () => {
  const requestGateway = vi.fn();

  beforeEach(() => {
    handlers.clear();
    requestGateway.mockReset();
    registerOnlineTtsHandlers({ getRuntime: () => ({}) as never, requestGateway });
  });

  it('does not invent providers, models or voices when no online speech plugin is registered', async () => {
    requestGateway
      .mockResolvedValueOnce({ active: 'tts-local-cli', providers: [] })
      .mockResolvedValueOnce({ config: {} });

    const configuration = await handlers.get(OnlineTtsIpc.GetConfiguration)?.();

    expect(configuration).toEqual({ available: false, providers: [], credentialConfigured: false });
  });

  it('reads an explicitly configured intranet OpenAI speech service', async () => {
    requestGateway
      .mockResolvedValueOnce({
        active: 'openai',
        providers: [{ id: 'openai', name: 'OpenAI', configured: true,
          defaultModel: 'vendor-default-model', defaultVoice: 'vendor-default-voice',
          models: ['vendor-default-model'], voices: ['vendor-default-voice'],
        }],
      })
      .mockResolvedValueOnce({
        config: {
          tts: {
            provider: 'openai',
            providers: {
              openai: {
                baseUrl: 'http://speech.internal:8000/v1',
                model: 'internal-tts',
                voice: 'speaker-1',
              },
            },
          },
        },
      });

    await expect(handlers.get(OnlineTtsIpc.GetConfiguration)?.()).resolves.toEqual({
      available: true,
      provider: 'openai',
      selectedProvider: 'openai',
      baseUrl: 'http://speech.internal:8000/v1',
      model: 'internal-tts',
      voice: 'speaker-1',
      credentialConfigured: true,
      providers: [{ id: 'openai', label: 'OpenAI', configured: true }],
    });
  });

  it('returns no fallback catalog when Gateway is unavailable', async () => {
    requestGateway.mockRejectedValue(new Error('Unavailable'));
    const configuration = await handlers.get(OnlineTtsIpc.GetConfiguration)?.();
    expect(configuration).toMatchObject({ available: false, providers: [], credentialConfigured: false });
    expect(configuration).not.toHaveProperty('selectedProvider');
  });

  it('does not use registered plugin model or voice presets without explicit configuration', async () => {
    requestGateway.mockResolvedValueOnce({ active: 'openai', providers: [{
      id: 'openai', configured: true, defaultModel: 'vendor-model', defaultVoice: 'vendor-voice',
      models: ['vendor-model'], voices: ['vendor-voice'],
    }] }).mockResolvedValueOnce({ config: {} });
    const configuration = await handlers.get(OnlineTtsIpc.GetConfiguration)?.();
    expect(configuration).toMatchObject({ available: false });
    expect(configuration).not.toHaveProperty('model');
    expect(configuration).not.toHaveProperty('voice');
    expect((configuration as { providers: unknown[] }).providers).toEqual([
      { id: 'openai', label: 'openai', configured: true },
    ]);
  });

  it('rejects saving an unregistered OpenAI adapter without patching config', async () => {
    requestGateway.mockResolvedValueOnce({ providers: [] });
    await expect(handlers.get(OnlineTtsIpc.SaveConfiguration)?.({}, {
      provider: 'openai', baseUrl: 'http://speech.internal/v1', apiKey: 'test-key', model: 'internal-tts', voice: 'speaker-1',
    })).rejects.toThrow('Unknown online speech provider.');
    expect(requestGateway).toHaveBeenCalledTimes(1);
    expect(requestGateway).not.toHaveBeenCalledWith('config.patch', expect.anything());
  });

  it.each([{ model: '', voice: 'speaker-1' }, { model: 'internal-tts', voice: '' }])(
    'requires explicit model and voice instead of substituting presets: %j', async fields => {
      await expect(handlers.get(OnlineTtsIpc.SaveConfiguration)?.({}, {
        provider: 'openai', baseUrl: 'http://speech.internal/v1', apiKey: 'test-key', ...fields,
      })).rejects.toThrow('Invalid online speech configuration.');
      expect(requestGateway).not.toHaveBeenCalled();
    },
  );

  it('saves OpenAI-compatible speech settings through Gateway config', async () => {
    requestGateway
      .mockResolvedValueOnce({
        providers: [{ id: 'openai', name: 'OpenAI', configured: false }],
      })
      .mockResolvedValueOnce({ hash: 'config-hash' })
      .mockResolvedValueOnce({ ok: true });

    await handlers.get(OnlineTtsIpc.SaveConfiguration)?.(
      {},
      {
        provider: 'openai',
        baseUrl: 'http://speech.internal:8000/v1',
        apiKey: 'secret',
        model: 'internal-tts',
        voice: 'speaker-1',
      },
    );

    expect(requestGateway.mock.calls[2]?.[0]).toBe('config.patch');
    expect(JSON.parse((requestGateway.mock.calls[2]?.[1] as { raw: string }).raw)).toMatchObject({
      tts: {
        auto: 'off',
        provider: 'openai',
        providers: {
          openai: {
            baseUrl: 'http://speech.internal:8000/v1',
            apiKey: 'secret',
            model: 'internal-tts',
            voice: 'speaker-1',
          },
        },
      },
      plugins: { entries: { openai: { enabled: true } } },
    });
  });

  it('rejects removed ElevenLabs speech settings before querying or mutating Gateway config', async () => {
    await expect(handlers.get(OnlineTtsIpc.SaveConfiguration)?.(
      {},
      {
        provider: 'elevenlabs',
        baseUrl: 'http://speech.internal:8001',
        apiKey: 'secret',
        model: 'eleven_multilingual_v2',
        voice: 'voice-id',
      },
    )).rejects.toThrow('Invalid online speech configuration.');
    expect(requestGateway).not.toHaveBeenCalled();
  });

  it('requires the API key again when the speech service URL changes', async () => {
    requestGateway
      .mockResolvedValueOnce({
        providers: [{ id: 'openai', name: 'OpenAI', configured: true }],
      })
      .mockResolvedValueOnce({
        hash: 'config-hash',
        config: {
          tts: {
            provider: 'openai',
            providers: {
              openai: { baseUrl: 'http://old.internal:8000', model: 'model', voice: 'voice' },
            },
          },
        },
      });

    await expect(
      handlers.get(OnlineTtsIpc.SaveConfiguration)?.(
        {},
        {
          provider: 'openai',
          baseUrl: 'http://new.internal:8000',
          model: 'model',
          voice: 'voice',
        },
      ),
    ).rejects.toThrow(/API key/i);
    expect(requestGateway).not.toHaveBeenCalledWith('config.patch', expect.anything());
  });

  it('clears the Gateway speech configuration', async () => {
    requestGateway.mockResolvedValueOnce({ hash: 'config-hash' }).mockResolvedValueOnce({ ok: true });

    await handlers.get(OnlineTtsIpc.ClearConfiguration)?.({});

    expect(JSON.parse((requestGateway.mock.calls[1]?.[1] as { raw: string }).raw)).toEqual({
      tts: null,
    });
  });
});
