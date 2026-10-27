export const WebpageEmbedSettingsIpc = {
  Get: 'webpage-embed:settings:get',
  Save: 'webpage-embed:settings:save',
} as const;

export interface WebpageEmbedSettings {
  allowExternalEmbedUrls: boolean;
  revision: string;
  applied: boolean;
}

export interface WebpageEmbedSettingsUpdate {
  allowExternalEmbedUrls: boolean;
  revision: string;
}

export type WebpageEmbedSettingsErrorCode =
  'invalid' | 'busy' | 'configuration' | 'conflict' | 'forbidden' | 'unavailable' | 'unknown';

export type WebpageEmbedSettingsResult =
  { success: true; value: WebpageEmbedSettings } |
  { success: false; code: WebpageEmbedSettingsErrorCode };

export interface WebpageEmbedSettingsApi {
  getSettings: () => Promise<WebpageEmbedSettingsResult>;
  saveSettings: (input: WebpageEmbedSettingsUpdate) => Promise<WebpageEmbedSettingsResult>;
}
