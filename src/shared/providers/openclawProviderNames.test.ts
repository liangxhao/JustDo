import { describe, expect, test } from 'vitest';

import {
  buildCustomProviderRenameAliases,
  getEffectiveCustomProviderDisplayName,
  isReservedOpenClawProviderId,
  JUSTDO_RESERVED_OPENCLAW_PROVIDER_IDS,
  normalizeOpenClawProviderId,
  rewriteOpenClawModelProviderId,
  validateCustomProviderDisplayName,
} from './openclawProviderNames';

describe('OpenClaw provider names', () => {
  test('keeps the JustDo-owned provider id inventory unique and normalized', () => {
    expect(new Set(JUSTDO_RESERVED_OPENCLAW_PROVIDER_IDS).size).toBe(
      JUSTDO_RESERVED_OPENCLAW_PROVIDER_IDS.length,
    );
    expect(JUSTDO_RESERVED_OPENCLAW_PROVIDER_IDS).toEqual(
      [...JUSTDO_RESERVED_OPENCLAW_PROVIDER_IDS].sort(),
    );
    expect(JUSTDO_RESERVED_OPENCLAW_PROVIDER_IDS).toEqual(['builtin_models', 'justdo']);
  });

  test.each([' BUILTIN_MODELS ', 'JustDo', 'custom_7'])(
    'detects reserved provider id %s case-insensitively',
    name => {
      expect(isReservedOpenClawProviderId(name)).toBe(true);
      expect(validateCustomProviderDisplayName(name)).toEqual({
        valid: false,
        reason: 'reserved',
      });
    },
  );

  test.each(['OpenAI', 'Anthropic', 'DeepSeek', 'OpenCode', 'moonshot-ai'])(
    'allows an explicitly configured OpenClaw provider id %s',
    name => {
      expect(isReservedOpenClawProviderId(name)).toBe(false);
      expect(validateCustomProviderDisplayName(name)).toEqual({ valid: true });
    },
  );

  test('normalizes a safe display name for the Gateway route', () => {
    expect(normalizeOpenClawProviderId(' OpenCode Proxy ')).toBe('opencode proxy');
    expect(getEffectiveCustomProviderDisplayName('custom_0', '')).toBe('Custom0');
  });
});

describe('custom provider wire ID renames', () => {
  test('matches providers by stable internal key', () => {
    expect(
      buildCustomProviderRenameAliases(
        { custom_0: { displayName: 'AcmeProxy' } },
        { custom_0: { displayName: 'NewProxy' } },
      ),
    ).toEqual({ acmeproxy: 'newproxy', custom_0: 'newproxy' });
  });

  test('matches renamed named providers by stable identity', () => {
    expect(
      buildCustomProviderRenameAliases(
        { acmeproxy: { identity: 'provider-id', displayName: 'AcmeProxy' } },
        { newproxy: { identity: 'provider-id', displayName: 'NewProxy' } },
      ),
    ).toEqual({ acmeproxy: 'newproxy' });
  });

  test('does not treat provider deletion or malformed names as a rename', () => {
    expect(
      buildCustomProviderRenameAliases(
        { custom_0: { displayName: 'AcmeProxy' } },
        { custom_1: { displayName: 42 } },
      ),
    ).toEqual({});
  });

  test('rewrites only the provider segment of a qualified model ref', () => {
    expect(rewriteOpenClawModelProviderId('AcmeProxy/team/model', { acmeproxy: 'newproxy' })).toBe(
      'newproxy/team/model',
    );
    expect(rewriteOpenClawModelProviderId('bare-model', { acmeproxy: 'newproxy' })).toBe(
      'bare-model',
    );
    expect(rewriteOpenClawModelProviderId('constructor/model', { acmeproxy: 'newproxy' })).toBe(
      'constructor/model',
    );
  });
});
