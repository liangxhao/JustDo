import type { SpeechProviderPlugin } from 'openclaw/plugin-sdk/speech-core';

import { buildCliSpeechProvider as buildLocalSpeechProvider } from './cli-speech-provider.js';
import { readOnlineSpeechConfig, synthesizeOnlineSpeech } from './online.js';

/** Keep the native provider identity and optional-plugin gate for both modes. */
export function buildCliSpeechProvider(): SpeechProviderPlugin {
  const local = buildLocalSpeechProvider();
  return {
    ...local,
    label: 'Configured speech',
    isConfigured(ctx) {
      if (ctx.providerConfig.mode !== 'online') return local.isConfigured(ctx);
      try {
        readOnlineSpeechConfig(ctx.providerConfig);
        return true;
      } catch {
        return false;
      }
    },
    async synthesize(req) {
      return req.providerConfig.mode === 'online'
        ? synthesizeOnlineSpeech(req)
        : local.synthesize(req);
    },
    async synthesizeTelephony(req) {
      if (req.providerConfig.mode === 'online')
        throw new Error('Online assistant speech does not support telephony.');
      return local.synthesizeTelephony!(req);
    },
  };
}
