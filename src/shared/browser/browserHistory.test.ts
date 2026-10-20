import { expect, test } from 'vitest';

import { getBrowserLocalFilePath, isTemporaryBrowserPreviewUrl } from './browserHistory';

test.each([
  [
    'file:///C:/reports/%E5%9C%B0%E7%90%83%20%23100%25.html?mode=3d#camera',
    'C:\\reports\\地球 #100%.html',
  ],
  ['file:///tmp/report.html', '/tmp/report.html'],
  ['file://server/share/report.html', '\\\\server\\share\\report.html'],
  ['https://example.com/report.html', null],
  ['file:///C:/reports/a%2fb.html', null],
  ['file:///C:/reports/a%00b.html', null],
])('formats the actual native file address: %s', (url, expected) => {
  expect(getBrowserLocalFilePath(url)).toBe(expected);
});

test('recognizes only the retired temporary preview URL shape', () => {
  const token = 'a'.repeat(32);
  expect(
    isTemporaryBrowserPreviewUrl(`http://127.0.0.1:43210/${token}/x.html?mode=3d#camera`),
  ).toBe(true);
  expect(isTemporaryBrowserPreviewUrl('http://127.0.0.1:3000/index.html')).toBe(false);
  expect(isTemporaryBrowserPreviewUrl('http://localhost:3000/docs/index.html')).toBe(false);
  expect(isTemporaryBrowserPreviewUrl(`https://example.com/${token}/x.html`)).toBe(false);
  expect(isTemporaryBrowserPreviewUrl('file:///C:/reports/x.html')).toBe(false);
});
