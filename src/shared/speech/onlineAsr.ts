import type { LocalAsrLanguage } from './localAsr';

export const OnlineAsrIpc = {
  GetStatus: 'online-asr:get-status',
  GetConfiguration: 'online-asr:get-configuration',
  SaveConfiguration: 'online-asr:save-configuration',
  ClearConfiguration: 'online-asr:clear-configuration',
  Start: 'online-asr:start',
  AppendAudio: 'online-asr:append-audio',
  Close: 'online-asr:close',
  Event: 'online-asr:event',
  Transcribe: 'online-asr:transcribe',
  CancelTranscription: 'online-asr:cancel-transcription',
} as const;

export interface OnlineAsrProvider {
  id: string;
  label: string;
  configured: boolean;
}

export interface OnlineAsrConfiguration extends OnlineAsrStatus {
  providers: OnlineAsrProvider[];
  selectedProvider?: string;
  baseUrl?: string;
  model?: string;
  credentialConfigured: boolean;
}

export interface OnlineAsrConfigurationUpdate {
  modelRef: string;
  bindingId?: string;
}

export interface OnlineAsrStatus {
  available: boolean;
  inputMode?: 'recording' | 'realtime';
  provider?: string;
  error?: string;
}

export interface OnlineAsrTranscribeRequest {
  requestId: string;
  audioWav: Uint8Array;
  language: LocalAsrLanguage;
}

export interface OnlineAsrTranscribeResult {
  requestId: string;
  text: string;
}

export interface OnlineAsrSession {
  sessionId: string;
  transcriptionSessionId: string;
  provider?: string;
  inputEncoding: 'g711_ulaw';
  inputSampleRateHz: 8000;
}

export interface OnlineAsrEvent {
  transcriptionSessionId: string;
  type: 'ready' | 'inputAudio' | 'partial' | 'transcript' | 'speechStart' | 'error' | 'close';
  text?: string;
  final?: boolean;
  message?: string;
  reason?: 'completed' | 'error';
}

export interface OnlineAsrStartOptions {
  language: LocalAsrLanguage;
}
