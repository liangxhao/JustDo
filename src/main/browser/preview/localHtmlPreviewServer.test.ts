import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { afterEach, describe, expect, test } from 'vitest';

import {
  createLocalHtmlPreview,
  isLocalHtmlPreviewUrl,
  resolveLocalHtmlPreviewFilePath,
} from './localHtmlPreviewServer';

const temporaryDirectories: string[] = [];

const createDirectory = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-html-preview-'));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('native local HTML preview', () => {
  test('opens the original document as a file URL without a preview server', async () => {
    const directory = createDirectory();
    const filePath = path.join(directory, 'report.html');
    fs.writeFileSync(filePath, '<link rel="stylesheet" href="../style.css">');

    const result = await createLocalHtmlPreview('report.html', directory);

    expect(result).toEqual({
      success: true,
      url: pathToFileURL(filePath).href,
      filePath,
      rootPath: directory,
      previewRootUrl: pathToFileURL(directory + path.sep).href,
    });
    expect(result.success && isLocalHtmlPreviewUrl(result.url)).toBe(true);
  });

  test('preserves escaped filenames and file URL queries and fragments', async () => {
    const directory = createDirectory();
    const filePath = path.join(directory, '季度报告 #100%.html');
    fs.writeFileSync(filePath, '<p>Report</p>');
    const url = pathToFileURL(filePath);
    url.search = '?mode=3d';
    url.hash = '#camera';

    const result = await createLocalHtmlPreview(url.href);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.url).toBe(url.href);
    expect(fileURLToPath(result.url)).toBe(filePath);
    await expect(resolveLocalHtmlPreviewFilePath(result.url)).resolves.toBe(filePath);
  });

  test('resolves linked HTML in parent directories without registration or directory scopes', async () => {
    const directory = createDirectory();
    fs.mkdirSync(path.join(directory, 'chapters'));
    const entry = path.join(directory, 'chapters', 'report.html');
    const parent = path.join(directory, '.summary.html');
    fs.writeFileSync(entry, '<a href="../.summary.html">Summary</a>');
    fs.writeFileSync(parent, '<p>Summary</p>');
    const result = await createLocalHtmlPreview(entry);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const parentUrl = new URL('../.summary.html', result.url).href;
    expect(isLocalHtmlPreviewUrl(parentUrl)).toBe(true);
    await expect(resolveLocalHtmlPreviewFilePath(parentUrl)).resolves.toBe(parent);
    await expect(createLocalHtmlPreview(parentUrl)).resolves.toMatchObject({
      success: true,
      filePath: parent,
      url: parentUrl,
    });
  });

  test('reports missing files, directories and non-HTML entry points', async () => {
    const directory = createDirectory();
    fs.mkdirSync(path.join(directory, 'folder.html'));
    fs.writeFileSync(path.join(directory, 'notes.txt'), 'Text');

    await expect(createLocalHtmlPreview('missing.html', directory)).resolves.toEqual({
      success: false,
      errorCode: 'not_found',
    });
    await expect(createLocalHtmlPreview('folder.html', directory)).resolves.toEqual({
      success: false,
      errorCode: 'invalid_source',
    });
    await expect(createLocalHtmlPreview('notes.txt', directory)).resolves.toEqual({
      success: false,
      errorCode: 'invalid_type',
    });
  });

  test('does not treat network, executable or generated URLs as local HTML for external opening', async () => {
    for (const url of [
      'https://example.test/report.html',
      'data:text/html,hello',
      'javascript:alert(1)',
      'file:///tmp/script.exe',
      'file:///tmp/report.html\n--incognito',
      'not a URL',
    ]) {
      expect(isLocalHtmlPreviewUrl(url)).toBe(false);
      await expect(resolveLocalHtmlPreviewFilePath(url)).resolves.toBeNull();
    }
  });
});
