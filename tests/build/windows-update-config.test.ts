import { createHash } from 'crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import { APP_UPDATE_CONFIG, resolveAppUpdateFeedUrl, resolveAppUpdateResourceUrl } from '../../src/config/appUpdate';

const { readWindowsUpdateConfig } = require('../../scripts/packaging/windows-update-config.cjs') as {
  readWindowsUpdateConfig: (env?: Record<string, string>, config?: { feedUrl: unknown }) => { feedUrl: string } | null;
};
const { verifyWindowsUpdateArtifacts } = require('../../scripts/packaging/verify-windows-update-artifacts.cjs') as {
  verifyWindowsUpdateArtifacts: (root: string, env?: Record<string, string>, config?: { feedUrl: string } | null) => Promise<unknown>;
};
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const temporary = () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'update-artifacts-'));
  directories.push(directory);
  return directory;
};

describe('Windows update build configuration', () => {
  test('ships no update feed and does not enable networking through inherited environment values', () => {
    expect(APP_UPDATE_CONFIG.feedUrl).toBe('');
    expect(readWindowsUpdateConfig()).toBeNull();
    expect(readWindowsUpdateConfig({ ELECTRON_UPDATE_FEED_URL: 'https://xxx.com/feed', JUSTDO_UPDATE_URL: 'https://public.invalid/feed' })).toBeNull();
    expect(resolveAppUpdateResourceUrl('release-history.json')).toBeUndefined();
  });

  test.each(['', '   ', 'not-a-url', 'file:///updates', 'https://xxx.com/feed', 'https://sub.xxx.com./feed', 'https://example.com/feed', 'https://updates.example/feed', 'https://updates.invalid/feed', 'https://u:p@updates.corp.internal/feed', 'https://updates.corp.internal/feed?token=secret'])('rejects an unconfigured or unsafe feed: %s', feedUrl => {
    expect(resolveAppUpdateFeedUrl(feedUrl)).toBeUndefined();
    expect(readWindowsUpdateConfig({}, { feedUrl })).toBeNull();
  });

  test.each(['https://updates.corp.internal/desktop', 'http://10.12.34.56:8080/updates', 'https://intranet/desktop'])('retains explicit deployment feeds: %s', feedUrl => {
    expect(readWindowsUpdateConfig({}, { feedUrl })).toEqual({ feedUrl });
    expect(resolveAppUpdateResourceUrl('release-history.json', feedUrl)).toBe(`${feedUrl}/release-history.json`);
  });

  test('unconfigured artifact verification succeeds without update files', async () => {
    await expect(verifyWindowsUpdateArtifacts(temporary())).resolves.toEqual({ autoUpdateDisabled: true });
  });

  test('verifies a configured release and detects an inconsistent packaged marker', async () => {
    const root = temporary();
    const feedUrl = 'https://updates.corp.internal/desktop';
    const body = Buffer.from('fixture installer');
    const sha512 = createHash('sha512').update(body).digest('base64');
    const filename = 'Desktop Setup 2026.10.20.exe';
    const latest = { version: '2026.10.20', releaseDate: '2026-10-19T00:00:00.000Z', releaseNotes: 'Release notes' };
    writeFileSync(path.join(root, filename), body);
    writeFileSync(path.join(root, 'latest.yml'), JSON.stringify({ ...latest, path: filename, sha512, files: [{ url: filename, size: body.length, sha512 }] }));
    writeFileSync(path.join(root, 'release-history.json'), JSON.stringify({ schemaVersion: 1, latestVersion: latest.version, releases: [latest] }));
    const resources = path.join(root, 'win-unpacked/resources');
    mkdirSync(resources, { recursive: true });
    writeFileSync(path.join(resources, 'app-update.yml'), JSON.stringify({ provider: 'generic', url: feedUrl }));
    const marker = path.join(resources, '.justdo-auto-update-configured');
    writeFileSync(marker, `${feedUrl}\n`);
    await expect(verifyWindowsUpdateArtifacts(root, {}, { feedUrl })).resolves.toMatchObject({ installerPath: path.join(root, filename) });
    writeFileSync(marker, 'https://xxx.com/feed');
    await expect(verifyWindowsUpdateArtifacts(root, {}, { feedUrl })).rejects.toThrow('marker does not match');
  });

  test.each(['latest.yml', 'release-history.json', 'win-unpacked/resources/app-update.yml', 'win-unpacked/resources/.justdo-auto-update-configured'])('rejects stale unconfigured update artifacts: %s', async relative => {
    const root = temporary();
    const filename = path.join(root, relative);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, 'stale');
    await expect(verifyWindowsUpdateArtifacts(root)).rejects.toThrow('stale update artifact');
    expect(readFileSync(filename, 'utf8')).toBe('stale');
  });
});
