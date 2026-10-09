import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core';

import { buildIntranetVideoProvider, PROVIDER_ID } from './video-provider.js';

export default {
  id: PROVIDER_ID,
  name: 'Video models',
  description: 'Video generation through an explicitly configured OpenAI-compatible endpoint.',
  register(api: OpenClawPluginApi) {
    api.registerVideoGenerationProvider(buildIntranetVideoProvider());
  },
};
