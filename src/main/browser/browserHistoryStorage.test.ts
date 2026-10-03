import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({ getPath: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: electronMock.getPath },
  safeStorage: { decryptString: vi.fn(), encryptString: vi.fn() },
  session: { fromPartition: vi.fn() },
}));

import {
  clearBrowserHistory,
  deleteBrowserHistory,
  listBrowserHistory,
  recordBrowserHistory,
  updateBrowserHistoryFavicon,
} from './browserDataImportService';

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-browser-history-'));
  electronMock.getPath.mockReturnValue(directory);
});
afterEach(() => {
  vi.restoreAllMocks();
  const target = path.resolve(directory);
  if (
    path.dirname(target) !== path.resolve(os.tmpdir()) ||
    !path.basename(target).startsWith('justdo-browser-history-')
  ) {
    throw new Error('Refusing to remove an unexpected temporary directory.');
  }
  fs.rmSync(target, { recursive: true, force: true });
});

describe('browser history favicon storage', () => {
  test('persists icons across reads and updates them without counting another visit', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100);
    recordBrowserHistory('https://example.com/docs', 'Docs', 'https://cdn.example.com/site.svg');
    expect(listBrowserHistory('Docs')[0].faviconUrl).toBe('https://cdn.example.com/site.svg');

    clock.mockReturnValue(200);
    updateBrowserHistoryFavicon('https://example.com/docs', 'https://cdn.example.com/site-v2.svg');
    expect(listBrowserHistory('')[0]).toEqual({
      url: 'https://example.com/docs',
      title: 'Docs',
      lastVisitAt: 100,
      visitCount: 1,
      faviconUrl: 'https://cdn.example.com/site-v2.svg',
    });

    recordBrowserHistory('https://example.com/docs', 'New title');
    expect(listBrowserHistory('')[0]).toEqual({
      url: 'https://example.com/docs',
      title: 'New title',
      lastVisitAt: 200,
      visitCount: 2,
      faviconUrl: 'https://cdn.example.com/site-v2.svg',
    });
  });

  test('reads an older database without changing it and preserves its history when adding the icon column', () => {
    const dbPath = path.join(directory, 'browser-import.sqlite');
    const oldDb = new Database(dbPath);
    oldDb.exec(`CREATE TABLE imported_history (
      url TEXT PRIMARY KEY, title TEXT NOT NULL, last_visit_at INTEGER NOT NULL, visit_count INTEGER NOT NULL
    )`);
    oldDb
      .prepare('INSERT INTO imported_history VALUES (?, ?, ?, ?)')
      .run('https://example.com/docs', 'Docs', 10, 3);
    oldDb.close();

    expect(listBrowserHistory('Docs')).toEqual([
      { url: 'https://example.com/docs', title: 'Docs', lastVisitAt: 10, visitCount: 3 },
    ]);
    const unchangedDb = new Database(dbPath, { readonly: true });
    expect(unchangedDb.pragma('table_info(imported_history)')).toHaveLength(4);
    unchangedDb.close();

    recordBrowserHistory('https://other.example.com/', 'Other');
    updateBrowserHistoryFavicon('https://example.com/docs', 'https://example.com/brand.svg');
    expect(listBrowserHistory('Docs')[0]).toEqual({
      url: 'https://example.com/docs',
      title: 'Docs',
      lastVisitAt: 10,
      visitCount: 3,
      faviconUrl: 'https://example.com/brand.svg',
    });
    expect(listBrowserHistory('')).toHaveLength(2);
  });

  test('rejects non-web icons, sanitizes URL credentials, and never creates visits from icon updates', () => {
    recordBrowserHistory('https://example.com/docs', 'Docs', 'file:///icon.png');
    updateBrowserHistoryFavicon('https://missing.example.com/', 'https://example.com/icon.png');
    updateBrowserHistoryFavicon('https://example.com/docs', 'javascript:alert(1)');
    expect(listBrowserHistory('')).toEqual([
      {
        url: 'https://example.com/docs',
        title: 'Docs',
        lastVisitAt: expect.any(Number),
        visitCount: 1,
      },
    ]);
    updateBrowserHistoryFavicon(
      'https://example.com/docs',
      'https://user:pass@cdn.example.com/icon.png?access_token=private-value&v=2',
    );
    const icon = new URL(listBrowserHistory('')[0].faviconUrl!);
    expect(icon.username).toBe('');
    expect(icon.password).toBe('');
    expect(icon.searchParams.get('access_token')).toBe('[REDACTED]');
    expect(icon.searchParams.get('v')).toBe('2');
  });

  test('deleting or clearing history removes its associated icons', () => {
    recordBrowserHistory('https://example.com/docs', 'Docs', 'https://example.com/docs-icon.svg');
    recordBrowserHistory('https://example.com/home', 'Home', 'https://example.com/home-icon.svg');
    expect(deleteBrowserHistory(['https://example.com/docs'])).toBe(1);
    expect(listBrowserHistory('')[0].faviconUrl).toBe('https://example.com/home-icon.svg');
    expect(clearBrowserHistory()).toBe(1);
    expect(listBrowserHistory('')).toEqual([]);
  });
});
