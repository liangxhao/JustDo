import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';

import {
  buildChromeCookieDetails,
  chromeTimestampToUnixMs,
  mapChromeCookieSameSite,
  sanitizeBrowserHistoryUrl,
  stripChromeCookieHostDigest,
} from './browserDataSanitizers';

describe('browserDataSanitizers', () => {
  it('removes credentials and rejects non-web history URLs', () => {
    expect(sanitizeBrowserHistoryUrl('https://user:secret@example.com/docs?q=1')).toBe(
      'https://example.com/docs?q=1',
    );
    expect(sanitizeBrowserHistoryUrl('file:///C:/secret.txt')).toBeNull();
    expect(sanitizeBrowserHistoryUrl('javascript:alert(1)')).toBeNull();
  });

  it('maps Chromium SameSite values without weakening their semantics', () => {
    expect(mapChromeCookieSameSite(-1)).toBe('unspecified');
    expect(mapChromeCookieSameSite(0)).toBe('no_restriction');
    expect(mapChromeCookieSameSite(1)).toBe('lax');
    expect(mapChromeCookieSameSite(2)).toBe('strict');
    expect(mapChromeCookieSameSite(3)).toBe('unspecified');
  });

  it('requires and strips the host digest for cookie databases version 24 and later', () => {
    const host = '.example.com';
    const payload = Buffer.from('cookie-value');
    const encoded = Buffer.concat([createHash('sha256').update(host).digest(), payload]);

    expect(stripChromeCookieHostDigest(encoded, host, 24)).toEqual(payload);
    expect(stripChromeCookieHostDigest(encoded, '.attacker.test', 24)).toBeNull();
    expect(stripChromeCookieHostDigest(payload, host, 23)).toEqual(payload);
  });

  it('preserves host-only and domain Cookie scope and SameSite', () => {
    const base = {
      name: 'sid',
      path: '/',
      expires_utc: 0,
      is_secure: 1,
      is_httponly: 1,
      samesite: 1,
      top_frame_site_key: '',
    };
    const hostOnly = buildChromeCookieDetails(
      { ...base, host_key: 'example.com' },
      Buffer.from('value'),
      23,
    );
    const domain = buildChromeCookieDetails(
      { ...base, host_key: '.example.com', samesite: 2 },
      Buffer.from('value'),
      23,
    );

    expect(hostOnly).toMatchObject({ url: 'https://example.com/', sameSite: 'lax' });
    expect(hostOnly).not.toHaveProperty('domain');
    expect(domain).toMatchObject({ domain: '.example.com', sameSite: 'strict' });
  });

  it('does not broaden partitioned cookies or accept a mismatched v24 host digest', () => {
    const row = {
      host_key: 'example.com',
      name: 'sid',
      path: '/',
      expires_utc: 0,
      is_secure: 1,
      is_httponly: 1,
      samesite: 0,
      top_frame_site_key: 'https://top-frame.example',
    };
    expect(buildChromeCookieDetails(row, Buffer.from('value'), 23)).toBeNull();
    expect(
      buildChromeCookieDetails(
        { ...row, top_frame_site_key: '' },
        Buffer.concat([
          createHash('sha256').update('attacker.example').digest(),
          Buffer.from('value'),
        ]),
        24,
      ),
    ).toBeNull();
  });

  it('converts Chrome microseconds to Unix milliseconds', () => {
    expect(chromeTimestampToUnixMs(11_644_473_601_000_000)).toBe(1_000);
  });
});
