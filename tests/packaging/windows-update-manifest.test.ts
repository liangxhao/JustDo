import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import { BROWSER_AUTHENTICATION_CONFIG } from '../../src/config/browserAuthentication';
import { BROWSER_AUTHENTICATION_EXECUTABLE } from '../../src/main/browser/authentication/browserAuthenticationConfig';
import { resolveBrowserAuthenticationConfig } from '../../src/shared/browser/browserAuthentication';

const hooksPath = require.resolve('../../scripts/packaging/electron-builder-hooks.cjs');

const {
  buildWindowsUpdateManifest,
  buildReleaseHistory,
  normalizeUpdateVersion,
  readReleaseNotes,
  hasWindowsInstallerTarget,
  afterSign,
  verifyWindowsInstallerArchive,
  verifyWindowsInstallerArchiveListing,
  afterAllArtifactBuild,
} = require(hooksPath) as {
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
  hasWindowsInstallerTarget: (targets: Map<{ nodeName: string }, Map<string, unknown>>) => boolean;
  afterSign: (context: {
    electronPlatformName: string;
    appOutDir: string;
    packager: { appInfo: { productFilename: string } };
  }) => Promise<void>;
  verifyWindowsInstallerArchive: (
    installerPath: string,
    productFilename: string,
    options?: {
      sevenZipExecutable?: string;
      spawnSync?: (executable: string, args: string[], options: unknown) => unknown;
    },
  ) => void;
  verifyWindowsInstallerArchiveListing: (listing: string, productFilename: string) => void;
  afterAllArtifactBuild: (context: { outDir: string; platformToTargets: Map<{ nodeName: string }, Map<string, unknown>> }) => Promise<string[]>;
};

const hooksWithAuthenticationExecutable = (executableName: string) => {
  const configPath = require.resolve('../../scripts/packaging/browser-authentication-config.cjs');
  const config = require.cache[configPath]!;
  const originalConfig = config.exports;
  const originalHooks = require.cache[hooksPath];
  try {
    config.exports = { BROWSER_AUTHENTICATION_EXECUTABLE: executableName };
    delete require.cache[hooksPath];
    return require(hooksPath) as { afterSign: typeof afterSign; verifyWindowsInstallerArchiveListing: typeof verifyWindowsInstallerArchiveListing };
  } finally {
    config.exports = originalConfig;
    require.cache[hooksPath] = originalHooks;
  }
};

const fixtureAuthenticationExecutable = 'chrome.exe';

const { validateReleaseHistory } = require('../../scripts/packaging/verify-windows-update-artifacts.cjs') as {
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
  test.each(['v2026.11.02', '2026.09.30', ' 2026.11.2', 'V2026.11.2', '2026.11.2-beta.1'])
  ('rejects update versions that cannot pass startup admission: %s', version => {
    expect(() => normalizeUpdateVersion(version)).toThrow('Invalid application version');
  });

  test('unconfigured NSIS builds remove stale update metadata without requiring an installer feed', async () => {
    const directory = makeTemporaryDirectory();
    for (const name of ['latest.yml', 'release-history.json']) writeFileSync(path.join(directory, name), 'stale');
    expect(await afterAllArtifactBuild({
      outDir: directory,
      platformToTargets: new Map([[{ nodeName: 'win32' }, new Map([['nsis', {}]])]]),
    })).toEqual([]);
    for (const name of ['latest.yml', 'release-history.json']) expect(existsSync(path.join(directory, name))).toBe(false);
  });
  test('distinguishes unpacked directory builds from NSIS installer builds', () => {
    const windows = { nodeName: 'win32' };

    expect(hasWindowsInstallerTarget(new Map([[windows, new Map([['dir', {}]])]]))).toBe(false);
    expect(hasWindowsInstallerTarget(new Map([[windows, new Map([['nsis', {}]])]]))).toBe(true);
  });

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

describe('Windows signed application payload', () => {
  test.each(['', 'electron.exe', 'Chrome.EXE'])('normalizes the configured filename %s', executable => {
    expect(resolveBrowserAuthenticationConfig({
      ...BROWSER_AUTHENTICATION_CONFIG, executableName: executable,
    }).executableName).toBe(executable.toLowerCase());
  });

  test.each(['..\\chrome.exe', 'AUX.exe', 'chrome$R0.exe'])('rejects the unsafe configured filename %s', executable => {
    expect(() => resolveBrowserAuthenticationConfig({
      ...BROWSER_AUTHENTICATION_CONFIG, executableName: executable,
    })).toThrow('executableName');
  });

  test('accepts a different local authentication port and path', () => {
    const config = resolveBrowserAuthenticationConfig({
      executableName: 'electron.exe',
      localEndpoint: 'https://localhost:18081/auth/info',
    });
    expect(config.localEndpoint.href).toBe('https://localhost:18081/auth/info');
  });

  test.each([
    'http://localhost:18080/getSpesInfo',
    'https://example.test:18080/getSpesInfo',
    'https://user@localhost:18080/getSpesInfo',
    'https://localhost:18080/getSpesInfo?token=test',
    'https://localhost:18080/getSpesInfo#fragment',
    'https://localhost:0/getSpesInfo',
  ])('rejects invalid local authentication endpoint %s', localEndpoint => {
    expect(() => resolveBrowserAuthenticationConfig({ executableName: 'electron.exe', localEndpoint }))
      .toThrow('localEndpoint');
  });

  test('skips staging a helper when authentication is disabled', async () => {
    const appOutDir = makeTemporaryDirectory();
    writeFileSync(path.join(appOutDir, 'Fixture.exe'), 'application');
    await hooksWithAuthenticationExecutable('').afterSign({ electronPlatformName: 'win32', appOutDir, packager: { appInfo: { productFilename: 'Fixture' } } });
    expect(readdirSync(appOutDir)).toEqual(['Fixture.exe']);
  });

  test('preserves the branded application and copies its exact bytes for browser authentication', async () => {
    const appOutDir = makeTemporaryDirectory();
    const application = path.join(appOutDir, 'Fixture.exe');
    const bytes = Buffer.from([0x4d, 0x5a, 0, 0xff, 0x7f]);
    writeFileSync(application, bytes);

    await hooksWithAuthenticationExecutable(fixtureAuthenticationExecutable).afterSign({ electronPlatformName: 'win32', appOutDir, packager: { appInfo: { productFilename: 'Fixture' } } });

    expect(readFileSync(application)).toEqual(bytes);
    expect(readFileSync(path.join(appOutDir, fixtureAuthenticationExecutable))).toEqual(bytes);
  });

  test('uses the existing executable when its name already matches the helper', async () => {
    const appOutDir = makeTemporaryDirectory();
    const productFilename = 'CHROME';
    const application = path.join(appOutDir, `${productFilename}.exe`);
    writeFileSync(application, 'existing application');

    await hooksWithAuthenticationExecutable(fixtureAuthenticationExecutable).afterSign({ electronPlatformName: 'win32', appOutDir, packager: { appInfo: { productFilename } } });

    expect(readFileSync(application, 'utf8')).toBe('existing application');
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
  const authenticationEntry = (name: string) => name ? `Path = ${name}\nMethod = BCJ LZMA2:20\n` : '';
  const relayEntry = 'Path = resources/browser-transport/relay.cjs\nMethod = LZMA2:20\n';
  const deployedAuthenticationEntry = BROWSER_AUTHENTICATION_EXECUTABLE
    ? authenticationEntry(BROWSER_AUTHENTICATION_EXECUTABLE) + relayEntry
    : '';

  test('accepts single-stream BCJ application archives', () => {
    const listing = `Type = 7z\nMethod = LZMA2:20 BCJ\n${deployedAuthenticationEntry}${requiredEntries}`;

    expect(() => verifyWindowsInstallerArchiveListing(listing, 'JustDo')).not.toThrow();
  });

  test('does not reject CLI-supported BCJ2 archives by a historical plugin allowlist', () => {
    const listing = `Type = 7z\nMethod = LZMA2:20 LZMA:20 BCJ2\n${deployedAuthenticationEntry}${requiredEntries}`;

    expect(() => verifyWindowsInstallerArchiveListing(listing, 'JustDo')).not.toThrow();
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

  test('requires the authentication executable unless the main executable already has that name', () => {
    const { verifyWindowsInstallerArchiveListing: verifyEnabled } = hooksWithAuthenticationExecutable(fixtureAuthenticationExecutable);
    const listing = `Type = 7z\nMethod = LZMA2:20 BCJ\n${requiredEntries}`;
    expect(() => verifyEnabled(listing + relayEntry, 'JustDo')).toThrow(
      `application archive is missing: ${fixtureAuthenticationExecutable}`,
    );
    const withExecutable = listing + authenticationEntry(fixtureAuthenticationExecutable);
    expect(() => verifyEnabled(withExecutable, 'JustDo')).toThrow(
      'application archive is missing: resources/browser-transport/relay.cjs',
    );
    expect(() => verifyEnabled(withExecutable + relayEntry, 'JustDo')).not.toThrow();
    expect(() => verifyEnabled(listing.replace('JustDo.exe', 'CHROME.exe'), 'CHROME')).not.toThrow();
  });

  test('rejects a listing with no compression method records', () => {
    const listing = `Type = 7z\n${requiredEntries.replace(/^Method = .*$/gm, '')}`;

    expect(() => verifyWindowsInstallerArchiveListing(listing, 'JustDo')).toThrow(
      'contains no compression methods',
    );
  });

  test('rejects an installer whose compressed data fails the 7z integrity test', () => {
    const installerPath = path.join(makeTemporaryDirectory(), 'Setup.exe');
    writeFileSync(installerPath, Buffer.alloc(9 * 1024 * 1024));
    const listing = `Type = 7z\nMethod = LZMA2:20 BCJ\n${deployedAuthenticationEntry}${requiredEntries}`;
    const calls: string[][] = [];
    const fakeSpawnSync = (_executable: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'l') return { status: 0, stdout: listing, stderr: '' };
      return { status: 2, stdout: '', stderr: 'CRC Failed' };
    };

    expect(() =>
      verifyWindowsInstallerArchive(installerPath, 'JustDo', {
        sevenZipExecutable: '7za',
        spawnSync: fakeSpawnSync,
      }),
    ).toThrow('Could not decompress and CRC-test');
    expect(calls.map(args => args[0])).toEqual(['l', 't']);
    expect(calls.every(args => args.includes('-t7z:s9437184b'))).toBe(true);
  });
});
