import { createDecipheriv, createHash } from 'node:crypto';

export const BUILTIN_CREDENTIAL_MARKER = 'justdo-builtin-credential';

/** Only Main's direct model requests materialize this non-secret config reference. */
export function resolveBuiltinRequestApiKey(apiKey: string, baseUrl: string): string {
  if (apiKey !== BUILTIN_CREDENTIAL_MARKER) return apiKey;
  if (baseUrl.replace(/\/+$/, '') !== BUILTIN_MODEL_PROVIDER_CONFIG.baseUrl.replace(/\/+$/, '')) {
    throw new Error('Builtin credential target does not match.');
  }
  return getBuiltinModelProviderApiKey();
}

export const BUILTIN_MODEL_PROVIDER_CONFIG = {
  enabled: true,
  baseUrl: 'http://127.0.0.1:9108/v1',
} as const;

// Public wrapping material only obscures the bundled value from direct file
// inspection. It is NOT a boundary against reverse engineering; JWT replaces
// this bootstrap mechanism. Runtime credentials use an encrypted binary file.
const BUNDLED_CREDENTIAL = '/mLlhw0zyuj+sMg1DKtp3PAWj764uZuzVR6vgJn7PjSw2YRBLw==';

export function getBuiltinModelProviderApiKey(): string {
  const data = Buffer.from(BUNDLED_CREDENTIAL, 'base64');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    createHash('sha256').update('justdo/builtin-provider/config/v1').digest(),
    data.subarray(0, 12),
  );
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
}
