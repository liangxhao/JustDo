import { OpenAiCompatibleMediaConfigProviderIds } from './mediaGenerationModels';

// Native provider contracts, including the application-owned video protocol adapter.
export const NATIVE_VIDEO_PROVIDERS = [
  {
    id: OpenAiCompatibleMediaConfigProviderIds.video,
    name: 'Video models',
    baseUrl: '',
    models: [] as readonly string[],
    customModel: true,
    apiKeyRequired: false,
  },
  {
    id: 'kie',
    customModel: false,
    apiKeyRequired: true,
    name: 'Kie AI',
    baseUrl: 'https://api.kie.ai',
    models: [
      'kling-2.6/text-to-video',
      'kling-2.6/image-to-video',
      'grok-imagine/text-to-video',
      'grok-imagine/image-to-video',
      'wan/2-6-text-to-video',
      'wan/2-6-image-to-video',
      'hailuo/02-text-to-video-standard',
      'hailuo/02-image-to-video-standard',
      'hailuo/02-text-to-video-pro',
      'hailuo/02-image-to-video-pro',
      'hailuo/2-3-image-to-video-standard',
      'hailuo/2-3-image-to-video-pro',
      'bytedance/seedance-1.5-pro',
    ],
  },
  {
    id: 'zai',
    customModel: false,
    apiKeyRequired: true,
    name: 'Z.AI',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    models: ['cogvideox-3'],
  },
  {
    id: 'novita',
    customModel: false,
    apiKeyRequired: true,
    name: 'NovitaAI',
    baseUrl: 'https://api.novita.ai/openai/v1',
    models: [
      'wan2.6-t2v',
      'wan2.6-i2v',
      'minimax-hailuo-2.3-t2v',
      'minimax-hailuo-2.3-i2v',
      'minimax-hailuo-2.3-fast-i2v',
    ],
  },
] as const;

export type NativeVideoProviderId = (typeof NATIVE_VIDEO_PROVIDERS)[number]['id'];

export const findNativeVideoProvider = (id: unknown) =>
  NATIVE_VIDEO_PROVIDERS.find(provider => provider.id === id);

export const isNativeVideoModelSupported = (
  provider: (typeof NATIVE_VIDEO_PROVIDERS)[number],
  model: unknown,
): model is string =>
  typeof model === 'string' &&
  (provider.customModel
    ? /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,447}$/.test(model)
    : (provider.models as readonly string[]).includes(model));
