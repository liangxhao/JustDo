import { describe, expect, test } from 'vitest';

import { ProxyMode } from '../../common/proxy';
import { isSystemProxyEnabled } from './systemProxyPreference';

describe('isSystemProxyEnabled', () => {
  test('returns true only when system proxy is explicitly enabled', () => {
    expect(isSystemProxyEnabled({ useSystemProxy: true })).toBe(true);
    expect(isSystemProxyEnabled({ useSystemProxy: false })).toBe(false);
    expect(isSystemProxyEnabled({ proxy: { mode: ProxyMode.SYSTEM } })).toBe(true);
    expect(isSystemProxyEnabled({ proxy: { mode: ProxyMode.CUSTOM } })).toBe(false);
    expect(isSystemProxyEnabled({})).toBe(false);
    expect(isSystemProxyEnabled()).toBe(false);
  });
});
