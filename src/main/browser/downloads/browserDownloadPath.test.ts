import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  resolveAvailableBrowserDownloadPath,
  resolveBrowserDownloadDirectory,
} from './browserDownloadPath';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe('browser download paths', () => {
  test('uses an existing absolute custom directory', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-download-'));
    temporaryDirectories.push(directory);

    expect(resolveBrowserDownloadDirectory(directory, 'C:\\system-downloads')).toBe(directory);
  });

  test.each(['', 'relative/downloads', 'Z:\\missing-download-directory'])(
    'falls back to the system directory for %j',
    configuredDirectory => {
      expect(resolveBrowserDownloadDirectory(configuredDirectory, 'C:\\system-downloads')).toBe(
        'C:\\system-downloads',
      );
    },
  );

  test('sanitizes the suggested name and avoids existing and reserved paths', () => {
    const unavailable = new Set([
      path.join('C:\\downloads', 'report.pdf'),
      path.join('C:\\downloads', 'report (1).pdf'),
    ]);

    expect(
      resolveAvailableBrowserDownloadPath('C:\\downloads', '..\\report.pdf', candidate =>
        unavailable.has(candidate),
      ),
    ).toBe(path.join('C:\\downloads', 'report (2).pdf'));
  });
});
