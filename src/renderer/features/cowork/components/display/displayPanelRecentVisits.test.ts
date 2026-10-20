import type { BrowserHistoryEntry } from '@shared/browser/browser';
import { expect, test } from 'vitest';

import { selectRecentBrowserVisits } from './displayPanelRecentVisits';

test('selects four newest distinct web pages without mutating source history', () => {
  const entries: BrowserHistoryEntry[] = [1, 3, 2, 6, 5, 4].map(lastVisitAt => ({
    url: `https://example.com/${lastVisitAt}`,
    title: `Page ${lastVisitAt}`,
    lastVisitAt,
    visitCount: 1,
  }));
  entries.push({ ...entries[3], lastVisitAt: 7 });
  expect(selectRecentBrowserVisits(entries).map(visit => visit.title)).toEqual([
    'Page 6',
    'Page 5',
    'Page 4',
    'Page 3',
  ]);
  expect(entries[0].lastVisitAt).toBe(1);
});

test('excludes unsafe URLs and uses the hostname when the title is empty', () => {
  const entries = [
    'javascript:alert(1)',
    'data:text/plain,secret',
    'about:blank',
    'invalid',
    'https://user:password@example.com/',
    'https://www.example.com/docs',
  ].map(url => ({
    url,
    title: ' ',
    lastVisitAt: 1,
    visitCount: 1,
  }));
  expect(selectRecentBrowserVisits(entries)).toEqual([
    {
      url: 'https://www.example.com/docs',
      title: 'example.com',
      host: 'example.com',
      faviconUrl: 'https://www.example.com/favicon.ico',
    },
  ]);
});

test('uses the declared website icon, including CDN icons', () => {
  const [visit] = selectRecentBrowserVisits([
    {
      url: 'https://example.com/docs',
      title: 'Docs',
      faviconUrl: 'https://cdn.example.com/assets/brand.svg',
      lastVisitAt: 1,
      visitCount: 1,
    },
  ]);
  expect(visit.faviconUrl).toBe('https://cdn.example.com/assets/brand.svg');
});

test('shows native files with real paths and excludes retired preview service addresses', () => {
  const url = 'file:///C:/reports/%E5%9C%B0%E7%90%83.html?mode=3d#camera';
  expect(
    selectRecentBrowserVisits([
      {
        url: `http://127.0.0.1:43210/${'a'.repeat(32)}/x.html`,
        title: 'Old globe',
        lastVisitAt: 3,
        visitCount: 1,
      },
      { url, title: ' ', lastVisitAt: 2, visitCount: 1 },
      {
        url: 'http://127.0.0.1:3000/index.html',
        title: 'Local dev',
        lastVisitAt: 1,
        visitCount: 1,
      },
    ]),
  ).toEqual([
    { url, title: '地球.html', host: 'C:\\reports\\地球.html', faviconUrl: '' },
    {
      url: 'http://127.0.0.1:3000/index.html',
      title: 'Local dev',
      host: '127.0.0.1',
      faviconUrl: 'http://127.0.0.1:3000/favicon.ico',
    },
  ]);
});

test.each([
  'invalid',
  'file:///icon.png',
  'javascript:alert(1)',
  'https://user:pass@example.com/icon',
])('falls back to the website favicon when icon metadata is unsafe: %s', faviconUrl => {
  const [visit] = selectRecentBrowserVisits([
    { url: 'https://example.com/docs', title: 'Docs', faviconUrl, lastVisitAt: 1, visitCount: 1 },
  ]);
  expect(visit.faviconUrl).toBe('https://example.com/favicon.ico');
});
