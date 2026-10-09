import { describe, expect, it } from 'vitest';

import { normalizeLiveInspectedElement } from './liveBrowserInspection';

describe('live browser inspection', () => {
  it('cleans page-reported element data', () => {
    const element = normalizeLiveInspectedElement({
      tag: 'div<script>',
      id: 'safe bad!',
      classes: ['one', 'two<script>'],
      name: `  hello\nworld ${'x'.repeat(200)}`,
      rect: { x: 1, y: 2, width: -4, height: 10 },
      cssPath: 'body > div',
      focusable: true,
    });

    expect(element).toMatchObject({
      tag: 'divscript',
      id: 'safebad',
      classes: ['one', 'twoscript'],
      rect: { x: 1, y: 2, width: 0, height: 10 },
      focusable: true,
    });
    expect(element?.name.length).toBeLessThanOrEqual(120);
  });
});
