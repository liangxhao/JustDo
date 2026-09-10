import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { providerSecretIdentity, syncProviderSecretFile } from './providerSecretFile';

const directories: string[] = [];
const fixture = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-provider-secrets-'));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('managed provider secret files', () => {
  it('keeps credential values out of config and preserves unrelated secret providers', () => {
    const directory = fixture();
    const config = {
      models: { providers: { local: { apiKey: '${JUSTDO_APIKEY_CUSTOM_1}' } } },
      secrets: { providers: { external: { source: 'env' } } },
    };
    const result = syncProviderSecretFile(config, directory, { CUSTOM_1: 'fixture-key' });
    expect(result.secretsChanged).toBe(true);
    expect(JSON.stringify(result.config)).not.toContain('fixture-key');
    expect(result.config).toMatchObject({
      models: { providers: { local: { apiKey: { source: 'file', provider: 'justdo-model-providers', id: '/CUSTOM_1' } } } },
      secrets: { providers: { external: { source: 'env' } } },
    });
    expect(config.models.providers.local.apiKey).toBe('${JUSTDO_APIKEY_CUSTOM_1}');
    const file = path.join(directory, 'model-provider-secrets.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ CUSTOM_1: 'fixture-key' });
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('reports key rotation without changing the stable config and skips unchanged writes', () => {
    const directory = fixture();
    const config = { models: { providers: { custom: { apiKey: '${JUSTDO_APIKEY_CUSTOM_1}' } } } };
    const first = syncProviderSecretFile(config, directory, { CUSTOM_1: 'first' });
    const rotated = syncProviderSecretFile(first.config, directory, { CUSTOM_1: 'second' });
    expect(rotated.config).toEqual(first.config);
    expect(rotated.secretsChanged).toBe(true);
    expect(syncProviderSecretFile(rotated.config, directory, { CUSTOM_1: 'second' }).secretsChanged).toBe(false);
  });

  it('removes credentials for removed providers and leaves built-in login separate', () => {
    const directory = fixture();
    syncProviderSecretFile({ models: { providers: { custom: { apiKey: '${JUSTDO_APIKEY_CUSTOM_1}' } } } }, directory, { CUSTOM_1: 'old' });
    const config = { models: { providers: { builtin: { apiKey: '${JUSTDO_APIKEY_BUILTIN_MODELS}' } } } };
    expect(syncProviderSecretFile(config, directory, { BUILTIN_MODELS: 'builtin' }).config).toEqual(config);
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'model-provider-secrets.json'), 'utf8'))).toEqual({});
  });

  it('retains provider identity when matching renamed providers after login', () => {
    expect(providerSecretIdentity({ source: 'file', provider: 'justdo-model-providers', id: '/CUSTOM_1' }))
      .toBe('${JUSTDO_APIKEY_CUSTOM_1}');
    expect(providerSecretIdentity({ source: 'file', provider: 'external', id: '/CUSTOM_1' })).toBe('');
  });

  it('fails without exposing missing credential values', () => {
    expect(() => syncProviderSecretFile({ models: { providers: { custom: { apiKey: '${JUSTDO_APIKEY_CUSTOM_1}' } } } }, fixture(), {}))
      .toThrow('A managed model provider credential is unavailable.');
  });
});
