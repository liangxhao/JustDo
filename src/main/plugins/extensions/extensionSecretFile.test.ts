import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { t } from '../../core/i18n';
import { restrictCredentialFile } from '../../openclaw/config/providerSecretFile';
import {
  EXTENSION_SECRET_PROVIDER,
  isExtensionSecretReferenceField,
  saveExtensionSecrets,
} from './extensionSecretFile';

vi.mock('../../openclaw/config/providerSecretFile', () => ({ restrictCredentialFile: vi.fn() }));

describe('extension SecretRef credentials', () => {
  let directory: string;
  beforeEach(() => {
    vi.mocked(restrictCredentialFile).mockReset();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-extension-secrets-'));
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('recognizes the upstream TypeSafe secret contract without changing legacy string fields', () => {
    const manifest = JSON.parse(
      fs.readFileSync('openclaw-extensions/typesafe/openclaw.plugin.json', 'utf8'),
    );
    expect(isExtensionSecretReferenceField(manifest, 'apiKey')).toBe(true);
    expect(isExtensionSecretReferenceField(manifest, 'model')).toBe(false);
    manifest.configSchema.properties.apiKey = { type: 'string' };
    expect(isExtensionSecretReferenceField(manifest, 'apiKey')).toBe(false);
  });

  it('protects the empty file before writing secrets and publishes only references', () => {
    vi.mocked(restrictCredentialFile).mockImplementation(file => {
      expect(fs.readFileSync(file, 'utf8')).toBe('');
    });
    const config = { secrets: { providers: { other: { source: 'env' } } } };
    const result = saveExtensionSecrets(config, directory, 'typesafe', { apiKey: 'synthetic-key' });
    expect(result.changed).toBe(true);
    expect(result.references.apiKey).toMatchObject({
      source: 'file',
      provider: EXTENSION_SECRET_PROVIDER,
    });
    expect(JSON.stringify(config)).not.toContain('synthetic-key');
    expect(config.secrets.providers.other).toEqual({ source: 'env' });
    const stored = JSON.parse(
      fs.readFileSync(path.join(directory, 'extension-secrets.json'), 'utf8'),
    );
    expect(stored[result.references.apiKey.id.slice(1)]).toBe('synthetic-key');
    expect(restrictCredentialFile).toHaveBeenCalledTimes(1);
  });

  it('detects rotation with stable references while preserving other extension credentials', () => {
    const config = {};
    const other = saveExtensionSecrets(config, directory, 'other', { apiKey: 'other-key' });
    const first = saveExtensionSecrets(config, directory, 'typesafe', { apiKey: 'old-key' });
    expect(saveExtensionSecrets(config, directory, 'typesafe', { apiKey: 'old-key' }).changed).toBe(
      false,
    );
    const rotated = saveExtensionSecrets(config, directory, 'typesafe', { apiKey: 'new-key' });
    expect(rotated).toEqual({ references: first.references, changed: true });
    const stored = JSON.parse(
      fs.readFileSync(path.join(directory, 'extension-secrets.json'), 'utf8'),
    );
    expect(stored[other.references.apiKey.id.slice(1)]).toBe('other-key');
    expect(stored[first.references.apiKey.id.slice(1)]).toBe('new-key');
  });

  it('does not publish a reference or credential when file protection fails', () => {
    vi.mocked(restrictCredentialFile).mockImplementation(() => {
      throw new Error('ACL unavailable');
    });
    const config = {};
    expect(() =>
      saveExtensionSecrets(config, directory, 'typesafe', { apiKey: 'synthetic-key' }),
    ).toThrow(t('extensionCredentialStoreWriteFailed'));
    expect(config).toEqual({});
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('never includes malformed credential contents in errors or overwrites them', () => {
    const file = path.join(directory, 'extension-secrets.json');
    fs.writeFileSync(file, '{"private-credential":"secret-value"');
    expect(() =>
      saveExtensionSecrets({}, directory, 'typesafe', { apiKey: 'replacement' }),
    ).toThrow(t('extensionCredentialStoreUnavailable'));
    expect(fs.readFileSync(file, 'utf8')).toBe('{"private-credential":"secret-value"');
    expect(saveExtensionSecrets({}, directory, 'legacy', {})).toEqual({
      references: {},
      changed: false,
    });
  });
});
