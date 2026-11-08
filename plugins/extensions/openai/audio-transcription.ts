import type {
  AudioTranscriptionRequest,
  MediaUnderstandingProvider,
} from 'openclaw/plugin-sdk/media-understanding';
import { transcribeOpenAiCompatibleAudio } from 'openclaw/plugin-sdk/media-understanding';

import { normalizeSpeechServiceBaseUrl, SPEECH_PROTOCOL_IDS } from '../../sdk/speech-protocols/index.js';
import { requireServiceBaseUrl, requireSpeechIdentifier, resolveServiceApiKey } from './intranet-config.js';
export async function transcribeOpenAiAudio(params: AudioTranscriptionRequest) {
  const baseUrl = normalizeSpeechServiceBaseUrl(requireServiceBaseUrl(params.baseUrl, 'Audio transcription'),
    { protocolId: SPEECH_PROTOCOL_IDS.TRANSCRIPTION_HTTP });
  const model = requireSpeechIdentifier(params.model, 'audio transcription model');
  const apiKey = resolveServiceApiKey(params.apiKey, 'models.providers.openai.apiKey') ?? '';
  return transcribeOpenAiCompatibleAudio({
    ...params,
    provider: 'openai',
    baseUrl,
    defaultBaseUrl: baseUrl,
    model,
    defaultModel: model,
    apiKey,
    auth: { kind: 'api-key', apiKey },
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
