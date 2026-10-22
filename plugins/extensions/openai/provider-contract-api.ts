import type { ProviderPlugin } from 'openclaw/plugin-sdk/provider-model-shared';
export function createOpenAIProvider(): ProviderPlugin {
  return {
    id: 'openai',
    label: 'OpenAI-compatible',
    hookAliases: ['azure-openai', 'azure-openai-responses'],
    docsPath: '/providers/models',
    envVars: [],
    auth: [],
  };
}
