import { mkdtempDisposableSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { app, safeStorage } from 'electron';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => 'C:\\test-user-data') },
  safeStorage: {
    decryptString: vi.fn(),
    encryptString: vi.fn(),
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
  },
  session: { fromPartition: vi.fn() },
}));

import {
  clearImportedCredentialsSince,
  findBrowserCredential,
  importChromeData,
  saveBrowserCredential,
} from './browserDataImportService';

describe('browserDataImportService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(app.getPath).mockReset().mockReturnValue('C:\\test-user-data');
  });

  test('stops before reading or persisting browser data when cancelled', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Browser profile import was cancelled.'));

    await expect(
      importChromeData(
        {
          sourceId: 'Default',
          approved: true,
          cookies: true,
          passwords: false,
          history: false,
        },
        controller.signal,
      ),
    ).rejects.toThrow('cancelled');
  });

  test('reuses the imported vault, matches accounts explicitly, and clears remembered passwords', () => {
    using directory = mkdtempDisposableSync(path.join(tmpdir(), 'browser-credential-test-'));
    vi.mocked(app.getPath).mockReturnValue(directory.path);
    vi.mocked(safeStorage.encryptString).mockImplementation(value =>
      Buffer.from(`encrypted:${value}`),
    );
    vi.mocked(safeStorage.decryptString).mockImplementation(value => {
      const decoded = value.toString();
      if (!decoded.startsWith('encrypted:')) throw new Error('Unreadable credential');
      return decoded.slice('encrypted:'.length);
    });

    const origin = 'https://login.example.test';
    const primary = { username: 'primary', password: 'saved-password' };
    saveBrowserCredential(origin, primary);
    const database = new Database(path.join(directory.path, 'browser-import.sqlite'));
    try {
      expect(database.prepare('SELECT password FROM imported_passwords').pluck().get()).toEqual(
        Buffer.from('encrypted:saved-password'),
      );
      database
        .prepare('INSERT INTO imported_passwords VALUES (?, ?, ?, ?)')
        .run(origin, 'unreadable-import', Buffer.from('old-data'), 1);
    } finally {
      database.close();
    }

    expect(findBrowserCredential(origin, null)).toEqual(primary);
    saveBrowserCredential(origin, { username: 'secondary', password: 'secondary-password' });
    expect(findBrowserCredential(origin, null)).toBeNull();
    expect(findBrowserCredential(origin, 'primary')).toEqual(primary);
    expect(findBrowserCredential(`${origin}:8080`, 'primary')).toBeNull();
    expect(clearImportedCredentialsSince(null)).toBe(3);
    expect(findBrowserCredential(origin, 'primary')).toBeNull();
  });
});
