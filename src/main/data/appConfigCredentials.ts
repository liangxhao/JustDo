import { t } from '../core/i18n';
import { BUILTIN_CREDENTIAL_MARKER, getBuiltinModelProviderApiKey } from '../cowork/builtinModelProviderConfig';

type CredentialCipher = {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  decryptString(value: Buffer): string;
};

const CREDENTIAL_FORMAT = 'justdo-os-credential-v1';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function requireCipher(cipher: CredentialCipher, platform: string): void {
  if (
    !cipher.isEncryptionAvailable() ||
    (platform === 'linux' && ['basic_text', 'unknown'].includes(cipher.getSelectedStorageBackend?.() ?? 'unknown'))
  ) {
    throw new Error(t('credentialStorageUnavailable'));
  }
}

/** Normalize builtin references without changing storage of unrelated user credentials. */
export function transformAppConfigCredentials(
  value: unknown,
  mode: 'encrypt' | 'decrypt',
  cipher: CredentialCipher,
  platform = process.platform,
): unknown {
  if (!isRecord(value)) return value;
  const config = structuredClone(value);
  const builtin = isRecord(config.providers) ? config.providers.builtin_models : undefined;
  if (isRecord(builtin)) {
    const previousKey = builtin.apiKey;
    if (isRecord(config.api) && typeof previousKey === 'string' && previousKey && config.api.key === previousKey) {
      config.api.key = BUILTIN_CREDENTIAL_MARKER;
    }
    builtin.apiKey = BUILTIN_CREDENTIAL_MARKER;
  }
  const transform = (owner: unknown, key: string): void => {
    if (!isRecord(owner)) return;
    const credential = owner[key];
    // Read earlier OS-encrypted legacy records, but do not introduce a key-store
    // dependency for existing plaintext custom credentials or new builtin refs.
    if (mode === 'decrypt' && isRecord(credential) && credential.format === CREDENTIAL_FORMAT) {
      requireCipher(cipher, platform);
      try {
        if (typeof credential.ciphertext !== 'string' || !credential.ciphertext) throw new Error();
        owner[key] = cipher.decryptString(Buffer.from(credential.ciphertext, 'base64'));
      } catch {
        throw new Error(t('credentialDecryptionFailed'));
      }
    }
    if (typeof owner[key] === 'string' && owner[key] === getBuiltinModelProviderApiKey()) {
      owner[key] = BUILTIN_CREDENTIAL_MARKER;
    }
  };
  transform(config.api, 'key');
  return config;
}
