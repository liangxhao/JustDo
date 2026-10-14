import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { createOpenAIProvider } from './provider-contract-api.js';
export const buildOpenAISetupProvider = createOpenAIProvider;
export default definePluginEntry({
  id: 'openai',
  name: 'OpenAI-compatible Setup',
  description: 'Configured intranet provider without public account onboarding',
  register(api) {
    api.registerProvider(buildOpenAISetupProvider());
  },
});
