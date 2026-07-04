import { describe, expect, test } from 'vitest';

import { isSystemProxyEnabled } from './systemProxyPreference';

describe('isSystemProxyEnabled', () => {
  test('returns true only when system proxy is explicitly enabled', () => {
    expect(isSystemProxyEnabled({ useSystemProxy: true })).toBe(true);
    expect(isSystemProxyEnabled({ useSystemProxy: false })).toBe(false);
    expect(isSystemProxyEnabled({})).toBe(false);
    expect(isSystemProxyEnabled()).toBe(false);
  });
});
