import { describe, expect, it } from 'vitest';

import {
  recordingNetworkAddressText,
  sanitizeRecordingNetworkAddress,
} from './browserRecordingNetwork';

describe('recorded request URLs', () => {
  it('hides exact API-key and PKCE fields plus stored-policy signatures and path-relative return credentials', () => {
    const next = encodeURIComponent('./callback?access_token=return-secret&lang=zh');
    const url =
      'https://api.test/session/signin?X-API-Key=external-secret&APIKEY=api-secret' +
      `&code_verifier=pkce-secret&sv=version&sr=b&si=policy&sig=sas-secret&return_to=${next}&page=2`;

    const address = sanitizeRecordingNetworkAddress(url)!;

    expect(JSON.stringify(address)).not.toMatch(/(?:external|api|pkce|sas|return)-secret/);
    expect(address.search).toContain('&page=2');
    expect(new URLSearchParams(address.search).get('return_to')).toContain(
      './callback?access_token=',
    );
    expect(new URLSearchParams(address.search).get('return_to')).toContain('&lang=zh');
  });

  it('hides known session identifiers in path parameters and OAuth credentials in nested hash routes', () => {
    const next = encodeURIComponent(
      'https://auth.test/#/oauth/callback?code=oauth-secret&state=oauth-state&lang=zh',
    );
    const url = `https://api.test/orders;jsessionid=session-secret;tenant=abc/123?PHPSESSID=php-secret&page=2&next=${next}`;

    const address = sanitizeRecordingNetworkAddress(url)!;

    expect(address.path).toBe('/orders;jsessionid=%5Bredacted%5D;tenant=abc/123');
    expect(address.search).toContain('?PHPSESSID=%5Bredacted%5D&page=2');
    expect(JSON.stringify(address)).not.toMatch(
      /session-secret|php-secret|oauth-secret|oauth-state/,
    );
  });

  it('keeps business paths, codes, query order, repeated names and flags', () => {
    const url =
      'http://site.test:8080/orders/123/9c04b09e-3e35-48f6-abfb-b420e58ef831' +
      '?page=2&q=%E6%89%80%E6%9C%89&code=SKU-42&state=CA&tag=x&tag=y&preview';

    const address = sanitizeRecordingNetworkAddress(url);

    expect(address).toBeTruthy();
    expect(recordingNetworkAddressText(address!)).toBe(url);
  });

  it('only hides recognized credentials, including repeated values and nested redirect credentials', () => {
    const redirect = 'https://auth.test/oauth/callback?code=oauth-value&state=state-value&lang=en';
    const url =
      'https://user:password@api.test/orders/123?page=2&access_token=secret-a' +
      `&access_token=secret-b&next=${encodeURIComponent(redirect)}`;

    const address = sanitizeRecordingNetworkAddress(url)!;

    expect(address).toMatchObject({
      origin: 'https://api.test',
      path: '/orders/123',
      urlRedacted: true,
    });
    expect(recordingNetworkAddressText(address)).toContain(
      '?page=2&access_token=[redacted]&access_token=[redacted]',
    );
    expect(decodeURIComponent(address.search!)).toContain('&lang=en');
    expect(JSON.stringify(address)).not.toMatch(
      /password|secret-a|secret-b|oauth-value|state-value/,
    );
  });

  it('retains complete neighboring fields when a query component exceeds its limit or cannot be read', () => {
    const url = `https://api.test/orders?long=${'a'.repeat(2500)}&malformed=%zz&page=3`;
    expect(sanitizeRecordingNetworkAddress(url)).toEqual({
      origin: 'https://api.test',
      path: '/orders',
      search: '?page=3',
      urlLimited: true,
    });
  });

  it('recognizes short credential paths, signed queries and credentials in return URLs', () => {
    const nested = encodeURIComponent(
      '/signin-oidc?code=nested-secret&state=state-secret&lang=zh#panel',
    );
    const nestedFragment = encodeURIComponent(
      'https://auth.test/callback#access_token=fragment-secret',
    );
    const url =
      'https://api.test/magic-link/short-secret' +
      `?sv=version&se=date&sp=r&sig=sas-secret&return_url=${nested}&next=${nestedFragment}`;

    const result = sanitizeRecordingNetworkAddress(url)!;
    expect(result.path).toBe('/magic-link/%5Bredacted%5D');
    expect(decodeURIComponent(result.search!)).toContain('&lang=zh#panel');
    expect(JSON.stringify(result)).not.toMatch(/(?:short|sas|nested|state|fragment)-secret/);
  });
});
