import { describe, expect, it, test } from 'vitest';

import {
  buildCustomProviderRenameAliases,
  getEffectiveCustomProviderDisplayName,
  isReservedOpenClawProviderId,
  JUSTDO_RESERVED_OPENCLAW_PROVIDER_IDS,
  listConfiguredOpenClawProviderIds,
  listRetiredOpenClawProviderIds,
  normalizeOpenClawProviderId,
  rewriteOpenClawModelProviderId,
  validateCustomProviderDisplayName,
} from './openclawProviderNames';

describe('configured OpenClaw provider ids', () => {
  const provider = (overrides: Record<string, unknown> = {}) => ({
    enabled: true,
    apiKey: 'fixture-key',
    baseUrl: 'https://example.invalid/v1',
    models: [{ id: 'fixture-model' }],
    ...overrides,
  });

  it('uses canonical display names and ignores providers without usable models', () => {
    expect(
      listConfiguredOpenClawProviderIds({
        internal: provider({ displayName: 'My Proxy' }),
        disabled: provider({ enabled: false }),
        empty: provider({ models: [] }),
      }),
    ).toEqual(['my proxy']);
  });

  it('retires a provider only when its last usable model is removed', () => {
    const previous = {
      proxy: provider({ models: [{ id: 'first' }, { id: 'second' }] }),
    };

    expect(
      listRetiredOpenClawProviderIds(previous, {
        proxy: provider({ models: [{ id: 'second' }] }),
      }),
    ).toEqual([]);
    expect(
      listRetiredOpenClawProviderIds(previous, {
        proxy: provider({ models: [] }),
      }),
    ).toEqual(['proxy']);
  });

  it('retires the old provider id after a display-name change', () => {
    expect(
      listRetiredOpenClawProviderIds(
        { internal: provider({ displayName: 'Old Proxy' }) },
        { internal: provider({ displayName: 'New Proxy' }) },
      ),
    ).toEqual(['old proxy']);
  });
});

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

  test.each([' BUILTIN_MODELS ', 'JustDo'])(
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
    expect(getEffectiveCustomProviderDisplayName('local_proxy', '')).toBe('local_proxy');
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
