import { describe, expect, it, vi } from 'vitest';

import {
  imageConfig,
  requireServiceBaseUrl,
  resolveTranscriptionUrl,
} from '../../../openclaw-extensions/openai/intranet-config';

vi.mock('openclaw/plugin-sdk/secret-input', () => ({
  normalizeResolvedSecretInputString: vi.fn(),
}));

describe('OpenAI intranet configuration', () => {
  it('uses only the image credential domain without mutating chat or video configuration', () => {
    const chat = { baseUrl: 'https://chat.example/v1', apiKey: 'synthetic-chat' };
    const image = { baseUrl: 'https://image.example/v1', apiKey: 'synthetic-image' };
    const video = { baseUrl: 'https://video.example/v1', apiKey: 'synthetic-video' };
    const cfg = {
      models: { providers: { openai: chat, 'justdo-image-openai': image, 'video-openai': video } },
    };
    const isolated = imageConfig(cfg as never);
    expect(isolated.models?.providers?.openai).toBe(image);
    expect(isolated.models?.providers?.['video-openai']).toBe(video);
    expect(cfg.models.providers.openai).toBe(chat);
    expect(
      imageConfig({ models: { providers: { openai: chat } } } as never).models?.providers?.openai,
    ).toBeUndefined();
  });

  it.each([
    undefined,
    '',
    'file:///local',
    'ftp://service.test',
    'https://user:password@service.test',
    'https://service.test/#fragment',
  ])('rejects a missing or invalid service endpoint: %s', value => {
    expect(() => requireServiceBaseUrl(value, 'Model')).toThrow();
  });

  it('derives the realtime transport URL without sharing mutable session state', () => {
    expect(resolveTranscriptionUrl(' https://first.example/v1/ ')).toBe(
      'wss://first.example/v1/realtime?intent=transcription',
    );
    expect(resolveTranscriptionUrl('http://second.example/realtime')).toBe(
      'ws://second.example/realtime?intent=transcription',
    );
    expect(resolveTranscriptionUrl('ws://speech.internal:8000')).toBe(
      'ws://speech.internal:8000/realtime?intent=transcription',
    );
    expect(resolveTranscriptionUrl('wss://speech.internal/v1/realtime')).toBe(
      'wss://speech.internal/v1/realtime?intent=transcription',
    );
    expect(resolveTranscriptionUrl('https://example.test/v1/realtime?existing=1')).toBe(
      'wss://example.test/v1/realtime?existing=1&intent=transcription',
    );
  });
});
