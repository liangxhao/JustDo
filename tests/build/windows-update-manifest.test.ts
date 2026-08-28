import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

const {
  buildWindowsUpdateManifest,
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
