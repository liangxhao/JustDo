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
  provider: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
}

export interface OnlineAsrStatus {
  available: boolean;
  provider?: string;
  error?: string;
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
