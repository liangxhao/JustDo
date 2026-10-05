export const OnlineTtsIpc = {
  GetStatus: 'online-tts:get-status',
  GetConfiguration: 'online-tts:get-configuration',
  SaveConfiguration: 'online-tts:save-configuration',
  ClearConfiguration: 'online-tts:clear-configuration',
} as const;

export interface OnlineTtsProvider {
  id: string;
  label: string;
  configured: boolean;
}

export interface OnlineTtsStatus {
  available: boolean;
  provider?: string;
  error?: string;
}

export interface OnlineTtsConfiguration extends OnlineTtsStatus {
  providers: OnlineTtsProvider[];
  selectedProvider?: string;
  baseUrl?: string;
  model?: string;
  voice?: string;
  credentialConfigured: boolean;
}

export interface OnlineTtsConfigurationUpdate {
  provider: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  voice: string;
}
