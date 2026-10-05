import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: never[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: never[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

import { OnlineAsrIpc } from '../../../shared/speech/onlineAsr';
import { registerOnlineAsrHandlers } from './onlineAsr';

describe('OpenClaw online transcription IPC', () => {
  const runtime = new EventEmitter();
  const requestGateway = vi.fn();
  const send = vi.fn();
  const sender = {
    isDestroyed: () => false,
    once: vi.fn(),
    send,
  };

  beforeEach(() => {
    handlers.clear();
    requestGateway.mockReset();
    send.mockReset();
    sender.once.mockReset();
    runtime.removeAllListeners();
    registerOnlineAsrHandlers({ getRuntime: () => runtime as never, requestGateway });
  });

  it('does not invent providers or models when no transcription plugin is registered', async () => {
    requestGateway
      .mockResolvedValueOnce({ transcription: { ready: false, providers: [] } })
      .mockResolvedValueOnce({ config: {} });

    const configuration = await handlers.get(OnlineAsrIpc.GetConfiguration)?.();

    expect(configuration).toEqual({ available: false, providers: [], credentialConfigured: false });
  });

  it('reports the configured Gateway transcription provider', async () => {
    requestGateway.mockImplementation((method: string) => {
      if (method === 'talk.catalog') {
        return Promise.resolve({
          transcription: {
            ready: true,
            activeProvider: 'openai',
            providers: [{ id: 'openai', configured: true }],
          },
        });
      }
      return Promise.resolve({
        config: {
          plugins: {
            entries: {
              'voice-call': {
                config: {
                  streaming: {
                    provider: 'openai',
                    providers: {
                      openai: { baseUrl: 'ws://speech.internal:8000', model: 'internal-asr' },
                    },
                  },
                },
              },
            },
          },
        },
      });
    });

    await expect(handlers.get(OnlineAsrIpc.GetStatus)?.()).resolves.toEqual({
      available: true,
      provider: 'openai',
    });
    expect(requestGateway).toHaveBeenCalledWith('talk.catalog', {});
  });

  it('returns the registered adapter and explicit model without Gateway model presets', async () => {
    requestGateway
      .mockResolvedValueOnce({
        transcription: {
          ready: true,
          activeProvider: 'openai',
          providers: [
            {
              id: 'openai',
              label: 'OpenAI',
              configured: true,
              defaultModel: 'vendor-default-model',
              models: ['vendor-default-model'],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        config: {
          plugins: {
            entries: {
              'voice-call': {
                config: {
                  streaming: {
                    provider: 'openai',
                    providers: {
                      openai: {
                        baseUrl: 'ws://speech.internal:8000',
                        model: 'internal-asr-medical',
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });

    const configuration = await handlers.get(OnlineAsrIpc.GetConfiguration)?.();
    expect(configuration).toMatchObject({
      available: true,
      selectedProvider: 'openai',
      baseUrl: 'ws://speech.internal:8000',
      model: 'internal-asr-medical',
      credentialConfigured: true,
    });
    expect((configuration as { providers: unknown[] }).providers).toEqual([
      { id: 'openai', label: 'OpenAI', configured: true },
    ]);
  });

  it.each(['deepgram', 'mistral', 'elevenlabs'])('ignores and rejects unsupported %s transcription settings', async provider => {
    requestGateway.mockResolvedValueOnce({ transcription: {
      ready: true, activeProvider: provider, providers: [{ id: provider, configured: true, defaultModel: 'vendor-model' }],
    } }).mockResolvedValueOnce({ config: {} });
    await expect(handlers.get(OnlineAsrIpc.GetConfiguration)?.()).resolves.toEqual({
      available: false, providers: [], credentialConfigured: false,
    });
    requestGateway.mockClear();
    await expect(handlers.get(OnlineAsrIpc.SaveConfiguration)?.({}, {
      provider, baseUrl: 'http://speech.internal/v1', apiKey: 'test-key', model: 'internal-asr',
    })).rejects.toThrow('Invalid online transcription configuration.');
    expect(requestGateway).not.toHaveBeenCalled();
  });

  it('returns no fallback catalog when Gateway is unavailable', async () => {
    requestGateway.mockRejectedValue(new Error('Unavailable'));
    await expect(handlers.get(OnlineAsrIpc.GetConfiguration)?.()).resolves.toMatchObject({
      available: false, providers: [], credentialConfigured: false,
    });
  });

  it('does not use registered plugin model presets without explicit configuration', async () => {
    requestGateway.mockResolvedValueOnce({ transcription: {
      ready: true, activeProvider: 'openai', providers: [{
        id: 'openai', configured: true, defaultModel: 'vendor-model', models: ['vendor-model'],
      }],
    } }).mockResolvedValueOnce({ config: {} });
    const configuration = await handlers.get(OnlineAsrIpc.GetConfiguration)?.();
    expect(configuration).toMatchObject({ available: false });
    expect(configuration).not.toHaveProperty('model');
    expect((configuration as { providers: unknown[] }).providers).toEqual([
      { id: 'openai', label: 'openai', configured: true },
    ]);
  });

  it('rejects saving an unregistered OpenAI adapter without patching config', async () => {
    requestGateway.mockResolvedValueOnce({ transcription: { providers: [] } });
    await expect(handlers.get(OnlineAsrIpc.SaveConfiguration)?.({}, {
      provider: 'openai', baseUrl: 'http://speech.internal/v1', apiKey: 'test-key', model: 'internal-asr',
    })).rejects.toThrow('Unknown online transcription provider.');
    expect(requestGateway).toHaveBeenCalledTimes(1);
    expect(requestGateway).not.toHaveBeenCalledWith('config.patch', expect.anything());
  });

  it('requires an explicit model instead of substituting a preset', async () => {
    await expect(handlers.get(OnlineAsrIpc.SaveConfiguration)?.({}, {
      provider: 'openai', baseUrl: 'http://speech.internal/v1', apiKey: 'test-key', model: '',
    })).rejects.toThrow('Invalid online transcription configuration.');
    expect(requestGateway).not.toHaveBeenCalled();
  });

  it('saves provider credentials through an atomic Gateway config patch', async () => {
    requestGateway
      .mockResolvedValueOnce({
        transcription: {
          providers: [{ id: 'openai', label: 'OpenAI', configured: false }],
        },
      })
      .mockResolvedValueOnce({ hash: 'config-hash' })
      .mockResolvedValueOnce({ ok: true });

    await handlers.get(OnlineAsrIpc.SaveConfiguration)?.(
      { sender },
      {
        provider: 'openai',
        baseUrl: 'ws://speech.internal:8000',
        apiKey: 'secret',
        model: 'internal-asr',
      },
    );

    const patchCall = requestGateway.mock.calls[2];
    expect(patchCall?.[0]).toBe('config.patch');
    expect(patchCall?.[1]).toMatchObject({ baseHash: 'config-hash' });
    expect(JSON.parse((patchCall?.[1] as { raw: string }).raw)).toMatchObject({
      plugins: {
        entries: {
          'voice-call': {
            config: {
              streaming: {
                provider: 'openai',
                providers: {
                  openai: {
                    baseUrl: 'ws://speech.internal:8000',
                    apiKey: 'secret',
                    model: 'internal-asr',
                  },
                },
              },
            },
          },
        },
      },
    });
  });

  it('requires the API key again when the transcription service URL changes', async () => {
    requestGateway
      .mockResolvedValueOnce({
        transcription: {
          providers: [{ id: 'openai', label: 'OpenAI', configured: true }],
        },
      })
      .mockResolvedValueOnce({
        hash: 'config-hash',
        config: {
          plugins: {
            entries: {
              'voice-call': {
                config: {
                  streaming: {
                    provider: 'openai',
                    providers: {
                      openai: { baseUrl: 'ws://old.internal:8000', model: 'model' },
                    },
                  },
                },
              },
            },
          },
        },
      });

    await expect(
      handlers.get(OnlineAsrIpc.SaveConfiguration)?.(
        { sender },
        {
          provider: 'openai',
          baseUrl: 'ws://new.internal:8000',
          model: 'model',
        },
      ),
    ).rejects.toThrow(/API key/i);
    expect(requestGateway).not.toHaveBeenCalledWith('config.patch', expect.anything());
  });

  it('creates an exact OpenClaw transcription relay and forwards only its events', async () => {
    requestGateway.mockImplementation((method: string) => {
      if (method === 'talk.catalog') {
        return Promise.resolve({
          transcription: {
            ready: true,
            activeProvider: 'openai',
            providers: [{ id: 'openai', configured: true }],
          },
        });
      }
      if (method === 'config.get') {
        return Promise.resolve({
          config: {
            plugins: {
              entries: {
                'voice-call': {
                  config: {
                    streaming: {
                      provider: 'openai',
                      providers: {
                        openai: { baseUrl: 'ws://speech.internal:8000', model: 'internal-asr' },
                      },
                    },
                  },
                },
              },
            },
          },
        });
      }
      return Promise.resolve({
        sessionId: 'talk-1',
        transcriptionSessionId: 'transcription-1',
        provider: 'openai',
        audio: { inputEncoding: 'g711_ulaw', inputSampleRateHz: 8000 },
      });
    });
    const start = handlers.get(OnlineAsrIpc.Start);

    await expect(start?.({ sender }, { language: 'zh' })).resolves.toMatchObject({
      sessionId: 'talk-1',
      transcriptionSessionId: 'transcription-1',
      inputEncoding: 'g711_ulaw',
      inputSampleRateHz: 8000,
    });
    expect(requestGateway).toHaveBeenCalledWith('talk.session.create', {
      mode: 'transcription',
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

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(OnlineAsrIpc.Event, {
      transcriptionSessionId: 'transcription-1',
      type: 'transcript',
      text: '你好',
      final: true,
    });
  });

  it('rejects audio sent by a renderer that does not own the Talk session', async () => {
    requestGateway.mockImplementation((method: string) => {
      if (method === 'talk.catalog') {
        return Promise.resolve({
          transcription: {
            ready: true,
            activeProvider: 'openai',
            providers: [{ id: 'openai', configured: true }],
          },
        });
      }
      if (method === 'config.get') {
        return Promise.resolve({
          config: {
            plugins: {
              entries: {
                'voice-call': {
                  config: {
                    streaming: {
                      provider: 'openai',
                      providers: {
                        openai: { baseUrl: 'ws://speech.internal:8000', model: 'internal-asr' },
                      },
                    },
                  },
                },
              },
            },
          },
        });
      }
      return Promise.resolve({
        sessionId: 'talk-1',
        audio: { inputEncoding: 'g711_ulaw', inputSampleRateHz: 8000 },
      });
    });
    await handlers.get(OnlineAsrIpc.Start)?.({ sender }, { language: 'auto' });

    await expect(
      handlers.get(OnlineAsrIpc.AppendAudio)?.({ sender: {} }, 'talk-1', 'AQ=='),
    ).rejects.toThrow('Invalid online transcription audio request.');
  });

  it('clears the Gateway transcription configuration', async () => {
    requestGateway.mockResolvedValueOnce({ hash: 'config-hash' }).mockResolvedValueOnce({ ok: true });

    await handlers.get(OnlineAsrIpc.ClearConfiguration)?.({});

    expect(JSON.parse((requestGateway.mock.calls[1]?.[1] as { raw: string }).raw)).toEqual({
      plugins: { entries: { 'voice-call': { config: { streaming: null } } } },
    });
  });
});
