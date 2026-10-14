import { OpenAiCompatibleMediaConfigProviderIds } from './mediaGenerationModels';

// The OpenAI extension owns the only supported video protocol adapter.
export const NATIVE_VIDEO_PROVIDERS = [
  {
    id: OpenAiCompatibleMediaConfigProviderIds.video,
    extensionId: 'openai',
    name: 'OpenAI',
  },
] as const;

export type NativeVideoProviderId = (typeof NATIVE_VIDEO_PROVIDERS)[number]['id'];

export const findNativeVideoProvider = (id: unknown) =>
  NATIVE_VIDEO_PROVIDERS.find(provider => provider.id === id);

export const isNativeVideoModelSupported = (
  provider: (typeof NATIVE_VIDEO_PROVIDERS)[number],
  model: unknown,
): model is string =>
  provider.id === OpenAiCompatibleMediaConfigProviderIds.video &&
  typeof model === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,447}$/.test(model);
