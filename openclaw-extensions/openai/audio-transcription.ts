import type {
  AudioTranscriptionRequest,
  MediaUnderstandingProvider,
} from 'openclaw/plugin-sdk/media-understanding';
import { transcribeOpenAiCompatibleAudio } from 'openclaw/plugin-sdk/media-understanding';
import { requireServiceBaseUrl, resolveServiceApiKey } from './intranet-config.js';
import { OPENAI_DEFAULT_AUDIO_TRANSCRIPTION_MODEL } from './default-models.js';
export async function transcribeOpenAiAudio(params: AudioTranscriptionRequest) {
  const baseUrl = requireServiceBaseUrl(params.baseUrl, 'Audio transcription');
  return transcribeOpenAiCompatibleAudio({
    ...params,
    provider: 'openai',
    baseUrl,
    defaultBaseUrl: baseUrl,
    defaultModel: OPENAI_DEFAULT_AUDIO_TRANSCRIPTION_MODEL,
  });
}
export const transcribeOpenAiAudioWithContext: NonNullable<
  MediaUnderstandingProvider['transcribeAudioWithContext']
> = async context => {
  if (context.profile)
    return {
      ok: false,
      error: new Error(
        'Configure the audio service credential directly; account profiles are not supported.',
      ),
    };
  const provider = context.cfg.models?.providers?.openai;
  let baseUrl: string;
  let apiKey: string | undefined;
  try {
    baseUrl = requireServiceBaseUrl(context.baseUrl ?? provider?.baseUrl, 'Audio transcription');
    apiKey = resolveServiceApiKey(provider?.apiKey, 'models.providers.openai.apiKey');
  } catch (error) {
    return { ok: false, error };
  }
  // Once uploading starts, failures throw; they must not send audio to another provider.
  return {
    ok: true,
    value: await transcribeOpenAiAudio({
      ...context,
      baseUrl,
      apiKey: apiKey ?? '',
      auth: { kind: 'api-key', apiKey: apiKey ?? '' },
    }),
  };
};
