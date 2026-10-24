import { describe, expect, it } from 'vitest';

import {
  OFFLINE_HTML_MAX_SOURCE_CHARS,
  OFFLINE_LIBRARY_IDS,
  OfflineHtmlSourceError,
  parseOfflineHtmlDocument,
} from '../libraries/schema';

const source = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, libraries: ['three'], html: '<div>Scene</div>', ...extra });

describe('offline HTML source contract', () => {
  it('preserves the authored fragment and selected library order', () => {
    const html =
      '\n<style>#scene { height: 300px }</style><div id="scene"></div>\n<script>const =</script>\n';
    expect(parseOfflineHtmlDocument(source({ libraries: ['matter', 'three'], html }))).toEqual({
      version: 1,
      libraries: ['matter', 'three'],
      html,
    });
  });

  it('accepts all six explicit library IDs', () => {
    expect(parseOfflineHtmlDocument(source({ libraries: OFFLINE_LIBRARY_IDS })).libraries).toEqual(
      OFFLINE_LIBRARY_IDS,
    );
  });

  it.each([
    null,
    [],
    false,
    1,
    { version: 1, libraries: ['three'] },
    { version: 1, html: '<div></div>' },
    { libraries: ['three'], html: '<div></div>' },
  ])('rejects missing fields and non-object roots (%j)', value => {
    expect(() => parseOfflineHtmlDocument(JSON.stringify(value))).toThrow(OfflineHtmlSourceError);
  });

  it.each([
    { version: '1' },
    { version: 2 },
    { libraries: [] },
    { libraries: 'three' },
    { libraries: ['three', 'three'] },
    { libraries: ['three', 'other'] },
    { libraries: ['Three'] },
    { libraries: [' three'] },
    { libraries: [null] },
    { libraries: [1] },
    { html: '' },
    { html: ' \n\t' },
    { html: null },
    { html: {} },
    { url: 'https://private.invalid/source' },
    { language: 'zh' },
    { __unexpected: true },
  ])('rejects unsupported envelope values (%j)', extra => {
    expect(() => parseOfflineHtmlDocument(source(extra))).toThrow(OfflineHtmlSourceError);
  });

  it.each([
    '<!doctype html><html><body>Scene</body></html>',
    ' \n<HTML lang="zh"><body>Scene</body></HTML>',
    '\uFEFF <!-- comment --><!-- next --> <!DOCTYPE HTML><html></html>',
    '<head><title>Scene</title></head><body>Scene</body>',
    '<body>Scene</body>',
  ])('rejects a document shell (%s)', html => {
    expect(() => parseOfflineHtmlDocument(source({ html }))).toThrow(/HTML fragment/);
  });

  it('does not mistake shell-like source text inside a fragment for a full document', () => {
    const html = '<div>&lt;html&gt;</div><script>const example = "<html>";</script>';
    expect(parseOfflineHtmlDocument(source({ html })).html).toBe(html);
  });

  it('uses the native character ceiling without reducing the budget for Chinese content', () => {
    const overhead = source({ html: '' }).length;
    const html = '汉'.repeat(OFFLINE_HTML_MAX_SOURCE_CHARS - overhead);
    const payload = source({ html });
    expect(payload.length).toBe(OFFLINE_HTML_MAX_SOURCE_CHARS);
    expect(parseOfflineHtmlDocument(payload).html).toBe(html);
    expect(() => parseOfflineHtmlDocument(source({ html: html + '汉' }))).toThrow(/characters/);
  });

  it('returns fixed rules without reflecting malformed source or unknown field values', () => {
    const secret = 'private-source-marker';
    for (const payload of [secret, source({ token: secret })]) {
      try {
        parseOfflineHtmlDocument(payload);
        expect.unreachable('invalid source was accepted');
      } catch (error) {
        expect(error).toBeInstanceOf(OfflineHtmlSourceError);
        expect(String(error)).not.toContain(secret);
      }
    }
  });
});
