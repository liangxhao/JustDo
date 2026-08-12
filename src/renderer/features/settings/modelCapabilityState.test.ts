import { describe, expect, test } from 'vitest';

import { hasConfirmedModelCapabilities } from './modelCapabilityState';

describe('hasConfirmedModelCapabilities', () => {
  test('uses an explicit confirmation marker', () => {
    expect(
      hasConfirmedModelCapabilities({
        capabilitiesConfirmed: false,
        supportsImage: true,
        contextLength: 64_000,
        maxTokens: 8_000,
      }),
    ).toBe(false);
    expect(hasConfirmedModelCapabilities({ capabilitiesConfirmed: true })).toBe(true);
  });

  test('treats missing and generated default values in legacy configs as unconfirmed', () => {
    expect(hasConfirmedModelCapabilities({})).toBe(false);
    expect(
      hasConfirmedModelCapabilities({
        supportsImage: false,
        contextLength: 200_000,
        maxTokens: 32_000,
      }),
    ).toBe(false);
  });

  test('preserves clearly customized legacy capabilities as confirmed', () => {
    expect(hasConfirmedModelCapabilities({ contextLength: 128_000 })).toBe(true);
    expect(hasConfirmedModelCapabilities({ supportsImage: true })).toBe(true);
  });
});
