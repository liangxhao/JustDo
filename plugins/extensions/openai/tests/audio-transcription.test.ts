import { afterEach, describe, expect, it, vi } from 'vitest';

import { transcribeOpenAiAudio } from '../audio-transcription';
import { openaiMediaUnderstandingProvider } from '../media-understanding-provider';
import manifest from '../openclaw.plugin.json';

const native = vi.hoisted(() => ({ transcribe: vi.fn() }));
vi.mock('openclaw/plugin-sdk/media-understanding', () => ({
  transcribeOpenAiCompatibleAudio: (...args: unknown[]) => native.transcribe(...args),
}));
vi.mock('openclaw/plugin-sdk/secret-input', () => ({
  normalizeResolvedSecretInputString: ({ value }: { value: unknown }) => {
    if (value !== undefined && typeof value !== 'string') throw new Error('Unresolved credential');
    return typeof value === 'string' ? value : undefined;
  },
}));

const input = { baseUrl: 'http://audio.internal/deployment/v1', model: 'arbitrary/input-model',
  apiKey: '', buffer: Buffer.from([1, 2, 3]), fileName: 'input.wav', mime: 'audio/wav', timeoutMs: 5000 };
afterEach(() => vi.resetAllMocks());

describe('configured native audio transcription', () => {
  it('has no audio default or automatic priority while preserving image metadata', () => {
    expect(openaiMediaUnderstandingProvider.defaultModels).not.toHaveProperty('audio');
    expect(openaiMediaUnderstandingProvider.autoPriority).not.toHaveProperty('audio');
    expect(manifest.mediaUnderstandingProviderMetadata.openai.defaultModels).not.toHaveProperty('audio');
    expect(manifest.mediaUnderstandingProviderMetadata.openai.autoPriority).not.toHaveProperty('audio');
    expect(openaiMediaUnderstandingProvider.defaultModels?.image).toBeTruthy();
  });

  it('does not dispatch missing or invalid explicit settings to the native SDK', async () => {
    for (const fields of [{ model: undefined }, { model: '' }, { model: '\ncustom' },
      { baseUrl: undefined }, { baseUrl: 'http://audio.internal/v1/audio/speech' }, { apiKey: { source: 'file' } }])
      await expect(transcribeOpenAiAudio({ ...input, ...fields } as never)).rejects.toThrow();
    expect(native.transcribe).not.toHaveBeenCalled();
  });

  it('uses the selected arbitrary model for the SDK required field without another default or credential source', async () => {
    native.transcribe.mockResolvedValue({ text: 'fixture', model: input.model });
    await expect(transcribeOpenAiAudio(input as never)).resolves.toMatchObject({ text: 'fixture' });
    expect(native.transcribe).toHaveBeenCalledWith(expect.objectContaining({
      model: input.model, defaultModel: input.model, baseUrl: input.baseUrl, defaultBaseUrl: input.baseUrl,
      apiKey: '', auth: { kind: 'api-key', apiKey: '' },
    }));
  });
});
