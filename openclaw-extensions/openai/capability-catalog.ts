import type { PluginCapabilityCatalogHostEntry } from 'openclaw/plugin-sdk/plugin-entry';

import { configureTranscriptionProvider } from './media-adapters';
import native from './native-capability-catalog.mjs';

const catalog: PluginCapabilityCatalogHostEntry = context => {
  const baseline = native(context);
  return {
    ...baseline,
    realtimeTranscriptionProviders: baseline.realtimeTranscriptionProviders?.map(provider => {
      if (provider.id !== 'openai') return provider;
      const factory = configureTranscriptionProvider(sessionContext => {
        const selected = native(sessionContext).realtimeTranscriptionProviders?.find(
          entry => entry.id === 'openai',
        );
        if (!selected) throw new Error('Native OpenAI transcription catalog is unavailable');
        return selected;
      });
      return factory(context);
    }),
  };
};

export default catalog;
