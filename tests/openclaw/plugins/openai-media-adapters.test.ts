import type { PluginCapabilityCatalogHostContext } from 'openclaw/plugin-sdk/plugin-entry';
import { describe, expect, it, vi } from 'vitest';

import {
  configureTranscriptionProvider,
  isolateImageProvider,
  resolveTranscriptionUrl,
  withMediaAdapters,
} from '../../../openclaw-extensions/openai/media-adapters';

describe('application OpenAI provider composition', () => {
  it('uses a request-local image credential view without changing chat configuration', async () => {
    const chat = { baseUrl: 'https://chat.example/v1', apiKey: 'synthetic-chat' };
    const image = { baseUrl: 'https://image.example/v1', apiKey: 'synthetic-image' };
    const cfg = { models: { providers: { openai: chat, 'justdo-image-openai': image } } };
    const isConfigured = vi.fn(() => true);
    const generateImage = vi.fn(async () => ({ images: [] }));
    const provider = isolateImageProvider({ id: 'openai', isConfigured, generateImage });
    expect(provider.isConfigured({ cfg })).toBe(true);
    await provider.generateImage({ cfg, prompt: 'synthetic' });
    expect(generateImage.mock.calls[0][0].cfg.models.providers.openai).toBe(image);
    expect(cfg.models.providers.openai).toBe(chat);
    expect(provider.isConfigured({ cfg: { models: { providers: { openai: chat } } } })).toBe(false);
  });

  it('retains normalized endpoint configuration and separates simultaneous transcription sessions', async () => {
    const requests: Array<{ url: string; headers: () => Promise<unknown> }> = [];
    const headerRequests: unknown[] = [];
    const context = {
      createRealtimeTranscriptionWebSocketSession: (options: (typeof requests)[number]) => {
        requests.push(options);
        return {};
      },
      resolveProviderRequestHeaders: (options: unknown) => {
        headerRequests.push(options);
        return {};
      },
    } as unknown as PluginCapabilityCatalogHostContext;
    const nativeFactory = vi.fn((runtime: PluginCapabilityCatalogHostContext) => ({
      id: 'openai',
      label: 'native',
      resolveConfig: () => ({ model: 'native-model' }),
      isConfigured: () => true,
      createSession: () =>
        runtime.createRealtimeTranscriptionWebSocketSession({
          url: 'wss://api.openai.com/v1/realtime?intent=transcription',
          headers: async () => {
            await Promise.resolve();
            return runtime.resolveProviderRequestHeaders({
              provider: 'openai',
              capability: 'audio',
              transport: 'websocket',
              baseUrl: 'wss://api.openai.com/v1/realtime?intent=transcription',
            });
          },
        }),
    }));
    const provider = configureTranscriptionProvider(nativeFactory)(context);
    const first = provider.resolveConfig!({
      cfg: {},
      rawConfig: { providers: { openai: { baseUrl: ' https://first.example/v1/ ' } } },
    });
    expect(first).toEqual({ model: 'native-model', baseUrl: 'https://first.example/v1/' });
    provider.createSession({ providerConfig: first });
    provider.createSession({ providerConfig: { baseUrl: 'http://second.example/realtime' } });
    provider.createSession({ providerConfig: {} });
    await Promise.all(requests.map(request => request.headers()));
    expect(requests.map(request => request.url)).toEqual([
      'wss://first.example/v1/realtime?intent=transcription',
      'ws://second.example/realtime?intent=transcription',
      'wss://api.openai.com/v1/realtime?intent=transcription',
    ]);
    expect(headerRequests).toEqual(
      requests.map(request => expect.objectContaining({ baseUrl: request.url })),
    );
    expect(resolveTranscriptionUrl('https://example.test/v1/realtime?existing=1')).toBe(
      'wss://example.test/v1/realtime?existing=1&intent=transcription',
    );
  });

  it('registers each adapted provider once and forwards unrelated native registrations', () => {
    const image = vi.fn();
    const transcription = vi.fn();
    const speech = vi.fn();
    const api = {
      registerImageGenerationProvider: image,
      registerRealtimeTranscriptionProvider: transcription,
      registerSpeechProvider: speech,
    };
    const composed = withMediaAdapters(api);
    composed.registerImageGenerationProvider({
      id: 'openai',
      isConfigured: () => true,
      generateImage: vi.fn(),
    });
    composed.registerRealtimeTranscriptionProvider(() => ({ id: 'openai' }));
    composed.registerSpeechProvider({ id: 'native-speech' });
    expect(image).toHaveBeenCalledOnce();
    expect(transcription).toHaveBeenCalledOnce();
    expect(speech).toHaveBeenCalledWith({ id: 'native-speech' });
    expect(composed.registerSpeechProvider).toBe(api.registerSpeechProvider);
  });
});
