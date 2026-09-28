import fs from 'node:fs';

import { expect, test, vi } from 'vitest';

import { BUILTIN_MODEL_AUTH_CONFIG } from '../../config/builtinModelAuth';
import {
  getBuiltinModelAuthConfig,
  resolveBuiltinModelDevelopmentApiKey,
  validateBuiltinModelAuthConfig,
} from './builtinModelAuthConfig';

test('reads bundled TypeScript configuration without a user-data file', () => {
  expect(getBuiltinModelAuthConfig()).toEqual(BUILTIN_MODEL_AUTH_CONFIG);
  expect(Object.isFrozen(BUILTIN_MODEL_AUTH_CONFIG)).toBe(true);
});

test.each([300, 900, 10800])('accepts an explicit %i-second deployment policy', maxJwtLifetimeSeconds => {
  expect(validateBuiltinModelAuthConfig({
    tokenExchangeUrl: ' https://issuer.test/api/litellm/mtoken2jwt ',
    maxJwtLifetimeSeconds,
    developmentAuthMode: 'jwt',
    developmentApiKey: '',
  })).toEqual({
    tokenExchangeUrl: 'https://issuer.test/api/litellm/mtoken2jwt',
    maxJwtLifetimeSeconds,
    developmentAuthMode: 'jwt',
    developmentApiKey: '',
  });
});

test.each([
  { tokenExchangeUrl: 'file:///secret', maxJwtLifetimeSeconds: 300, developmentAuthMode: 'jwt', developmentApiKey: '' },
  { tokenExchangeUrl: 'https://user:password@issuer.test', maxJwtLifetimeSeconds: 300, developmentAuthMode: 'jwt', developmentApiKey: '' },
  { tokenExchangeUrl: '', maxJwtLifetimeSeconds: 10801, developmentAuthMode: 'jwt', developmentApiKey: '' },
  { tokenExchangeUrl: '', maxJwtLifetimeSeconds: 300, developmentAuthMode: 'invalid', developmentApiKey: '' },
  { tokenExchangeUrl: '', maxJwtLifetimeSeconds: 300, developmentAuthMode: 'api-key', developmentApiKey: 'bad\nkey' },
  null,
])('rejects invalid configuration without exposing its contents', config => {
  expect(() => validateBuiltinModelAuthConfig(config)).toThrow('Invalid model authentication configuration.');
});

test('resolves the API key only for an unpackaged process', () => {
  const config = validateBuiltinModelAuthConfig({
    ...BUILTIN_MODEL_AUTH_CONFIG,
    developmentAuthMode: 'api-key',
    developmentApiKey: '  sk-development  ',
  });
  expect(resolveBuiltinModelDevelopmentApiKey(config, false)).toBe('sk-development');
  expect(resolveBuiltinModelDevelopmentApiKey(config, true)).toBe('');
  expect(resolveBuiltinModelDevelopmentApiKey(BUILTIN_MODEL_AUTH_CONFIG, false)).toBe('');
});

test('rejects an empty key when development API Key mode is active', () => {
  const config = validateBuiltinModelAuthConfig({
    ...BUILTIN_MODEL_AUTH_CONFIG,
    developmentAuthMode: 'api-key',
    developmentApiKeyFile: undefined,
  });
  expect(() => resolveBuiltinModelDevelopmentApiKey(config, false))
    .toThrow('Development API Key mode requires a non-empty key.');
});

test('reads a development key file only in unpackaged API key mode', () => {
  const stat = vi.spyOn(fs, 'statSync').mockReturnValue({ size: 20 } as fs.Stats);
  const read = vi.spyOn(fs, 'readFileSync').mockReturnValue('sk-test-fixture\n');
  try {
    const config = validateBuiltinModelAuthConfig({
      ...BUILTIN_MODEL_AUTH_CONFIG, developmentAuthMode: 'api-key',
      developmentApiKey: '', developmentApiKeyFile: 'fixture-key.txt',
    });
    expect(resolveBuiltinModelDevelopmentApiKey(config, true)).toBe('');
    expect(resolveBuiltinModelDevelopmentApiKey({ ...config, developmentAuthMode: 'jwt' }, false)).toBe('');
    expect(read).not.toHaveBeenCalled();
    expect(resolveBuiltinModelDevelopmentApiKey(config, false)).toBe('sk-test-fixture');
    read.mockReturnValue('bad\ncredential');
    expect(() => resolveBuiltinModelDevelopmentApiKey(config, false))
      .toThrow('Unable to read development API Key file.');
    read.mockImplementation(() => { throw new Error('sensitive contents'); });
    expect(() => resolveBuiltinModelDevelopmentApiKey(config, false))
      .toThrow('Unable to read development API Key file.');
  } finally {
    stat.mockRestore();
    read.mockRestore();
  }
});
