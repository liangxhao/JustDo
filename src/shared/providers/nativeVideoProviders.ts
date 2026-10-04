// Provider/model contracts shipped with the pinned OpenClaw 2026.9.8 runtime.
export const NATIVE_VIDEO_PROVIDERS = [
  {
    id: 'kie',
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
    name: 'Z.AI',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    models: ['cogvideox-3'],
  },
  {
    id: 'novita',
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
