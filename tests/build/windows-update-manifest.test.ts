import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

const {
  buildWindowsUpdateManifest,
  buildReleaseHistory,
  normalizeUpdateVersion,
  readReleaseNotes,
  verifyWindowsInstallerArchive,
  verifyWindowsInstallerArchiveListing,
} = require('../../scripts/electron-builder-hooks.cjs') as {
  buildWindowsUpdateManifest: (options: {
    artifactPaths: string[];
    outDir: string;
    packageVersion: string;
    releaseNotesPath: string;
    releaseDate?: string;
  }) => Promise<string>;
  buildReleaseHistory: (options: {
    releaseNotesDir: string;
    outDir: string;
    packageVersion: string;
    releaseDate?: string;
  }) => string;
  normalizeUpdateVersion: (version: string) => string;
  readReleaseNotes: (filePath: string) => string;
  verifyWindowsInstallerArchive: (
    installerPath: string,
    productFilename: string,
    options?: {
      sevenZipExecutable?: string;
      spawnSync?: (executable: string, args: string[], options: unknown) => unknown;
    },
  ) => void;
  verifyWindowsInstallerArchiveListing: (listing: string, productFilename: string) => void;
};

const { validateReleaseHistory } = require('../../scripts/verify-windows-update-artifacts.cjs') as {
  validateReleaseHistory: (history: unknown, manifest: Record<string, unknown>) => boolean;
};

const temporaryDirectories: string[] = [];

const makeTemporaryDirectory = () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'justdo-update-manifest-'));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Windows Generic update manifest', () => {
  test('normalizes the package version and writes installer metadata', async () => {
    const directory = makeTemporaryDirectory();
    const installerPath = path.join(directory, 'JustDo Setup 2026.7.23.exe');
    const notesPath = path.join(directory, 'v2026.7.23.md');
    writeFileSync(installerPath, 'installer payload');
    writeFileSync(notesPath, '<!-- instructions only -->\n');

    const manifestPath = await buildWindowsUpdateManifest({
      artifactPaths: [installerPath],
      outDir: directory,
      packageVersion: 'v2026.7.23',
      releaseNotesPath: notesPath,
      releaseDate: '2026-08-04T00:00:00.000Z',
    });

    const manifest = readFileSync(manifestPath, 'utf8');
    expect(manifest).toContain('version: 2026.7.23');
    expect(manifest).toContain('url: JustDo Setup 2026.7.23.exe');
    expect(manifest).toContain('size: 17');
    expect(manifest).toContain("releaseNotes: ''");
  });

  test('preserves trimmed multiline Markdown release notes', () => {
    const directory = makeTemporaryDirectory();
    const notesPath = path.join(directory, 'v2026.7.24.md');
    writeFileSync(notesPath, '\n## Changes\n\n- Fixed updates\n');

    expect(readReleaseNotes(notesPath)).toBe('## Changes\n\n- Fixed updates');
  });

  test('writes release history with the same latest version and notes as latest.yml', async () => {
    const directory = makeTemporaryDirectory();
    const notesDirectory = path.join(directory, 'notes');
    const installerPath = path.join(directory, 'JustDo Setup 2026.8.12.exe');
    require('fs').mkdirSync(notesDirectory);
    writeFileSync(installerPath, 'installer payload');
    writeFileSync(path.join(notesDirectory, 'v2026.8.11.md'), '# Older\n\n- Previous change');
    writeFileSync(path.join(notesDirectory, 'v2026.8.12.md'), '# Latest\n\n- New change');
    const releaseDate = '2026-08-12T08:00:00.000Z';

    const manifestPath = await buildWindowsUpdateManifest({
      artifactPaths: [installerPath],
      outDir: directory,
      packageVersion: 'v2026.8.12',
      releaseNotesPath: path.join(notesDirectory, 'v2026.8.12.md'),
      releaseDate,
    });
    const historyPath = buildReleaseHistory({
      releaseNotesDir: notesDirectory,
      outDir: directory,
      packageVersion: 'v2026.8.12',
      releaseDate,
    });

    const manifest = require('js-yaml').load(readFileSync(manifestPath, 'utf8'));
    const history = JSON.parse(readFileSync(historyPath, 'utf8'));
    expect(history.latestVersion).toBe(manifest.version);
    expect(history.releases[0]).toMatchObject({
      version: manifest.version,
      releaseDate: manifest.releaseDate,
      releaseNotes: manifest.releaseNotes,
    });
    expect(history.releases.map((release: { version: string }) => release.version)).toEqual([
      '2026.8.12',
      '2026.8.11',
    ]);
  });

  test('rejects missing release notes and ambiguous installers', async () => {
    const directory = makeTemporaryDirectory();
    expect(() => readReleaseNotes(path.join(directory, 'missing.md'))).toThrow(
      'Missing release notes file',
    );
    expect(normalizeUpdateVersion('v2026.7.23')).toBe('2026.7.23');
    expect(() => normalizeUpdateVersion('next')).toThrow('Invalid application version');

    const notesPath = path.join(directory, 'v2026.7.23.md');
    writeFileSync(notesPath, '');
    await expect(
      buildWindowsUpdateManifest({
        artifactPaths: [],
        outDir: directory,
        packageVersion: 'v2026.7.23',
        releaseNotesPath: notesPath,
      }),
    ).rejects.toThrow('Expected exactly one Windows EXE artifact');
  });

  test('rejects malformed, duplicate, or incorrectly ordered history entries', () => {
    const manifest = {
      version: '2026.8.12',
      releaseDate: '2026-08-12T08:00:00.000Z',
      releaseNotes: 'Latest notes',
    };
    const latest = {
      version: manifest.version,
      releaseDate: manifest.releaseDate,
      releaseNotes: manifest.releaseNotes,
    };
    const older = {
      version: '2026.8.11',
      releaseDate: '2026-08-11T00:00:00.000Z',
      releaseNotes: 'Older notes',
    };
    const makeHistory = (releases: unknown[]) => ({
      schemaVersion: 1,
      latestVersion: manifest.version,
      releases,
    });

    expect(validateReleaseHistory(makeHistory([latest, older]), manifest)).toBe(true);
    expect(validateReleaseHistory(makeHistory([latest, { ...older, releaseNotes: 42 }]), manifest))
      .toBe(false);
    expect(validateReleaseHistory(makeHistory([latest, latest]), manifest)).toBe(false);
    expect(
      validateReleaseHistory(
        makeHistory(Array.from({ length: 201 }, (_, index) => ({ ...latest, index }))),
        manifest,
      ),
    ).toBe(false);
    expect(
      validateReleaseHistory(
        makeHistory([latest, { ...older, releaseNotes: 'x'.repeat(100_001) }]),
        manifest,
      ),
    ).toBe(false);
    expect(
      validateReleaseHistory(
        makeHistory([
          latest,
          { ...older, version: '2026.8.13', releaseDate: '2026-08-13T00:00:00.000Z' },
        ]),
        manifest,
      ),
    ).toBe(false);
  });

  test('fails packaging when one release note exceeds the client limit', () => {
    const directory = makeTemporaryDirectory();
    const notesDirectory = path.join(directory, 'notes');
    require('fs').mkdirSync(notesDirectory);
    writeFileSync(path.join(notesDirectory, 'v2026.8.12.md'), 'x'.repeat(100_001));

    expect(() =>
      buildReleaseHistory({
        releaseNotesDir: notesDirectory,
        outDir: directory,
        packageVersion: 'v2026.8.12',
      }),
    ).toThrow('exceed 100000 characters');
  });
});

describe('Windows installer application archive', () => {
  const requiredEntries = `
Path = JustDo.exe
Method = BCJ LZMA2:20
Path = chrome_100_percent.pak
Method = LZMA2:20
Path = icudtl.dat
Method = LZMA2:20
Path = libEGL.dll
Method = BCJ LZMA2:20
Path = libGLESv2.dll
Method = BCJ LZMA2:20
Path = locales/en-US.pak
Method = LZMA2:20
Path = locales/zh-CN.pak
Method = LZMA2:20
Path = resources.pak
Method = LZMA2:20
Path = resources/app.asar
Method = LZMA2:20
Path = resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node
Method = BCJ LZMA2:20
Path = resources/unpack-cfmind.cjs
Method = LZMA2:20
Path = resources/win-resources-metadata.json
Method = LZMA2:20
`;

  test('accepts the single-stream BCJ methods supported by install-time Nsis7z', () => {
    const listing = `Type = 7z\nMethod = LZMA2:20 BCJ\n${requiredEntries}`;

    expect(() => verifyWindowsInstallerArchiveListing(listing, 'JustDo')).not.toThrow();
  });

  test('rejects a BCJ2 archive that would silently omit executable files', () => {
    const listing = `Type = 7z\nMethod = LZMA2:20 LZMA:20 BCJ2\n${requiredEntries}`;

    expect(() => verifyWindowsInstallerArchiveListing(listing, 'JustDo')).toThrow(
      'install-time Nsis7z decoder cannot safely read',
    );
  });

  test('rejects an archive missing a required executable payload', () => {
    const listing = `Type = 7z\nMethod = LZMA2:20 BCJ\n${requiredEntries.replace(
      /Path = JustDo\.exe\nMethod = BCJ LZMA2:20\n/,
      '',
    )}`;

    expect(() => verifyWindowsInstallerArchiveListing(listing, 'JustDo')).toThrow(
      'application archive is missing: JustDo.exe',
    );
  });

  test('rejects a listing with no compression method records', () => {
    const listing = `Type = 7z\n${requiredEntries.replace(/^Method = .*$/gm, '')}`;

    expect(() => verifyWindowsInstallerArchiveListing(listing, 'JustDo')).toThrow(
      'contains no compression methods',
    );
  });

  test('rejects an installer whose compressed data fails the 7z integrity test', () => {
    const listing = `Type = 7z\nMethod = LZMA2:20 BCJ\n${requiredEntries}`;
    const calls: string[][] = [];
    const fakeSpawnSync = (_executable: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'l') return { status: 0, stdout: listing, stderr: '' };
      return { status: 2, stdout: '', stderr: 'CRC Failed' };
    };

    expect(() =>
      verifyWindowsInstallerArchive('JustDo Setup.exe', 'JustDo', {
        sevenZipExecutable: '7za',
        spawnSync: fakeSpawnSync,
      }),
    ).toThrow('Could not decompress and CRC-test');
    expect(calls.map(args => args[0])).toEqual(['l', 't']);
  });
});
