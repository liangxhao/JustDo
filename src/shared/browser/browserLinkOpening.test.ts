import { describe, expect, test } from 'vitest';

import { isLocalHtmlFilePath, parseLocalHtmlLink } from './browserLinkOpening';

describe('local HTML link parsing', () => {
  test.each([
    ['output/report.html#chart', 'output/report.html', '#chart'],
    ['./report.html?view=compact#chart', './report.html', '?view=compact#chart'],
    ['output/100%25.html', 'output/100%.html', ''],
    ['output/report%231.HTML', 'output/report#1.HTML', ''],
    [
      'file:///C:/project/report.html?view=compact#chart',
      'file:///C:/project/report.html',
      '?view=compact#chart',
    ],
  ])('separates the file lookup and navigation for %s', (value, filePath, navigationSuffix) => {
    expect(parseLocalHtmlLink(value)).toEqual({ filePath, navigationSuffix });
    expect(isLocalHtmlFilePath(filePath)).toBe(true);
  });

  test.each([
    'https://example.com/report.html#chart',
    'file://attacker.example/report.html#chart',
    'javascript:report.html',
    'file:///C:/project/report%00.html',
    'output/report%00.html#chart',
    'output/report.txt#chart',
  ])('rejects an unsafe or non-HTML lookup: %s', value => {
    expect(parseLocalHtmlLink(value)).toBeNull();
  });

  test('validates literal percent signs in decoded native paths', () => {
    expect(isLocalHtmlFilePath('C:\\project\\100%.html')).toBe(true);
    expect(isLocalHtmlFilePath('/tmp/report%20name.html')).toBe(true);
  });
});
