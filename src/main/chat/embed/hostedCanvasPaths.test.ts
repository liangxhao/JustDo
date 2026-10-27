import { describe, expect, it } from 'vitest';

import { canonicalHostedCanvasResource, hostedCanvasEntryResource } from './hostedCanvasPaths';

const PREFIX = '/__openclaw__/canvas/documents/cv_report/';

describe('hosted Canvas exact resource paths', () => {
  it('preserves current-document asset paths and normal resource queries', () => {
    expect(hostedCanvasEntryResource('cv_report', 'index.html')).toBe(`${PREFIX}index.html`);
    expect(canonicalHostedCanvasResource(`${PREFIX}assets/a%20b.svg?v=2`, 'cv_report')).toBe(
      `${PREFIX}assets/a%20b.svg?v=2`,
    );
  });

  it.each([
    `${PREFIX}../cv_other/index.html`,
    `${PREFIX}%2e%2e/cv_other/index.html`,
    `${PREFIX}%252e%252e/index.html`,
    `${PREFIX}assets%2fprivate.html`,
    `${PREFIX}assets%5cprivate.html`,
    `${PREFIX}assets/../../index.html`,
    `${PREFIX}assets//index.html`,
    `${PREFIX}a%00.html`,
    `${PREFIX}a%zz.html`,
    `${PREFIX}index.html?oc_cap=forged`,
    `${PREFIX}index.html?OC_CAP=forged`,
    `${PREFIX}index.html#fragment`,
    `${PREFIX}a:b.html`,
    '/__openclaw__/canvas/documents/cv_other/index.html',
    '/health',
    'http://127.0.0.1/index.html',
  ])('rejects traversal, credentials and routes outside this document: %s', value => {
    expect(canonicalHostedCanvasResource(value, 'cv_report')).toBeNull();
  });

  it.each(['.', '..', 'other/document', 'spaced document', 'a'.repeat(257)])(
    'rejects invalid document IDs',
    value => {
      expect(hostedCanvasEntryResource(value, 'index.html')).toBeNull();
    },
  );
});
