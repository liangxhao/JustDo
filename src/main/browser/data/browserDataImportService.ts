import Database from 'better-sqlite3';
import { execFile } from 'child_process';
import { createDecipheriv, pbkdf2Sync } from 'crypto';
import { app, safeStorage, session } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import {
  type BrowserDownloadEntry,
  type BrowserDownloadState,
  type BrowserHistoryEntry,
  type BrowserImportedCredential,
  type BrowserImportRequest,
  type BrowserImportResult,
  type BrowserImportSource,
  browserPartitionForProfile,
  isBrowserAgentProfile,
  isBrowserFaviconDataUrl,
} from '../../../shared/browser/browser';
import { invalidateBrowserFaviconCache } from '../history/browserFaviconCache';
import {
  buildChromeCookieDetails,
  chromeTimestampToUnixMs,
  sanitizeBrowserHistoryUrl,
} from './browserDataSanitizers';

const profileIdPattern = /^(?:Default|Profile [1-9][0-9]{0,2})$/;
const execFileAsync = promisify(execFile);
const CHROME_DPAPI_PAYLOAD_ENV = 'JUSTDO_CHROME_DPAPI_PAYLOAD';
const CHROME_DECRYPTION_ERROR = 'Chrome encryption key could not be decrypted.';

const normalizeCookieImportDomain = (value: string): string | null => {
  const candidate = value.trim().toLowerCase().replace(/^\./, '');
  if (!candidate || /[/:?#@]/u.test(candidate)) return null;
  try {
    const hostname = new URL(`https://${candidate}`).hostname.toLowerCase();
    return hostname === candidate ? hostname : null;
  } catch {
    return null;
  }
};

type ChromiumBrowser = BrowserImportSource['browser'];

const CHROMIUM_BROWSER_DIRS: Record<ChromiumBrowser, string[]> = {
  chrome: ['Google', 'Chrome', 'User Data'],
  brave: ['BraveSoftware', 'Brave-Browser', 'User Data'],
  edge: ['Microsoft', 'Edge', 'User Data'],
  chromium: ['Chromium', 'User Data'],
};

const MAC_CHROMIUM_BROWSER_DIRS: Record<ChromiumBrowser, string[]> = {
  chrome: ['Google', 'Chrome'],
  brave: ['BraveSoftware', 'Brave-Browser'],
  edge: ['Microsoft Edge'],
  chromium: ['Chromium'],
};

const MAC_KEYCHAIN_ENTRIES: Record<ChromiumBrowser, { service: string; account: string }> = {
  chrome: { service: 'Chrome Safe Storage', account: 'Chrome' },
  brave: { service: 'Brave Safe Storage', account: 'Brave' },
  edge: { service: 'Microsoft Edge Safe Storage', account: 'Microsoft Edge' },
  chromium: { service: 'Chromium Safe Storage', account: 'Chromium' },
};

const CHROMIUM_BROWSER_NAMES: Record<ChromiumBrowser, string> = {
  chrome: 'Google Chrome',
  brave: 'Brave',
  edge: 'Microsoft Edge',
  chromium: 'Chromium',
};

const chromiumRoot = (browser: ChromiumBrowser): string | null => {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, ...CHROMIUM_BROWSER_DIRS[browser]);
  }
  if (process.platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      ...MAC_CHROMIUM_BROWSER_DIRS[browser],
    );
  }
  return null;
};

const readJson = (filePath: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

export const listChromeImportSources = (): BrowserImportSource[] => {
  return (Object.keys(CHROMIUM_BROWSER_DIRS) as ChromiumBrowser[]).flatMap(browser => {
    const root = chromiumRoot(browser);
    if (!root) return [];
    const localState = readJson(path.join(root, 'Local State'));
    const profile = localState?.profile as Record<string, unknown> | undefined;
    const infoCache = profile?.info_cache as Record<string, unknown> | undefined;
    const entries = infoCache
      ? Object.entries(infoCache)
      : fs.existsSync(path.join(root, 'Default'))
        ? [['Default', {}] as const]
        : [];
    return entries.flatMap(([profileId, raw]) => {
      if (!profileIdPattern.test(profileId) || !fs.existsSync(path.join(root, profileId)))
        return [];
      const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
      const name =
        typeof record.name === 'string' && record.name.trim() ? record.name.trim() : profileId;
      return [
        {
          id: browser === 'chrome' ? profileId : `${browser}:${profileId}`,
          profileId,
          browser,
          name: `${CHROMIUM_BROWSER_NAMES[browser]} · ${name.slice(0, 80)}`,
          hasCookies:
            fs.existsSync(path.join(root, profileId, 'Network', 'Cookies')) ||
            fs.existsSync(path.join(root, profileId, 'Cookies')),
        },
      ];
    });
  });
};

const throwIfImportAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('Browser profile import was cancelled.');
};

const chromeMasterKey = async (
  root: string,
  browser: ChromiumBrowser,
  signal?: AbortSignal,
): Promise<Buffer> => {
  throwIfImportAborted(signal);
  if (process.platform === 'darwin') {
    const entry = MAC_KEYCHAIN_ENTRIES[browser];
    try {
      const { stdout } = await execFileAsync(
        'security',
        ['find-generic-password', '-w', '-s', entry.service, '-a', entry.account],
        { encoding: 'buffer', timeout: 30_000, maxBuffer: 1024 * 1024, signal },
      );
      const output = Buffer.from(stdout);
      let start = 0;
      let end = output.length;
      while (start < end && output[start]! <= 0x20) start += 1;
      while (end > start && output[end - 1]! <= 0x20) end -= 1;
      const secret = Buffer.from(output.subarray(start, end));
      output.fill(0);
      if (!secret.length) throw new Error(CHROME_DECRYPTION_ERROR);
      try {
        return pbkdf2Sync(secret, 'saltysalt', 1003, 16, 'sha1');
      } finally {
        secret.fill(0);
      }
    } catch {
      throwIfImportAborted(signal);
      throw new Error(CHROME_DECRYPTION_ERROR);
    }
  }
  const state = root ? readJson(path.join(root, 'Local State')) : null;
  const osCrypt = state?.os_crypt as Record<string, unknown> | undefined;
  if (typeof osCrypt?.encrypted_key !== 'string')
    throw new Error('Chrome encryption key is missing.');
  const encrypted = Buffer.from(osCrypt.encrypted_key, 'base64');
  const payload = encrypted.subarray(encrypted.subarray(0, 5).toString() === 'DPAPI' ? 5 : 0);
  const script =
    'Add-Type -AssemblyName System.Security;' +
    `$e=$env:${CHROME_DPAPI_PAYLOAD_ENV};` +
    `Remove-Item Env:${CHROME_DPAPI_PAYLOAD_ENV} -ErrorAction SilentlyContinue;` +
    '$b=[Convert]::FromBase64String($e);' +
    '$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);' +
    '[Console]::Out.Write([Convert]::ToBase64String($p))';
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        timeout: 15_000,
        windowsHide: true,
        maxBuffer: 64 * 1024,
        signal,
        env: { ...process.env, [CHROME_DPAPI_PAYLOAD_ENV]: payload.toString('base64') },
      },
    );
    const key = Buffer.from(stdout.trim(), 'base64');
    if (key.length !== 32) throw new Error(CHROME_DECRYPTION_ERROR);
    return key;
  } catch {
    throwIfImportAborted(signal);
    // Do not propagate the PowerShell command or encrypted payload to IPC and the UI.
    throw new Error(CHROME_DECRYPTION_ERROR);
  }
};

const decryptChromeValue = (encrypted: Buffer, key: Buffer): Buffer | null => {
  if (!encrypted.length) return Buffer.alloc(0);
  const version = encrypted.subarray(0, 3).toString();
  if (version === 'v20') return null;
  if (version !== 'v10' && version !== 'v11') {
    try {
      return Buffer.from(safeStorage.decryptString(encrypted), 'utf8');
    } catch {
      return null;
    }
  }
  try {
    if (process.platform === 'darwin') {
      const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
      return Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
    }
    const iv = encrypted.subarray(3, 15);
    const payload = encrypted.subarray(15, -16);
    const tag = encrypted.subarray(-16);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(payload), decipher.final()]);
  } catch {
    return null;
  }
};

const openSourceDb = (filePath: string): Database.Database =>
  new Database(filePath, { readonly: true, fileMustExist: true, timeout: 1_000 });

const openImportedDataDb = (): Database.Database => {
  const db = new Database(path.join(app.getPath('userData'), 'browser-import.sqlite'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS imported_passwords (
      origin TEXT NOT NULL,
      username TEXT NOT NULL,
      password BLOB NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(origin, username)
    );
    CREATE TABLE IF NOT EXISTS imported_history (
      url TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      last_visit_at INTEGER NOT NULL,
      visit_count INTEGER NOT NULL,
      favicon_url TEXT NOT NULL DEFAULT '',
      favicon_data_url TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS browser_downloads (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      source_url TEXT NOT NULL,
      save_path TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL,
      received_bytes INTEGER NOT NULL DEFAULT 0,
      total_bytes INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS browser_profiles (
      name TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS browser_downloads_updated_at
      ON browser_downloads(updated_at DESC);
    CREATE INDEX IF NOT EXISTS imported_history_last_visit_at
      ON imported_history(last_visit_at DESC);
    CREATE INDEX IF NOT EXISTS imported_passwords_updated_at
      ON imported_passwords(updated_at DESC);
    CREATE INDEX IF NOT EXISTS browser_downloads_started_at
      ON browser_downloads(started_at DESC);
  `);
  if (!hasHistoryFaviconColumn(db)) {
    db.exec("ALTER TABLE imported_history ADD COLUMN favicon_url TEXT NOT NULL DEFAULT ''");
  }
  if (!hasHistoryFaviconDataColumn(db)) {
    db.exec("ALTER TABLE imported_history ADD COLUMN favicon_data_url TEXT NOT NULL DEFAULT ''");
  }
  return db;
};

const hasHistoryFaviconColumn = (db: Database.Database): boolean =>
  (db.pragma('table_info(imported_history)') as Array<{ name: string }>).some(
    column => column.name === 'favicon_url',
  );

const hasHistoryFaviconDataColumn = (db: Database.Database): boolean =>
  (db.pragma('table_info(imported_history)') as Array<{ name: string }>).some(
    column => column.name === 'favicon_data_url',
  );

export const listImportedBrowserProfiles = (): string[] => {
  const db = openImportedDataDb();
  try {
    return (
      db.prepare('SELECT name FROM browser_profiles ORDER BY created_at, name').all() as Array<{
        name: string;
      }>
    ).map(row => row.name);
  } finally {
    db.close();
  }
};

export const recordImportedBrowserProfile = (name: string): void => {
  if (!isBrowserAgentProfile(name) || name === 'embedded') return;
  const db = openImportedDataDb();
  try {
    db.prepare('INSERT OR IGNORE INTO browser_profiles(name, created_at) VALUES (?, ?)').run(
      name,
      Date.now(),
    );
  } finally {
    db.close();
  }
};

export const importChromeData = async (
  request: BrowserImportRequest,
  signal?: AbortSignal,
): Promise<BrowserImportResult> => {
  throwIfImportAborted(signal);
  const requestedDomains = request.domains?.map(normalizeCookieImportDomain);
  const source = listChromeImportSources().find(candidate => candidate.id === request.sourceId);
  const profileId = source?.profileId ?? (source?.browser === 'chrome' ? source.id : '');
  if (
    !request.approved ||
    !source ||
    !profileIdPattern.test(profileId) ||
    (!request.passwords && !request.cookies && !request.history) ||
    (request.destinationProfile !== undefined &&
      !isBrowserAgentProfile(request.destinationProfile)) ||
    requestedDomains?.some(domain => domain === null)
  ) {
    return { success: false, errorCode: 'invalid-request', error: 'Invalid import request.' };
  }
  const root = chromiumRoot(source.browser);
  const profilePath = root ? path.join(root, profileId) : '';
  if (!root || !fs.existsSync(profilePath)) {
    return {
      success: false,
      errorCode: 'source-unavailable',
      error: 'Chrome profile is unavailable.',
    };
  }

  const imported = { passwords: 0, cookies: 0, history: 0 };
  const skippedAppBound = { passwords: 0, cookies: 0 };
  const failed = { cookies: 0 };
  let key: Buffer | null = null;
  if (request.passwords || request.cookies) {
    try {
      key = await chromeMasterKey(root!, source.browser, signal);
    } catch (error) {
      throwIfImportAborted(signal);
      return {
        success: false,
        errorCode: 'decrypt-failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  let destination: Database.Database | null = null;
  try {
    throwIfImportAborted(signal);
    destination = openImportedDataDb();
    if (request.passwords && key) {
      const source = openSourceDb(path.join(profilePath, 'Login Data'));
      try {
        const rows = source
          .prepare('SELECT origin_url, username_value, password_value, date_last_used FROM logins')
          .all() as Array<{
          origin_url: string;
          username_value: string;
          password_value: Buffer;
          date_last_used: number;
        }>;
        const insert = destination.prepare(
          'INSERT OR REPLACE INTO imported_passwords(origin, username, password, updated_at) VALUES (?, ?, ?, ?)',
        );
        const transaction = destination.transaction(() => {
          let importedCount = 0;
          for (const row of rows) {
            throwIfImportAborted(signal);
            const password = decryptChromeValue(row.password_value, key!);
            if (password === null) {
              skippedAppBound.passwords += 1;
              continue;
            }
            let origin: string;
            try {
              origin = new URL(row.origin_url).origin;
            } catch {
              continue;
            }
            insert.run(
              origin,
              row.username_value.slice(0, 512),
              safeStorage.encryptString(password.toString('utf8')),
              row.date_last_used > 0 ? chromeTimestampToUnixMs(row.date_last_used) : Date.now(),
            );
            importedCount += 1;
          }
          return importedCount;
        });
        imported.passwords += transaction();
      } finally {
        source.close();
      }
    }

    if (request.history) {
      const source = openSourceDb(path.join(profilePath, 'History'));
      try {
        const rows = source
          .prepare(
            'SELECT url, title, last_visit_time, visit_count FROM urls ORDER BY last_visit_time DESC LIMIT 20000',
          )
          .all() as Array<{
          url: string;
          title: string;
          last_visit_time: number;
          visit_count: number;
        }>;
        const insert = destination.prepare(
          'INSERT OR REPLACE INTO imported_history(url, title, last_visit_at, visit_count) VALUES (?, ?, ?, ?)',
        );
        const transaction = destination.transaction(() => {
          let importedCount = 0;
          for (const row of rows) {
            throwIfImportAborted(signal);
            const url = sanitizeBrowserHistoryUrl(row.url);
            if (!url) continue;
            const timestamp = chromeTimestampToUnixMs(row.last_visit_time);
            insert.run(url, row.title.slice(0, 512), timestamp, row.visit_count);
            importedCount += 1;
          }
          return importedCount;
        });
        imported.history += transaction();
      } finally {
        source.close();
      }
    }

    if (request.cookies && key) {
      const cookieDatabasePath = [
        path.join(profilePath, 'Network', 'Cookies'),
        path.join(profilePath, 'Cookies'),
      ].find(candidate => fs.existsSync(candidate));
      if (!cookieDatabasePath) throw new Error('Chrome cookie database is unavailable.');
      const source = openSourceDb(cookieDatabasePath);
      try {
        const rawDatabaseVersion = Number(
          (
            source.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
              { value?: unknown } | undefined
          )?.value ?? 0,
        );
        const databaseVersion = Number.isInteger(rawDatabaseVersion) ? rawDatabaseVersion : 0;
        const cookieColumns = new Set(
          (source.prepare('PRAGMA table_info(cookies)').all() as Array<{ name: string }>).map(
            column => column.name,
          ),
        );
        const partitionExpression = cookieColumns.has('top_frame_site_key')
          ? 'top_frame_site_key'
          : "'' AS top_frame_site_key";
        const rows = source
          .prepare(
            `SELECT host_key, name, value, path, encrypted_value, expires_utc, is_secure, is_httponly,
              samesite, ${partitionExpression} FROM cookies`,
          )
          .all() as Array<{
          host_key: string;
          name: string;
          value: string;
          path: string;
          encrypted_value: Buffer;
          expires_utc: number;
          is_secure: number;
          is_httponly: number;
          samesite: number;
          top_frame_site_key: string;
        }>;
        const targetSession = session.fromPartition(
          browserPartitionForProfile(request.destinationProfile ?? 'embedded'),
        );
        const requestedDomainSet = new Set(
          requestedDomains?.filter(domain => domain !== null) ?? [],
        );
        for (const row of rows) {
          throwIfImportAborted(signal);
          const cookieDomain = row.host_key.toLowerCase().replace(/^\./, '');
          if (
            requestedDomainSet.size > 0 &&
            ![...requestedDomainSet].some(
              domain => cookieDomain === domain || cookieDomain.endsWith(`.${domain}`),
            )
          ) {
            continue;
          }
          const decrypted = row.encrypted_value.length
            ? decryptChromeValue(row.encrypted_value, key)
            : Buffer.from(row.value ?? '', 'utf8');
          if (decrypted === null) {
            skippedAppBound.cookies += 1;
            continue;
          }
          const details = buildChromeCookieDetails(row, decrypted, databaseVersion);
          if (!details) {
            failed.cookies += 1;
            continue;
          }
          try {
            await targetSession.cookies.set(details);
            throwIfImportAborted(signal);
            imported.cookies += 1;
          } catch {
            throwIfImportAborted(signal);
            failed.cookies += 1;
          }
        }
        throwIfImportAborted(signal);
        await targetSession.cookies.flushStore();
        throwIfImportAborted(signal);
      } finally {
        source.close();
      }
    }
  } catch (error) {
    throwIfImportAborted(signal);
    const errorCode = /locked|busy/i.test(String(error)) ? 'chrome-running' : 'source-unavailable';
    return {
      success: false,
      errorCode,
      imported,
      skippedAppBound,
    };
  } finally {
    destination?.close();
  }

  return { success: true, imported, skippedAppBound, failed };
};

export const getImportedCredentials = (origin: string): BrowserImportedCredential[] => {
  let normalizedOrigin: string;
  try {
    normalizedOrigin = new URL(origin).origin;
  } catch {
    return [];
  }
  if (!/^https?:\/\//i.test(normalizedOrigin)) return [];
  const dbPath = path.join(app.getPath('userData'), 'browser-import.sqlite');
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        'SELECT username, password FROM imported_passwords WHERE origin = ? ORDER BY updated_at DESC LIMIT 10',
      )
      .all(normalizedOrigin) as Array<{ username: string; password: Buffer }>;
    return rows.flatMap(row => {
      try {
        return [{ username: row.username, password: safeStorage.decryptString(row.password) }];
      } catch {
        return [];
      }
    });
  } finally {
    db.close();
  }
};

export const recordBrowserHistory = (url: string, title: string, faviconUrl?: string): void => {
  const safeUrl = sanitizeBrowserHistoryUrl(url);
  if (!safeUrl) return;
  const db = openImportedDataDb();
  try {
    db.prepare(
      `INSERT INTO imported_history(url, title, last_visit_at, visit_count, favicon_url)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(url) DO UPDATE SET title = excluded.title,
         last_visit_at = excluded.last_visit_at,
         visit_count = imported_history.visit_count + 1,
         favicon_url = CASE WHEN excluded.favicon_url <> '' THEN excluded.favicon_url
           ELSE imported_history.favicon_url END`,
    ).run(
      safeUrl,
      title.slice(0, 512),
      Date.now(),
      faviconUrl ? (sanitizeBrowserHistoryUrl(faviconUrl) ?? '') : '',
    );
  } finally {
    db.close();
  }
};

export const updateBrowserHistoryFavicon = (url: string, faviconUrl: string): void => {
  const safeUrl = sanitizeBrowserHistoryUrl(url);
  const safeFaviconUrl = sanitizeBrowserHistoryUrl(faviconUrl);
  if (!safeUrl || !safeFaviconUrl) return;
  const db = openImportedDataDb();
  try {
    db.prepare('UPDATE imported_history SET favicon_url = ? WHERE url = ?').run(
      safeFaviconUrl,
      safeUrl,
    );
  } finally {
    db.close();
  }
};

export const updateBrowserHistoryFaviconData = (url: string, dataUrl: string): void => {
  const safeUrl = sanitizeBrowserHistoryUrl(url);
  if (!safeUrl || !isBrowserFaviconDataUrl(dataUrl)) return;
  const db = openImportedDataDb();
  try {
    db.prepare('UPDATE imported_history SET favicon_data_url = ? WHERE url = ?').run(
      dataUrl,
      safeUrl,
    );
  } finally {
    db.close();
  }
};

export const clearBrowserHistoryFaviconDataSince = (since: number | null): void => {
  invalidateBrowserFaviconCache();
  const db = openImportedDataDb();
  try {
    if (since === null) db.prepare("UPDATE imported_history SET favicon_data_url = ''").run();
    else
      db.prepare("UPDATE imported_history SET favicon_data_url = '' WHERE last_visit_at >= ?").run(
        since,
      );
  } finally {
    db.close();
  }
};

export const readBrowserHistoryFavicon = (
  url: string,
): { faviconUrl: string; faviconDataUrl: string } | null => {
  const safeUrl = sanitizeBrowserHistoryUrl(url);
  const dbPath = path.join(app.getPath('userData'), 'browser-import.sqlite');
  if (!safeUrl || !fs.existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const iconColumn = hasHistoryFaviconColumn(db) ? 'favicon_url' : "'' AS favicon_url";
    const dataColumn = hasHistoryFaviconDataColumn(db)
      ? 'favicon_data_url'
      : "'' AS favicon_data_url";
    const row = db
      .prepare(`SELECT ${iconColumn}, ${dataColumn} FROM imported_history WHERE url = ?`)
      .get(safeUrl) as { favicon_url: string; favicon_data_url: string } | undefined;
    return row ? { faviconUrl: row.favicon_url, faviconDataUrl: row.favicon_data_url } : null;
  } finally {
    db.close();
  }
};

export const listBrowserHistory = (query: string): BrowserHistoryEntry[] => {
  const dbPath = path.join(app.getPath('userData'), 'browser-import.sqlite');
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const faviconColumn = hasHistoryFaviconColumn(db) ? 'favicon_url' : "'' AS favicon_url";
    const normalized = query.replace(/[%_\\]/g, character => `\\${character}`).slice(0, 200);
    const rows = (
      normalized
        ? db
            .prepare(
              `SELECT url, title, last_visit_at, visit_count, ${faviconColumn} FROM imported_history
             WHERE title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\'
             ORDER BY last_visit_at DESC LIMIT 2000`,
            )
            .all(`%${normalized}%`, `%${normalized}%`)
        : db
            .prepare(
              `SELECT url, title, last_visit_at, visit_count, ${faviconColumn} FROM imported_history ORDER BY last_visit_at DESC LIMIT 2000`,
            )
            .all()
    ) as Array<{
      url: string;
      title: string;
      last_visit_at: number;
      visit_count: number;
      favicon_url: string;
    }>;
    return rows.map(row => ({
      url: row.url,
      title: row.title,
      lastVisitAt: row.last_visit_at,
      visitCount: row.visit_count,
      ...(row.favicon_url ? { faviconUrl: row.favicon_url } : {}),
    }));
  } finally {
    db.close();
  }
};

export const deleteBrowserHistory = (urls: string[]): number => {
  const values = urls.filter(url => /^https?:\/\//i.test(url) && url.length <= 4096).slice(0, 500);
  if (!values.length) return 0;
  invalidateBrowserFaviconCache();
  const db = openImportedDataDb();
  try {
    const remove = db.prepare('DELETE FROM imported_history WHERE url = ?');
    return db.transaction(() =>
      values.reduce((count, url) => count + remove.run(url).changes, 0),
    )();
  } finally {
    db.close();
  }
};

export const clearBrowserHistory = (): number => {
  invalidateBrowserFaviconCache();
  const db = openImportedDataDb();
  try {
    return db.prepare('DELETE FROM imported_history').run().changes;
  } finally {
    db.close();
  }
};

const rangeClause = (since: number | null): { sql: string; params: number[] } =>
  since === null ? { sql: '', params: [] } : { sql: ' WHERE last_visit_at >= ?', params: [since] };

export const countBrowserHistorySince = (
  since: number | null,
): { count: number; latestOrigin: string } => {
  const dbPath = path.join(app.getPath('userData'), 'browser-import.sqlite');
  if (!fs.existsSync(dbPath)) return { count: 0, latestOrigin: '' };
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const clause = rangeClause(since);
    const row = db
      .prepare(`SELECT COUNT(*) AS count FROM imported_history${clause.sql}`)
      .get(...clause.params) as { count: number };
    const latest = db
      .prepare(`SELECT url FROM imported_history${clause.sql} ORDER BY last_visit_at DESC LIMIT 1`)
      .get(...clause.params) as { url?: string } | undefined;
    let latestOrigin = '';
    try {
      latestOrigin = latest?.url ? new URL(latest.url).hostname : '';
    } catch {
      latestOrigin = '';
    }
    return { count: row.count, latestOrigin };
  } finally {
    db.close();
  }
};

export const clearBrowserHistorySince = (since: number | null): number => {
  invalidateBrowserFaviconCache();
  const db = openImportedDataDb();
  try {
    return since === null
      ? db.prepare('DELETE FROM imported_history').run().changes
      : db.prepare('DELETE FROM imported_history WHERE last_visit_at >= ?').run(since).changes;
  } finally {
    db.close();
  }
};

const validDownloadId = (id: string): boolean => id.length > 0 && id.length <= 200;

const sanitizeDownloadSource = (value: string): string => {
  try {
    const candidate = value.startsWith('blob:') ? value.slice(5) : value;
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : '';
  } catch {
    return '';
  }
};

export const recordBrowserDownload = (entry: BrowserDownloadEntry, savePath = ''): void => {
  if (!validDownloadId(entry.id)) return;
  const db = openImportedDataDb();
  try {
    db.prepare(
      `INSERT OR REPLACE INTO browser_downloads(
        id, file_name, source_url, save_path, state, received_bytes, total_bytes, started_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.id,
      entry.fileName.slice(0, 512),
      sanitizeDownloadSource(entry.sourceUrl),
      savePath,
      entry.state,
      Math.max(0, Math.floor(entry.receivedBytes)),
      Math.max(0, Math.floor(entry.totalBytes)),
      entry.startedAt,
      entry.updatedAt,
    );
  } finally {
    db.close();
  }
};

export const updateBrowserDownload = (
  id: string,
  update: {
    state: BrowserDownloadState;
    receivedBytes: number;
    totalBytes: number;
    savePath?: string;
  },
): void => {
  if (!validDownloadId(id)) return;
  const db = openImportedDataDb();
  try {
    db.prepare(
      `UPDATE browser_downloads SET state = ?, received_bytes = ?, total_bytes = ?,
       save_path = COALESCE(?, save_path), updated_at = ? WHERE id = ?`,
    ).run(
      update.state,
      Math.max(0, Math.floor(update.receivedBytes)),
      Math.max(0, Math.floor(update.totalBytes)),
      update.savePath,
      Date.now(),
      id,
    );
  } finally {
    db.close();
  }
};

export const listBrowserDownloads = (query: string): BrowserDownloadEntry[] => {
  const dbPath = path.join(app.getPath('userData'), 'browser-import.sqlite');
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const normalized = query.replace(/[%_\\]/g, character => `\\${character}`).slice(0, 200);
    const rows = (
      normalized
        ? db
            .prepare(
              `SELECT id, file_name, source_url, state, received_bytes, total_bytes, started_at, updated_at
             FROM browser_downloads WHERE file_name LIKE ? ESCAPE '\\' OR source_url LIKE ? ESCAPE '\\'
             ORDER BY updated_at DESC LIMIT 2000`,
            )
            .all(`%${normalized}%`, `%${normalized}%`)
        : db
            .prepare(
              `SELECT id, file_name, source_url, state, received_bytes, total_bytes, started_at, updated_at
             FROM browser_downloads ORDER BY updated_at DESC LIMIT 2000`,
            )
            .all()
    ) as Array<{
      id: string;
      file_name: string;
      source_url: string;
      state: BrowserDownloadState;
      received_bytes: number;
      total_bytes: number;
      started_at: number;
      updated_at: number;
    }>;
    return rows.map(row => ({
      id: row.id,
      fileName: row.file_name,
      sourceUrl: row.source_url,
      state: row.state,
      receivedBytes: row.received_bytes,
      totalBytes: row.total_bytes,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
    }));
  } finally {
    db.close();
  }
};

export const deleteBrowserDownloads = (ids: string[]): number => {
  const values = ids.filter(validDownloadId).slice(0, 500);
  if (!values.length) return 0;
  const db = openImportedDataDb();
  try {
    const remove = db.prepare('DELETE FROM browser_downloads WHERE id = ?');
    return db.transaction(() => values.reduce((count, id) => count + remove.run(id).changes, 0))();
  } finally {
    db.close();
  }
};

export const clearBrowserDownloads = (): number => {
  const db = openImportedDataDb();
  try {
    return db.prepare('DELETE FROM browser_downloads').run().changes;
  } finally {
    db.close();
  }
};

export const countBrowserDownloadsSince = (since: number | null): number => {
  const dbPath = path.join(app.getPath('userData'), 'browser-import.sqlite');
  if (!fs.existsSync(dbPath)) return 0;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare(
        since === null
          ? 'SELECT COUNT(*) AS count FROM browser_downloads'
          : 'SELECT COUNT(*) AS count FROM browser_downloads WHERE started_at >= ?',
      )
      .get(...(since === null ? [] : [since])) as { count: number };
    return row.count;
  } finally {
    db.close();
  }
};

export const clearBrowserDownloadsSince = (since: number | null): number => {
  const db = openImportedDataDb();
  try {
    return since === null
      ? db.prepare('DELETE FROM browser_downloads').run().changes
      : db.prepare('DELETE FROM browser_downloads WHERE started_at >= ?').run(since).changes;
  } finally {
    db.close();
  }
};

export const countImportedCredentialsSince = (since: number | null): number => {
  const dbPath = path.join(app.getPath('userData'), 'browser-import.sqlite');
  if (!fs.existsSync(dbPath)) return 0;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare(
        since === null
          ? 'SELECT COUNT(*) AS count FROM imported_passwords'
          : 'SELECT COUNT(*) AS count FROM imported_passwords WHERE updated_at >= ?',
      )
      .get(...(since === null ? [] : [since])) as { count: number };
    return row.count;
  } finally {
    db.close();
  }
};

export const clearImportedCredentialsSince = (since: number | null): number => {
  const db = openImportedDataDb();
  try {
    return since === null
      ? db.prepare('DELETE FROM imported_passwords').run().changes
      : db.prepare('DELETE FROM imported_passwords WHERE updated_at >= ?').run(since).changes;
  } finally {
    db.close();
  }
};

export const getBrowserDownloadPath = (id: string): string | null => {
  if (!validDownloadId(id)) return null;
  const dbPath = path.join(app.getPath('userData'), 'browser-import.sqlite');
  if (!fs.existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare('SELECT save_path FROM browser_downloads WHERE id = ? AND state = ?')
      .get(id, 'completed') as { save_path: string } | undefined;
    return row?.save_path && fs.existsSync(row.save_path) ? row.save_path : null;
  } finally {
    db.close();
  }
};
