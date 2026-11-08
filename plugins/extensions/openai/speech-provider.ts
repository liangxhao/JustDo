import { normalizeResolvedSecretInputString } from 'openclaw/plugin-sdk/secret-input';
import type {
  SpeechDirectiveTokenParseContext,
  SpeechDirectiveTokenParseResult,
  SpeechProviderPlugin,
  SpeechSynthesisRequest,
} from 'openclaw/plugin-sdk/speech-core';
import { parseSpeechDirectiveNumberOverride } from 'openclaw/plugin-sdk/speech-provider';
import {
  asFiniteNumber,
  asOptionalRecord,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from 'openclaw/plugin-sdk/string-coerce-runtime';

import {
  normalizeSpeechServiceBaseUrl,
  resolveSpeechProtocolSelection,
  resolveSpeechVoiceSelection,
  SPEECH_PROTOCOL_IDS,
  type SpeechVoicePolicy,
} from '../../sdk/speech-protocols/index.js';
import { hasServiceBaseUrl, requireServiceBaseUrl, requireSpeechIdentifier } from './intranet-config.js';
import { resolveOpenAIProviderConfigRecord } from './realtime-provider-shared.js';
import {
  isValidOpenAISpeechIdentifier,
  normalizeOpenAITtsBaseUrl,
  openaiTTS,
} from './tts.js';

const OPENAI_SPEECH_RESPONSE_FORMATS = ['mp3', 'opus', 'wav'] as const;

type OpenAiSpeechResponseFormat = (typeof OPENAI_SPEECH_RESPONSE_FORMATS)[number];

function resolveOpenAISpeechApiKey(
  config: Partial<Pick<ReturnType<typeof normalizeOpenAIProviderConfig>, 'apiKey'>>,
): string | undefined {
  return normalizeOptionalString(config.apiKey);
}

function optionalSpeechIdentifier(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requireSpeechIdentifier(value, label);
}

function normalizeOpenAISpeechResponseFormat(
  value: unknown,
): OpenAiSpeechResponseFormat | undefined {
  const next = normalizeOptionalLowercaseString(value);
  if (!next) {
    return undefined;
  }
  const format = OPENAI_SPEECH_RESPONSE_FORMATS.find(candidate => candidate === next);
  if (format) {
    return format;
  }
  throw new Error(`Invalid OpenAI speech responseFormat: ${next}`);
}

function resolveSpeechResponseFormat(
  target: 'audio-file' | 'voice-note' | 'telephony',
  configuredFormat?: OpenAiSpeechResponseFormat,
): OpenAiSpeechResponseFormat {
  if (configuredFormat) {
    return configuredFormat;
  }
  return target === 'voice-note' ? 'opus' : 'mp3';
}

function readExtraBody(value: unknown): Record<string, unknown> | undefined {
  const body = asOptionalRecord(value);
  if (!body || Object.keys(body).length === 0) {
    return undefined;
  }
  return body;
}

function normalizeOpenAISpeechSpeed(value: unknown): number | undefined {
  const speed = asFiniteNumber(value);
  if (speed === undefined) {
    return undefined;
  }
  if (speed < 0.25 || speed > 4) throw new Error('Invalid speech speed.');
  return speed;
}

function normalizeOpenAIProviderConfig(
  config: Record<string, unknown>,
  source: 'raw' | 'resolved' = 'raw',
) {
  const raw = source === 'raw' ? resolveOpenAIProviderConfigRecord(config, SPEECH_PROTOCOL_IDS.SPEECH_HTTP) : config;
  if (raw?.apiKey !== undefined && typeof raw.apiKey !== 'string')
    throw new Error('The speech credential has not been resolved.');
  const selection = resolveSpeechProtocolSelection(raw, 'speech', SPEECH_PROTOCOL_IDS.SPEECH_HTTP);
  const configuredBaseUrl = normalizeOptionalString(raw?.baseUrl);
  const unresolvedBaseUrl =
    source === 'raw'
      ? normalizeOpenAITtsBaseUrl(configuredBaseUrl)
      : (configuredBaseUrl ?? normalizeOpenAITtsBaseUrl(undefined));
  const baseUrl = unresolvedBaseUrl ? normalizeSpeechServiceBaseUrl(unresolvedBaseUrl, selection) : '';
  const voicePolicy = (raw?.voicePolicy === undefined ? 'preset' : raw.voicePolicy) as SpeechVoicePolicy;
  const legacyVoice = raw?.voice === undefined ? raw?.speakerVoice : raw.voice;
  const voiceSelection = resolveSpeechVoiceSelection(raw?.voiceSelection, selection, voicePolicy, legacyVoice);
  return {
    ...selection,
    apiKey:
      source === 'raw'
        ? normalizeResolvedSecretInputString({
            value: raw?.apiKey,
            path: 'tts.providers.openai.apiKey',
          })
        : normalizeOptionalString(raw?.apiKey),
    baseUrl,
    model: requireSpeechIdentifier(raw?.model, 'speech model'),
    voice: voiceSelection.voiceId,
    voicePolicy,
    voiceSelection,
    speed: normalizeOpenAISpeechSpeed(raw?.speed),
    instructions: normalizeOptionalString(raw?.instructions),
    responseFormat: normalizeOpenAISpeechResponseFormat(raw?.responseFormat),
    extraBody: readExtraBody(raw?.extraBody) ?? readExtraBody(raw?.extra_body),
  };
}

function parseDirectiveToken(
  ctx: SpeechDirectiveTokenParseContext,
): SpeechDirectiveTokenParseResult {
  switch (ctx.key) {
    case 'voice':
    case 'openai_voice':
    case 'openaivoice':
      if (!ctx.policy.allowVoice) {
        return { handled: true };
      }
      if (!isValidOpenAISpeechIdentifier(ctx.value)) {
        return { handled: true, warnings: [`invalid OpenAI voice "${ctx.value}"`] };
      }
      return { handled: true, overrides: { voice: ctx.value } };
    case 'model':
    case 'openai_model':
    case 'openaimodel':
      if (!ctx.policy.allowModelId) {
        return { handled: true };
      }
      if (!isValidOpenAISpeechIdentifier(ctx.value)) {
        return { handled: false };
      }
      return { handled: true, overrides: { model: ctx.value } };
    case 'speed':
    case 'openai_speed':
    case 'openaispeed': {
      return parseSpeechDirectiveNumberOverride({
        ctx,
        overrideKey: 'speed',
        range: { min: 0.25, max: 4 },
        warning: value => `invalid speech speed "${value}" (0.25-4.0)`,
      });
    }
    default:
      return { handled: false };
  }
}

async function resolveOpenAITtsRequest(
  req: SpeechSynthesisRequest,
  responseFormatOverride?: 'pcm',
): Promise<Parameters<typeof openaiTTS>[0]> {
  const config = normalizeOpenAIProviderConfig(req.providerConfig, 'resolved');
  resolveSpeechProtocolSelection(req.providerOverrides ?? {}, 'speech', SPEECH_PROTOCOL_IDS.SPEECH_HTTP);
  const model = optionalSpeechIdentifier(req.providerOverrides?.model, 'speech model') ?? config.model;
  const voice = optionalSpeechIdentifier(req.providerOverrides?.voice, 'speech voice') ?? config.voice;
  const voiceSelection = req.providerOverrides?.voice !== undefined
    ? { kind: 'preset' as const, voiceId: voice! }
    : config.voiceSelection;
  const speed =
    normalizeOpenAISpeechSpeed(req.providerOverrides?.speed) ?? config.speed;
  const apiKey = resolveOpenAISpeechApiKey(config);
  requireServiceBaseUrl(config.baseUrl, 'Speech');
  const responseFormat =
    responseFormatOverride ??
    resolveSpeechResponseFormat(req.target, config.responseFormat);
  const { resolveGeneratedMediaMaxBytes } =
    await import('openclaw/plugin-sdk/media-generation-runtime');
  return {
    text: req.text,
    apiKey: apiKey ?? '',
    baseUrl: config.baseUrl,
    model,
    voice,
    protocolId: config.protocolId,
    voicePolicy: config.voicePolicy,
    voiceSelection,
    speed,
    instructions: config.instructions,
    responseFormat,
    extraBody: config.extraBody,
    timeoutMs: req.timeoutMs,
    maxBytes: resolveGeneratedMediaMaxBytes(req.cfg, 'audio'),
  };
}

export function buildOpenAISpeechProvider(): SpeechProviderPlugin {
  return {
    id: 'openai',
    label: 'OpenAI',
    autoSelectOrder: 10,
    resolveConfig: ({ rawConfig }) => normalizeOpenAIProviderConfig(rawConfig),
    parseDirectiveToken,
    resolveTalkConfig: ({ baseTtsConfig, talkProviderConfig }) => {
      resolveSpeechProtocolSelection(talkProviderConfig, 'speech', SPEECH_PROTOCOL_IDS.SPEECH_HTTP);
      const base = normalizeOpenAIProviderConfig(baseTtsConfig);
      const responseFormat = normalizeOpenAISpeechResponseFormat(talkProviderConfig.responseFormat);
      const baseUrl = normalizeOptionalString(talkProviderConfig.baseUrl) ?? base.baseUrl;
      const speed = normalizeOpenAISpeechSpeed(talkProviderConfig.speed);
      return {
        ...base,
        ...(talkProviderConfig.apiKey === undefined
          ? {}
          : {
              apiKey: normalizeResolvedSecretInputString({
                value: talkProviderConfig.apiKey,
                path: 'talk.providers.openai.apiKey',
              }),
            }),
        baseUrl,
        model: optionalSpeechIdentifier(talkProviderConfig.modelId, 'speech model') ?? base.model,
        voice: optionalSpeechIdentifier(talkProviderConfig.voiceId, 'speech voice') ?? base.voice,
        voiceSelection: talkProviderConfig.voiceId !== undefined
          ? { kind: 'preset', voiceId: requireSpeechIdentifier(talkProviderConfig.voiceId, 'speech voice') }
          : base.voiceSelection,
        speed: speed ?? base.speed,
        instructions: normalizeOptionalString(talkProviderConfig.instructions) ?? base.instructions,
        responseFormat: responseFormat ?? base.responseFormat,
      };
    },
    resolveTalkOverrides: ({ params }) => {
      resolveSpeechProtocolSelection(params, 'speech', SPEECH_PROTOCOL_IDS.SPEECH_HTTP);
      return {
      ...(params.voiceId === undefined
        ? {}
        : { voice: requireSpeechIdentifier(params.voiceId, 'speech voice') }),
      ...(params.modelId === undefined
        ? {}
        : { model: requireSpeechIdentifier(params.modelId, 'speech model') }),
      ...(asFiniteNumber(params.speed) == null ? {} : { speed: asFiniteNumber(params.speed) }),
      };
    },
    isConfigured: ({ providerConfig }) => {
      try {
        const config = normalizeOpenAIProviderConfig(providerConfig, 'resolved');
        return hasServiceBaseUrl(config.baseUrl) && Boolean(config.model);
      } catch {
        return false;
      }
    },
    synthesize: async req => {
      const params = await resolveOpenAITtsRequest(req);
      const audioBuffer = await openaiTTS(params);
      const fileExtension = `.${params.responseFormat}`;
      const { isVoiceMessageCompatibleAudio } = await import('openclaw/plugin-sdk/media-runtime');
      return {
        audioBuffer,
        outputFormat: params.responseFormat,
        fileExtension,
        voiceCompatible:
          req.target === 'voice-note' &&
          isVoiceMessageCompatibleAudio({ fileName: `speech${fileExtension}` }),
      };
    },
    synthesizeTelephony: async req => {
      const params = await resolveOpenAITtsRequest({ ...req, target: 'telephony' }, 'pcm');
      const audioBuffer = await openaiTTS(params);
      return { audioBuffer, outputFormat: 'pcm', sampleRate: 24_000 };
    },
  };
}
