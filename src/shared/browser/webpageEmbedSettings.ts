export const DEFAULT_ALLOW_EXTERNAL_EMBED_URLS = true;

/** Read the resolved native configuration; malformed values never enable embedding. */
export function readExternalEmbedUrlsAllowed(config: unknown): boolean {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isRecord(config)) throw new Error('Invalid webpage embed configuration');
  const gateway = config.gateway;
  if (gateway !== undefined && !isRecord(gateway))
    throw new Error('Invalid webpage embed configuration');
  const controlUi = isRecord(gateway) ? gateway.controlUi : undefined;
  if (controlUi !== undefined && !isRecord(controlUi))
    throw new Error('Invalid webpage embed configuration');
  const allowed = isRecord(controlUi) ? controlUi.allowExternalEmbedUrls : undefined;
  if (allowed !== undefined && typeof allowed !== 'boolean')
    throw new Error('Invalid webpage embed configuration');
  return typeof allowed === 'boolean' ? allowed : DEFAULT_ALLOW_EXTERNAL_EMBED_URLS;
}

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
