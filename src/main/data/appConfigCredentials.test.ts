import { describe, expect, it, vi } from 'vitest';

import { t } from '../core/i18n';
import { transformAppConfigCredentials } from './appConfigCredentials';

const createCipher = () => ({
  isEncryptionAvailable: vi.fn(() => true),
  getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
  encryptString: vi.fn((value: string) => Buffer.from(`test-cipher:${value}`)),
  decryptString: vi.fn((value: Buffer) => value.toString().replace(/^test-cipher:/, '')),
});
const legacyEncryptedConfig = () => ({ api: { key: {
  format: 'justdo-os-credential-v1', ciphertext: Buffer.from('test-cipher:fixture').toString('base64'),
} } });

describe('application credential protection', () => {
  it('stores builtin references without ciphertext or an OS key-store dependency', () => {
    const cipher = createCipher();
    cipher.isEncryptionAvailable.mockReturnValue(false);
    const config = {
      providers: { builtin_models: { apiKey: 'justdo-builtin-credential' } },
      api: { key: 'justdo-builtin-credential' },
    };
    expect(transformAppConfigCredentials(config, 'encrypt', cipher)).toEqual(config);
    expect(cipher.encryptString).not.toHaveBeenCalled();
  });

  it('replaces builtin keys with references and preserves unrelated legacy API keys', () => {
    const cipher = createCipher();
    const config = {
      providers: { builtin_models: { apiKey: 'builtin-fixture-key', models: [] }, custom_1: { apiKey: 'user-key' } },
      api: { key: 'legacy-fixture-key' },
    };
    const encrypted = transformAppConfigCredentials(config, 'encrypt', cipher);
    expect(JSON.stringify(encrypted)).not.toContain('builtin-fixture-key');
    expect(JSON.stringify(encrypted)).toContain('legacy-fixture-key');
    expect(cipher.encryptString).not.toHaveBeenCalled();
    expect(transformAppConfigCredentials(encrypted, 'decrypt', cipher)).toEqual({
      ...config, providers: { ...config.providers, builtin_models: { apiKey: 'justdo-builtin-credential', models: [] } },
    });
    expect(config.providers.builtin_models.apiKey).toBe('builtin-fixture-key');
  });

  it('leaves ciphertext intact during an idempotent legacy conversion', () => {
    const cipher = createCipher();
    const encrypted = legacyEncryptedConfig();
    expect(transformAppConfigCredentials(encrypted, 'encrypt', cipher)).toEqual(encrypted);
    expect(transformAppConfigCredentials(encrypted, 'decrypt', cipher)).toEqual({ api: { key: 'fixture' } });
    expect(cipher.encryptString).not.toHaveBeenCalled();
  });

  it.each(['basic_text', 'unknown'])('refuses the insecure Linux %s backend', backend => {
    const cipher = createCipher();
    cipher.getSelectedStorageBackend.mockReturnValue(backend);
    expect(() => transformAppConfigCredentials(legacyEncryptedConfig(), 'decrypt', cipher, 'linux'))
      .toThrow(t('credentialStorageUnavailable'));
    expect(cipher.encryptString).not.toHaveBeenCalled();
  });

  it('does not fall back to plaintext when the OS key store is unavailable', () => {
    const cipher = createCipher();
    cipher.isEncryptionAvailable.mockReturnValue(false);
    expect(() => transformAppConfigCredentials(legacyEncryptedConfig(), 'decrypt', cipher))
      .toThrow(t('credentialStorageUnavailable'));
  });

  it('reports decryption failures without including the credential or cipher diagnostic', () => {
    const cipher = createCipher();
    const encrypted = legacyEncryptedConfig();
    cipher.decryptString.mockImplementation(() => { throw new Error('sensitive native diagnostic'); });
    expect(() => transformAppConfigCredentials(encrypted, 'decrypt', cipher))
      .toThrow(t('credentialDecryptionFailed'));
  });
  it('does not block Linux users with unrelated legacy plaintext credentials', () => {
    const cipher = createCipher();
    cipher.isEncryptionAvailable.mockReturnValue(false);
    const config = { api: { key: 'user-owned-key' } };
    expect(transformAppConfigCredentials(config, 'encrypt', cipher, 'linux')).toEqual(config);
    expect(transformAppConfigCredentials(config, 'decrypt', cipher, 'linux')).toEqual(config);
    expect(cipher.isEncryptionAvailable).not.toHaveBeenCalled();
  });
});
