import { describe, expect, it } from 'vitest';

import { scanEmbedShortcodes, stripEmbedShortcodesFromTextParts } from './embed-shortcodes';

describe('embed shortcode scanning', () => {
  it('preserves source order, raw bytes and paired fallback text', () => {
    const source =
      'A[EMBED REF=\'report\' title="A ] title" HEIGHT="500" /]B[embed url="https://example.test"]Open report[/embed]C';
    const segments = scanEmbedShortcodes(source);
    expect(segments.map(segment => segment.type)).toEqual([
      'text',
      'embed',
      'text',
      'embed',
      'text',
    ]);
    expect(segments[1]).toMatchObject({
      attributes: { ref: 'report', title: 'A ] title', height: '500' },
    });
    expect(segments[3]).toMatchObject({ fallbackText: 'Open report' });
    expect(segments.map(segment => source.slice(segment.start, segment.end)).join('')).toBe(source);
  });

  it.each([
    '`[embed ref="report" /]`',
    '`[embed ref="report" /]',
    '`` [embed ref="report" /] ` literal ``',
    '```html\n[embed ref="report" /]\n```',
    '~~~~\n[embed ref="report" /]\n~~~~',
    '```\n[embed ref="report" /]',
    '    [embed ref="report" /]',
    '> ```html\n> [embed ref="report" /]\n> ```',
    '\\[embed ref="report" /]',
    '[embed ref="report"]\n```\n[/embed]\n```',
    '[embed ref="report"',
    '[embed ref="report"]not closed',
    '[embed ref="report" ref="other" /]',
    '[embed ref="report" viewId="other" /]',
    '[embed ref="report" url="" /]',
    '[embed ref=report /]',
    '[embed ref="report"title="missing separator" /]',
    `[embed ref="report" title="${'x'.repeat(32_768)}" /]`,
  ])('retains literal, malformed or unfinished text: %s', source => {
    expect(scanEmbedShortcodes(source)).toEqual([
      { type: 'text', text: source, start: 0, end: source.length },
    ]);
  });

  it('does not let an early self-closing tag consume a later closing tag', () => {
    const segments = scanEmbedShortcodes('A[embed ref="one" /]B[/embed]C[embed ref="two" /]D');
    expect(
      segments.filter(segment => segment.type === 'text').map(segment => segment.text),
    ).toEqual(['A', 'B[/embed]C', 'D']);
  });

  it('does not extend unmatched inline code across paragraph boundaries', () => {
    const segments = scanEmbedShortcodes(
      'Unmatched ` example\n\n[embed ref="report" /]\n\nLater ` prose',
    );
    expect(segments.filter(segment => segment.type === 'embed')).toHaveLength(1);
  });

  it('shares code context across native text parts without changing their boundaries', () => {
    const parts = ['```html', '[embed ref="report" /]', '```', 'Ready [embed ref="report" /]'];
    expect(stripEmbedShortcodesFromTextParts(parts, () => true)).toEqual(
      parts.slice(0, 3).concat('Ready '),
    );
  });
});
