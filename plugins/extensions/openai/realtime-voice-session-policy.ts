import type { RealtimeVoiceAudioFormat, RealtimeVoiceBridgeCreateRequest, RealtimeVoiceTool } from 'openclaw/plugin-sdk/realtime-voice';
import { REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ, toOpenAICompatibleRealtimeAudioFormat } from 'openclaw/plugin-sdk/realtime-voice-provider';

import { requireSpeechIdentifier } from './intranet-config.js';
import type { OpenAIRealtimeHost } from './realtime-host.js';

export type OpenAIRealtimeUserMessageOptions = { toolChoice?: { type: 'function'; name: string } };
export type OpenAIRealtimeVoiceBridgeConfig = RealtimeVoiceBridgeCreateRequest & {
  baseUrl: string; model: string; voice: string; apiKey: string; inputTranscriptionModel: string;
  managedEndpoint?: boolean; temperature?: number; vadThreshold?: number; silenceDurationMs?: number;
  prefixPaddingMs?: number; minBargeInAudioEndMs?: number; reasoningEffort?: string;
  interruptResponseOnInputAudio?: boolean;
  logger: Pick<import('openclaw/plugin-sdk/plugin-entry').PluginLogger, 'warn'>;
};

export const OPENAI_REALTIME_ACTIVE_RESPONSE_ERROR_PREFIX =
  'Conversation already has an active response in progress:';
export const OPENAI_REALTIME_NO_ACTIVE_RESPONSE_CANCEL_ERROR =
  'Cancellation failed: no active response found';
const OPENAI_REALTIME_MAX_SESSION_DURATION_FRAGMENT = 'maximum duration';
export const OPENAI_VOICE_WS_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
export const OPENAI_REALTIME_SIDEBAND_STARTUP_MAX_BYTES = 1024 * 1024;
export const OPENAI_REALTIME_DEFAULT_MIN_BARGE_IN_AUDIO_END_MS = 250;
// Realtime validates this character set but accepts names beyond the 64-character
// cap used by other OpenAI tool surfaces.
const OPENAI_REALTIME_TOOL_NAME_RE = /^[A-Za-z0-9_-]+$/;
export type RealtimeEvent = {
  type: string;
  delta?: string;
  data?: string;
  text?: string;
  transcript?: string;
  item_id?: string;
  response_id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  session?: unknown;
  item?: {
    id?: string;
    type?: string;
    name?: string;
    call_id?: string;
    arguments?: string;
  };
  response?: {
    id?: string;
    status?: string;
    status_details?: unknown;
    output?: unknown[];
  };
  error?: unknown;
};

export function normalizeOpenAIRealtimeTools(
  tools: RealtimeVoiceTool[] | undefined,
  warn: OpenAIRealtimeHost['warn'],
  maxNameLength?: number,
): RealtimeVoiceTool[] | undefined {
  const normalized: RealtimeVoiceTool[] = [];
  let omitted = 0;
  for (const tool of tools ?? []) {
    try {
      const name = tool.name;
      if (typeof name !== 'string') {
        omitted += 1;
        continue;
      }
      const exceedsLengthLimit = maxNameLength !== undefined && name.length > maxNameLength;
      if (exceedsLengthLimit || !OPENAI_REALTIME_TOOL_NAME_RE.test(name)) {
        omitted += 1;
        continue;
      }
      normalized.push({
        type: 'function',
        name,
        description: tool.description,
        parameters: tool.parameters,
      });
    } catch {
      omitted += 1;
    }
  }
  if (omitted > 0) {
    warn(`openai realtime: omitted ${omitted} tool definition(s) with unsupported names`);
  }
  return normalized.length > 0 ? normalized : undefined;
}

export function buildOpenAIRealtimeTurnDetectionConfig(params: {
  autoRespondToAudio?: boolean;
  createResponse?: boolean;
  includeInterruptResponse?: boolean;
  interruptResponseOnInputAudio?: boolean;
  prefixPaddingMs?: number;
  silenceDurationMs?: number;
  vadThreshold?: number;
}) {
  const configuredAutoResponse = params.autoRespondToAudio ?? true;
  return {
    type: 'server_vad' as const,
    threshold: params.vadThreshold ?? 0.5,
    prefix_padding_ms: params.prefixPaddingMs ?? 300,
    silence_duration_ms: params.silenceDurationMs ?? 500,
    create_response: params.createResponse ?? configuredAutoResponse,
    ...(params.includeInterruptResponse
      ? {
          interrupt_response: params.interruptResponseOnInputAudio ?? configuredAutoResponse,
        }
      : {}),
  };
}

export function buildOpenAIRealtimeGaSessionPolicy(params: {
  audioFormat?: RealtimeVoiceAudioFormat;
  autoRespondToAudio?: boolean;
  instructions?: string;
  interruptResponseOnInputAudio?: boolean;
  language?: string;
  inputTranscriptionModel: string;
  model: string;
  noiseReduction: { type: 'near_field' } | null;
  prefixPaddingMs?: number;
  reasoningEffort?: string;
  silenceDurationMs?: number;
  tools?: RealtimeVoiceTool[];
  vadThreshold?: number;
  voice: string;
}) {
  const format = toOpenAICompatibleRealtimeAudioFormat(
    params.audioFormat ?? REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  );
  return {
    type: 'realtime' as const,
    model: requireSpeechIdentifier(params.model, 'realtime model'),
    ...(params.instructions !== undefined ? { instructions: params.instructions } : {}),
    output_modalities: ['audio'],
    audio: {
      input: {
        format,
        noise_reduction: params.noiseReduction,
        transcription: {
          model: requireSpeechIdentifier(params.inputTranscriptionModel, 'input transcription model'),
          ...(params.language ? { language: params.language } : {}),
        },
        turn_detection: buildOpenAIRealtimeTurnDetectionConfig({
          autoRespondToAudio: params.autoRespondToAudio,
          includeInterruptResponse: true,
          interruptResponseOnInputAudio: params.interruptResponseOnInputAudio,
          prefixPaddingMs: params.prefixPaddingMs,
          silenceDurationMs: params.silenceDurationMs,
          vadThreshold: params.vadThreshold,
        }),
      },
      output: {
        format,
        voice: requireSpeechIdentifier(params.voice, 'realtime voice'),
      },
    },
    ...(params.reasoningEffort ? { reasoning: { effort: params.reasoningEffort } } : {}),
    ...(params.tools ? { tools: params.tools, tool_choice: 'auto' } : {}),
  };
}

export function isOpenAIRealtimeMaxSessionDurationError(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return (
    normalized.includes('session') &&
    normalized.includes(OPENAI_REALTIME_MAX_SESSION_DURATION_FRAGMENT)
  );
}

export function parsePlaybackMarkSequence(markName: string): number | undefined {
  const match = /^audio-(\d+)$/u.exec(markName);
  if (!match) {
    return undefined;
  }
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : undefined;
}
