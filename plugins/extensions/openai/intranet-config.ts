import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import { normalizeResolvedSecretInputString } from 'openclaw/plugin-sdk/secret-input';

import { OpenAiCompatibleMediaConfigProviderIds } from './contracts/media-config.js';

/** Endpoints are configured per capability; absence must never select a public service. */
function requireBaseUrl(value: unknown, capability: string, protocols: readonly string[]): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${capability} service URL is required.`);
  const url = new URL(value.trim());
  if (!protocols.includes(url.protocol) || url.username || url.password || url.hash)
    throw new Error(`Invalid ${capability} service URL.`);
  return url.toString().replace(/\/+$/, '');
}

export function requireServiceBaseUrl(value: unknown, capability: string): string {
  return requireBaseUrl(value, capability, ['http:', 'https:']);
}

export function hasServiceBaseUrl(value: unknown): boolean {
  try {
    requireServiceBaseUrl(value, 'OpenAI-compatible');
    return true;
  } catch {
    return false;
  }
}

export function hasTranscriptionBaseUrl(value: unknown): boolean {
  try {
    resolveTranscriptionUrl(value);
    return true;
  } catch {
    return false;
  }
}

export function resolveTranscriptionUrl(baseUrl: unknown): string {
  const url = new URL(requireBaseUrl(baseUrl, 'Transcription', ['http:', 'https:', 'ws:', 'wss:']));
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = pathname.endsWith('/realtime') ? pathname : `${pathname}/realtime`;
  url.searchParams.set('intent', 'transcription');
  return url.toString();
}

export function resolveServiceApiKey(value: unknown, path: string): string | undefined {
  return normalizeResolvedSecretInputString({ value, path });
}

export function imageConfig(cfg: OpenClawConfig | undefined): OpenClawConfig {
  const providers = { ...cfg?.models?.providers };
  delete providers.openai;
  const isolated = providers[OpenAiCompatibleMediaConfigProviderIds.image];
  if (isolated) providers.openai = isolated;
  return { ...cfg, models: { ...cfg?.models, providers } };
}
