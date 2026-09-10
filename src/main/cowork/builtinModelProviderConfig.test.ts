import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from 'vitest';

import {
  BUILTIN_CREDENTIAL_MARKER,
  BUILTIN_MODEL_PROVIDER_CONFIG,
  getBuiltinModelProviderApiKey,
  resolveBuiltinRequestApiKey,
} from './builtinModelProviderConfig';

test('resolves the builtin reference only for the configured upstream', () => {
  const value = resolveBuiltinRequestApiKey(
    BUILTIN_CREDENTIAL_MARKER,
    BUILTIN_MODEL_PROVIDER_CONFIG.baseUrl,
  );
  // Assert only booleans for the real bootstrap credential, never its value.
  expect(value === getBuiltinModelProviderApiKey()).toBe(true);
  expect(() =>
    resolveBuiltinRequestApiKey(BUILTIN_CREDENTIAL_MARKER, 'https://untrusted.invalid/v1'),
  ).toThrow();
  expect(resolveBuiltinRequestApiKey('custom-fixture', 'https://custom.invalid/v1')).toBe(
    'custom-fixture',
  );
});

test('does not include the plaintext bootstrap credential in source', () => {
  const value = getBuiltinModelProviderApiKey();
  expect(value.length > 0).toBe(true);
  expect(
    fs
      .readFileSync(path.resolve('src/main/cowork/builtinModelProviderConfig.ts'), 'utf8')
      .includes(value),
  ).toBe(false);
});
