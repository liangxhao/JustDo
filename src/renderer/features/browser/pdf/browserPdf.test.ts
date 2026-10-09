import { describe, expect, it } from 'vitest';

import { isLikelyPdfUrl } from './browserPdf';

describe('isLikelyPdfUrl', () => {
  it('does not mistake search results or redirect parameters for PDF responses', () => {
    expect(isLikelyPdfUrl('https://example.com/search?q=report.pdf')).toBe(false);
    expect(isLikelyPdfUrl('https://example.com/login?next=report.pdf')).toBe(false);
    expect(isLikelyPdfUrl('https://example.com/report.pdf?download=true')).toBe(true);
    expect(isLikelyPdfUrl('https://arxiv.org/pdf/2609.20859')).toBe(true);
  });
});
