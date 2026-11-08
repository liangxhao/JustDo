export const RealtimeVoiceIpc = {
  GetStatus: 'realtime-voice:get-status',
  Start: 'realtime-voice:start',
  AppendAudio: 'realtime-voice:append-audio',
  Interrupt: 'realtime-voice:interrupt',
  AcknowledgeMark: 'realtime-voice:acknowledge-mark',
  Close: 'realtime-voice:close',
  Event: 'realtime-voice:event',
} as const;

export type RealtimeVoiceUnavailableReason =
  | 'disabled' | 'unconfigured' | 'gateway-unavailable' | 'unsupported' | 'busy' | 'unknown';
export interface RealtimeVoiceStatus {
  available: boolean;
  reason?: RealtimeVoiceUnavailableReason;
  model?: string;
  voice?: string;
}
export interface RealtimeVoiceStartRequest { requestId: string; productSessionId: string }
/** Main-prepared chat identity; never supplied by the media caller. */
export interface RealtimeVoiceSource {
  productSessionId: string;
  sessionKey: string;
  sessionId: string;
}
export interface RealtimeVoiceSession {
  requestId: string;
  voiceSessionId: string;
  source: RealtimeVoiceSource;
  model: string;
  voice: string;
  inputEncoding: 'pcm16';
  inputSampleRateHz: 24000;
  outputEncoding: 'pcm16';
  outputSampleRateHz: 24000;
}
export interface RealtimeVoiceControlRequest { requestId: string; voiceSessionId: string }
export interface RealtimeVoiceAudioRequest extends RealtimeVoiceControlRequest { audioBase64: string }
export interface RealtimeVoiceInterruptRequest extends RealtimeVoiceControlRequest { turnId: string }
export interface RealtimeVoiceMarkRequest extends RealtimeVoiceControlRequest { markName: string }
export interface RealtimeVoiceCloseRequest { requestId: string; voiceSessionId?: string }
export interface RealtimeVoiceEvent {
  requestId: string;
  voiceSessionId: string;
  source: RealtimeVoiceSource;
  type: 'ready' | 'responseStarted' | 'audio' | 'audioDone' | 'clear' | 'mark' |
    'transcript' | 'error' | 'close';
  turnId?: string;
  audioBase64?: string;
  markName?: string;
  role?: 'user' | 'assistant';
  text?: string;
  final?: boolean;
  textMode?: 'snapshot';
  transcriptId?: string;
  reason?: 'completed' | 'error' | 'configuration-changed' | 'connection-changed';
}
/** Renderer-only delivery of already admitted native events; no replay or transcript storage. */
export type RealtimeVoiceTimelineUpdate =
  | { type: 'opened'; session: RealtimeVoiceSession }
  | { type: 'event'; event: RealtimeVoiceEvent }
  | { type: 'ended'; session: RealtimeVoiceSession };
export interface RealtimeVoiceBridge {
  getStatus(): Promise<RealtimeVoiceStatus>;
  start(request: RealtimeVoiceStartRequest): Promise<RealtimeVoiceSession>;
  appendAudio(request: RealtimeVoiceAudioRequest): Promise<void>;
  interrupt(request: RealtimeVoiceInterruptRequest): Promise<void>;
  acknowledgeMark(request: RealtimeVoiceMarkRequest): Promise<void>;
  close(request: RealtimeVoiceCloseRequest): Promise<void>;
  onEvent(listener: (event: RealtimeVoiceEvent) => void): () => void;
}
export const isRealtimeVoiceRequestId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);

export const isRealtimeVoiceIdentity = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 &&
  !/[\u0000-\u0020\u007f]/.test(value);

/** Canonical padded Base64 containing an even number of PCM16 bytes. */
export function isRealtimeVoiceAudio(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 128_000 || value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  if (padding && (alphabet.indexOf(value[value.length - padding - 1]) & (padding === 2 ? 15 : 3)))
    return false;
  return ((value.length / 4) * 3 - padding) % 2 === 0;
}
