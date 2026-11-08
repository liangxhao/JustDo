import { beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultLocalSpeechSettings } from '../../shared/speech/localSpeechSettings';
import { mainProcessFetch } from '../core/network/mainProcessFetch';
import {
  resolveRecordedOnlineAsrProfile,
  transcribeRecordedOnlineAudio,
} from './recordedOnlineAsrService';

vi.mock('../core/network/mainProcessFetch', () => ({ mainProcessFetch: vi.fn() }));

export const recordedWav = (): Uint8Array => {
  const wav = Buffer.alloc(364);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(356, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(320, 40);
  return new Uint8Array(wav);
};
const catalog = () => ({
  providers: {
    internal: {
      baseUrl: 'http://speech.internal/deployment/v1',
      apiKey: 'configured-key',
      displayName: 'Any connection name',
      models: [
        {
          id: 'arbitrary/model',
          name: 'Any model',
          bindings: [
            {
              id: 'recording',
              protocolId: 'openai-transcription-http',
            },
          ],
        },
      ],
    },
  },
});
const settings = () => ({
  ...defaultLocalSpeechSettings,
  inputEnabled: true,
  recognitionMode: 'online' as const,
  onlineAsrModelRef: 'internal/arbitrary/model',
  onlineAsrBindingId: 'recording',
});

describe('recorded online transcription transport', () => {
  beforeEach(() => vi.mocked(mainProcessFetch).mockReset());

  it('sends the selected multipart contract without vendor inference', async () => {
    const profile = resolveRecordedOnlineAsrProfile(settings(), catalog())!;
    vi.mocked(mainProcessFetch).mockResolvedValue(
      new Response(JSON.stringify({ text: 'recognized words' })),
    );
    const assertCurrent = vi.fn();
    await expect(
      transcribeRecordedOnlineAudio(
        profile,
        recordedWav(),
        'zh',
        new AbortController().signal,
        assertCurrent,
      ),
    ).resolves.toBe('recognized words');
    const [endpoint, init, options] = vi.mocked(mainProcessFetch).mock.calls[0];
    expect(endpoint).toBe('http://speech.internal/deployment/v1/audio/transcriptions');
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer configured-key');
    expect(options?.beforeDispatch).toBe(assertCurrent);
    expect(init?.body).toBeInstanceOf(Uint8Array);
    const multipart = Buffer.from(init?.body as Uint8Array).toString('utf8');
    expect(multipart).toContain('name="file"; filename="audio.wav"');
    expect(multipart).toContain('arbitrary/model');
  });

  it('does not send a recording through a realtime-only or unselected binding', () => {
    const models = catalog();
    models.providers.internal.models[0].bindings[0].protocolId = 'openai-transcription-realtime';
    expect(resolveRecordedOnlineAsrProfile(settings(), models)).toBeNull();
    expect(
      resolveRecordedOnlineAsrProfile({ ...settings(), onlineAsrBindingId: '' }, catalog()),
    ).toBeNull();
  });

  it.each(['', ' ', 'x'.repeat(257), 'bad\u0001model'])(
    'does not create a recording profile for an invalid model identity (%j)', id => {
      const models = catalog();
      models.providers.internal.models[0].id = id;
      expect(resolveRecordedOnlineAsrProfile({ ...settings(), onlineAsrModelRef: `internal/${id.trim()}` }, models)).toBeNull();
      expect(mainProcessFetch).not.toHaveBeenCalled();
    },
  );

  it.each(['', 'http://speech.internal/v1/audio/speech'])(
    'does not create a recording profile or dispatch through an invalid endpoint (%j)', baseUrl => {
      const models = catalog();
      models.providers.internal.baseUrl = baseUrl;
      expect(resolveRecordedOnlineAsrProfile(settings(), models)).toBeNull();
      expect(mainProcessFetch).not.toHaveBeenCalled();
    },
  );

  it('rejects invalid recordings before sending', async () => {
    const profile = resolveRecordedOnlineAsrProfile(settings(), catalog())!;
    await expect(
      transcribeRecordedOnlineAudio(
        profile,
        new Uint8Array(100),
        'zh',
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow('WAV');
    expect(mainProcessFetch).not.toHaveBeenCalled();
  });

  it('passes a configured transcription language without provider-specific restrictions', async () => {
    const profile = resolveRecordedOnlineAsrProfile(settings(), catalog())!;
    vi.mocked(mainProcessFetch).mockResolvedValue(new Response('{"text":"recognized"}'));
    await expect(
      transcribeRecordedOnlineAudio(
        profile,
        recordedWav(),
        'ja',
        new AbortController().signal,
        () => {},
      ),
    ).resolves.toBe('recognized');
    const body = vi.mocked(mainProcessFetch).mock.calls[0][1]?.body as Uint8Array;
    expect(Buffer.from(body).toString('utf8')).toContain('name="language"\r\n\r\nja');
  });

  it('does not dispatch retired protocols or a deprecated configuration field', async () => {
    const models = catalog();
    models.providers.internal.models[0].bindings[0].protocolId = 'chat-audio-transcription';
    expect(resolveRecordedOnlineAsrProfile(settings(), models)).toBeNull();
    const profile = resolveRecordedOnlineAsrProfile(settings(), catalog())!;
    await expect(
      transcribeRecordedOnlineAudio(
        {
          ...profile,
          selection: {
            ...profile.selection,
            compatibilityProfile: 'removed',
          },
        } as never,
        recordedWav(),
        'en',
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow('configuration');
    expect(mainProcessFetch).not.toHaveBeenCalled();
  });

  it('reports HTTP status without reflecting a service error body or credential', async () => {
    vi.mocked(mainProcessFetch).mockResolvedValue(
      new Response('configured-key: private service error', { status: 401 }),
    );
    const profile = resolveRecordedOnlineAsrProfile(settings(), catalog())!;
    await expect(
      transcribeRecordedOnlineAudio(
        profile,
        recordedWav(),
        'en',
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow(/^Speech service returned HTTP 401\.$/);
  });

  it('bounds a response without a content-length and sanitizes invalid JSON', async () => {
    const profile = resolveRecordedOnlineAsrProfile(settings(), catalog())!;
    vi.mocked(mainProcessFetch).mockResolvedValue(new Response('configured-key is not JSON'));
    await expect(
      transcribeRecordedOnlineAudio(
        profile,
        recordedWav(),
        'en',
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow(/^Speech service returned invalid JSON\.$/);
    vi.mocked(mainProcessFetch).mockResolvedValue(
      new Response(new Uint8Array(4 * 1024 * 1024 + 1)),
    );
    await expect(
      transcribeRecordedOnlineAudio(
        profile,
        recordedWav(),
        'en',
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow('size limit');
  });
});
