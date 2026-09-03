import { describe, expect, test } from 'vitest';

import {
  buildCustomProviderRenameAliases,
  getEffectiveCustomProviderDisplayName,
  isReservedOpenClawProviderId,
  normalizeOpenClawProviderId,
  OPENCLAW_V2026_8_2_RESERVED_PROVIDER_IDS,
  rewriteOpenClawModelProviderId,
  validateCustomProviderDisplayName,
} from './openclawProviderNames';

describe('OpenClaw provider names', () => {
  test('keeps the locked v2026.8.2 inventory unique and normalized', () => {
    expect(new Set(OPENCLAW_V2026_8_2_RESERVED_PROVIDER_IDS).size).toBe(
      OPENCLAW_V2026_8_2_RESERVED_PROVIDER_IDS.length,
    );
    expect(OPENCLAW_V2026_8_2_RESERVED_PROVIDER_IDS).toEqual(
      [...OPENCLAW_V2026_8_2_RESERVED_PROVIDER_IDS].sort(),
    );
    expect(OPENCLAW_V2026_8_2_RESERVED_PROVIDER_IDS).toContain('opencode');
  });

  test.each([' OpenCode ', 'OPENCODE', 'moonshot-ai', 'custom_7'])(
    'detects reserved provider id %s case-insensitively',
    name => {
      expect(isReservedOpenClawProviderId(name)).toBe(true);
      expect(validateCustomProviderDisplayName(name)).toEqual({
        valid: false,
        reason: 'reserved',
      });
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
