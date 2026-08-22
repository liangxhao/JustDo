import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

const {
  buildWindowsUpdateManifest,
  normalizeUpdateVersion,
  readReleaseNotes,
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
