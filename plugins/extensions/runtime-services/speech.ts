import path from 'node:path';

import type { OpenClawConfig, OpenClawPluginApi } from 'openclaw/plugin-sdk/core';
import { normalizeResolvedSecretInputString } from 'openclaw/plugin-sdk/secret-input';
import { resolveExplicitTtsOverrides, synthesizeSpeech } from 'openclaw/plugin-sdk/tts-runtime';

import { SPEECH_SYNTHESIS_METHOD } from './contracts/speech';

const MAX_TEXT_LENGTH = 10_000;
const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Reply playback has its own managed profile; it never changes the assistant tool's provider. */
export function registerSpeechSynthesis(api: OpenClawPluginApi): void {
  api.registerGatewayMethod(
    SPEECH_SYNTHESIS_METHOD,
    async ({ params, respond, signal, hasCurrentClientAuthority }) => {
      try {
        const text = typeof params.text === 'string' ? params.text.trim() : '';
        if (
          !text ||
          text.length > MAX_TEXT_LENGTH ||
          Object.keys(params).some(key => key !== 'text')
        )
          throw new Error('Invalid speech text.');
        const cfg = api.runtime.config.current();
        const profile = record(cfg.plugins?.entries?.['runtime-services']?.config?.replySpeech);
        if (
          !profile ||
          typeof profile.baseUrl !== 'string' ||
          typeof profile.model !== 'string' ||
          !profile.model.trim() ||
          typeof profile.speakerVoice !== 'string' ||
          !profile.speakerVoice.trim()
        )
          throw new Error('Reply speech is not configured.');
        const endpoint = new URL(profile.baseUrl);
        if (
          !['http:', 'https:'].includes(endpoint.protocol) ||
          endpoint.username ||
          endpoint.password ||
          endpoint.search ||
          endpoint.hash
        )
          throw new Error('Invalid reply speech endpoint.');
        const fingerprint = JSON.stringify(profile);
        const assertCurrent = () => {
          const current = api.runtime.config.current();
          if (
            signal?.aborted ||
            hasCurrentClientAuthority?.() === false ||
            current.plugins?.enabled === false ||
            current.plugins?.entries?.['runtime-services']?.enabled === false ||
            JSON.stringify(current.plugins?.entries?.['runtime-services']?.config?.replySpeech) !==
              fingerprint
          )
            throw new Error('Reply speech configuration changed.');
        };
        assertCurrent();
        const apiKey = normalizeResolvedSecretInputString({
          value: profile.apiKey,
          path: 'plugins.entries.runtime-services.config.replySpeech.apiKey',
        });
        const stateDir = api.runtime.state.resolveStateDir();
        if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir))
          throw new Error('Managed speech preferences are unavailable.');
        const prefsPath = path.join(stateDir, 'speech-tools', 'reply-preferences.json');
        const providerConfig = {
          baseUrl: endpoint.toString().replace(/\/+$/, ''),
          model: profile.model.trim(),
          speakerVoice: profile.speakerVoice.trim(),
          apiKey: apiKey ?? '',
          responseFormat: 'wav',
        };
        const requestConfig: OpenClawConfig = {
          ...cfg,
          tts: {
            auto: 'off',
            provider: 'openai',
            maxTextLength: MAX_TEXT_LENGTH,
            timeoutMs: 120_000,
            persona: 'reply-reading',
            personas: {
              'reply-reading': {
                provider: 'openai',
                fallbackPolicy: 'fail',
                providers: { openai: providerConfig },
              },
            },
            providers: {
              openai: providerConfig,
            },
          },
        };
        const overrides = resolveExplicitTtsOverrides({
          cfg: requestConfig,
          prefsPath,
          provider: 'openai',
          modelId: profile.model.trim(),
          voiceId: profile.speakerVoice.trim(),
        });
        assertCurrent();
        const result = await synthesizeSpeech({
          text,
          cfg: requestConfig,
          prefsPath,
          overrides,
          disableFallback: true,
          timeoutMs: 120_000,
        });
        assertCurrent();
        if (
          !result.success ||
          !result.audioBuffer?.length ||
          result.audioBuffer.length > MAX_AUDIO_BYTES ||
          result.provider !== 'openai'
        )
          throw new Error('Reply speech synthesis failed.');
        const formats: Record<string, string> = {
          wav: 'audio/wav',
          mp3: 'audio/mpeg',
          opus: 'audio/ogg',
          ogg: 'audio/ogg',
        };
        const extension = result.fileExtension?.replace(/^\./, '') ?? result.outputFormat ?? '';
        if (!formats[extension]) throw new Error('Unsupported speech audio format.');
        respond(true, {
          audioBase64: result.audioBuffer.toString('base64'),
          provider: result.provider,
          outputFormat: result.outputFormat ?? extension,
          fileExtension: extension,
          mimeType: formats[extension],
        });
      } catch {
        respond(false, undefined, {
          code: 'UNAVAILABLE',
          message: 'Reply speech is unavailable. Check its model and voice settings.',
        });
      }
    },
    { scope: 'operator.write' },
  );
}
