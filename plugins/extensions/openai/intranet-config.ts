import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import { normalizeResolvedSecretInputString } from 'openclaw/plugin-sdk/secret-input';

import { normalizeSpeechServiceBaseUrl, SPEECH_PROTOCOL_IDS } from '../../sdk/speech-protocols/index.js';
import { OpenAiCompatibleMediaConfigProviderIds } from './contracts/media-config.js';

export function requireSpeechIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error(`An explicit ${label} is required.`);
  return value.trim();
}

/** Endpoints are configured per capability; absence must never select a public service. */
function requireBaseUrl(value: unknown, capability: string, protocols: readonly string[]): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048)
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
  if (url.search && ([...url.searchParams.keys()].length !== 1 || url.searchParams.get('intent') !== 'transcription'))
    throw new Error('Invalid transcription service URL.');
  url.search = '';
  const normalized = new URL(normalizeSpeechServiceBaseUrl(url.toString(), { protocolId: SPEECH_PROTOCOL_IDS.TRANSCRIPTION_REALTIME }));
  normalized.protocol = normalized.protocol.replace('http', 'ws');
  normalized.pathname = `${normalized.pathname.replace(/\/+$/, '')}/realtime`;
  normalized.searchParams.set('intent', 'transcription');
  return normalized.toString();
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
