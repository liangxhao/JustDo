import { resolvePluginConfigObject } from 'openclaw/plugin-sdk/plugin-config-runtime';
import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import {
  resolveGpt5PromptOverlayMode,
  resolveGpt5SystemPromptContribution,
} from 'openclaw/plugin-sdk/provider-model-metadata';
import { buildProviderToolCompatFamilyHooks } from 'openclaw/plugin-sdk/provider-tools';
import { buildOpenAIImageGenerationProvider } from './image-generation-provider.js';
import { openaiMediaUnderstandingProvider } from './media-understanding-provider.js';
import { openAiMemoryEmbeddingProviderAdapter } from './memory-embedding-adapter.js';
import { buildOpenAIProvider } from './openai-provider.js';
import { buildOpenAIRealtimeTranscriptionProvider } from './realtime-transcription-provider-factory.js';
import { buildIntranetVideoProvider } from './video-provider.js';
import { buildOpenAISpeechProvider } from './speech-provider.js';

export default definePluginEntry({
  id: 'openai',
  name: 'OpenAI Provider',
  description: 'Bundled OpenAI provider plugins',
  register(api) {
    const openAIToolCompatHooks = buildProviderToolCompatFamilyHooks('openai');
    const provider = buildOpenAIProvider();
    api.registerProvider({
      ...provider,
      ...openAIToolCompatHooks,
      resolveSystemPromptContribution: ctx => {
        const runtimePluginConfig = resolvePluginConfigObject(ctx.config, 'openai');
        const pluginConfig =
          runtimePluginConfig ??
          (ctx.config ? undefined : (api.pluginConfig as Record<string, unknown>));
        return resolveGpt5SystemPromptContribution({
          config: ctx.config,
          legacyPluginConfig: {
            personality: resolveGpt5PromptOverlayMode(undefined, pluginConfig),
          },
          modelId: ctx.modelId,
          trigger: ctx.trigger,
        });
      },
    });
    api.registerEmbeddingProvider(openAiMemoryEmbeddingProviderAdapter);
    api.registerImageGenerationProvider(buildOpenAIImageGenerationProvider());
    api.registerVideoGenerationProvider(buildIntranetVideoProvider());
    api.registerRealtimeTranscriptionProvider(buildOpenAIRealtimeTranscriptionProvider);
    api.registerSpeechProvider(buildOpenAISpeechProvider());
    api.registerMediaUnderstandingProvider(openaiMediaUnderstandingProvider);
  },
});
