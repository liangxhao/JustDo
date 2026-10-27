import { describe, expect, it } from 'vitest';

import {
  classifyEmbedPresentation,
  previewFromEmbedShortcode,
  type WebpageEmbedPreview,
} from './embed-presentation';
import { scanEmbedShortcodes } from './embed-shortcodes';

const preview = (fields: Partial<WebpageEmbedPreview>): WebpageEmbedPreview => ({
  kind: 'canvas',
  surface: 'assistant_message',
  render: 'url',
  ...fields,
});

describe('embed presentation classification', () => {
  it('uses explicit URLs before references and preserves query/hash', () => {
    const input = preview({ url: 'https://example.test/report?a=1#section', ref: 'report' });
    expect(classifyEmbedPresentation(input)).toEqual({ kind: 'webpage', url: input.url });
    expect(classifyEmbedPresentation({ ...input, url: 'file:///report.html' })).toEqual({
      kind: 'unavailable',
      reason: 'unsupported-source',
    });
  });

  it('classifies a reference and a canonical document URL identically', () => {
    const expected = { kind: 'hosted', documentId: 'report', path: 'index.html' };
    expect(classifyEmbedPresentation(preview({ ref: 'report' }))).toEqual(expected);
    expect(
      classifyEmbedPresentation(
        preview({ url: '/__openclaw__/canvas/documents/report/index.html' }),
      ),
    ).toEqual(expected);
  });

  it.each([
    { url: '' },
    { ref: '..' },
    { ref: 'a/b' },
    { ref: 'x'.repeat(257) },
    { url: '//example.test/report' },
    { url: ' https://example.test/' },
    { url: 'https://user:password@example.test/' },
    { url: '/__openclaw__/canvas/documents/report/../other/index.html' },
    { url: '/__openclaw__/canvas/documents/report/%2e%2e/other/index.html' },
    { url: '/__openclaw__/canvas/documents/report/index.html?token=secret' },
  ])('does not promote invalid targets or use their fallback reference: %o', fields => {
    expect(classifyEmbedPresentation(preview({ ref: 'valid', ...fields })).kind).toBe(
      'unavailable',
    );
  });

  it('retains MCP protocol identity and never downgrades it to a web page', () => {
    expect(
      classifyEmbedPresentation(preview({ url: 'https://example.test/', mcpApp: {} })),
    ).toEqual({ kind: 'unavailable', reason: 'mcp-app' });
  });

  it('projects safe presentation fields and bounds height without applying model styles', () => {
    const segment = scanEmbedShortcodes(
      '[embed ref="report" height="99999" class="full" style="position:fixed"]Fallback[/embed]',
    )[0];
    expect(segment.type).toBe('embed');
    if (segment.type !== 'embed') return;
    expect(previewFromEmbedShortcode(segment)).toEqual(
      preview({
        ref: 'report',
        viewId: 'report',
        url: '/__openclaw__/canvas/documents/report/index.html',
        preferredHeight: 1200,
        fallbackText: 'Fallback',
      }),
    );
  });
});
