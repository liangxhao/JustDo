import { asOptionalRecord } from 'openclaw/plugin-sdk/string-coerce-runtime';

import type { SpeechProtocolId } from '../../sdk/speech-protocols/index.js';

export function readRealtimeErrorDetail(error: unknown): string {
  if (typeof error === 'string' && error) {
    return error;
  }
  const message = asOptionalRecord(error)?.message;
  if (typeof message === 'string' && message) {
    return message;
  }
  return 'Unknown error';
}

export function resolveOpenAIProviderConfigRecord(
  config: Record<string, unknown>,
  expectedProtocol: SpeechProtocolId,
): Record<string, unknown> | undefined {
  if (Object.hasOwn(config, 'compatibilityProfile'))
    throw new Error('Unsupported speech configuration field.');
  const providers = asOptionalRecord(config.providers);
  const resolved = (
    asOptionalRecord(providers?.openai) ??
    asOptionalRecord(config.openai) ??
    asOptionalRecord(config)
  );
  if (resolved && Object.hasOwn(resolved, 'compatibilityProfile'))
    throw new Error('Unsupported speech configuration field.');
  for (const input of [config, resolved]) {
    if (input && Object.hasOwn(input, 'protocolId') && input.protocolId !== undefined && input.protocolId !== expectedProtocol)
      throw new Error('Unsupported speech protocol.');
  }
  // A wrapper cannot hide an authored protocol or turn a managed choice into legacy defaults.
  return resolved && resolved !== config && config.protocolId !== undefined && Object.hasOwn(config, 'protocolId')
    ? { ...resolved, protocolId: config.protocolId } : resolved;
}
