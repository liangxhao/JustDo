export const MediaGenerationModelsIpc = {
  GetConfiguration: 'media-generation-models:get-configuration',
  SaveConfiguration: 'media-generation-models:save-configuration',
} as const;

export type MediaGenerationModelKind = 'image' | 'video' | 'music';

export { OpenAiCompatibleMediaConfigProviderIds } from '../../../openclaw-extensions/openai/contracts/media-config';

export interface MediaGenerationModelConfiguration {
  primary: string;
  fallbacks: string[];
  timeoutMs?: number;
  baseUrl?: string;
  apiKey?: string;
}

export interface MediaGenerationModelConfigurationResult extends MediaGenerationModelConfiguration {
  available: boolean;
  error?: string;
}
