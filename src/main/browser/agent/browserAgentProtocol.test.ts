import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { afterEach, expect, test } from 'vitest';

import { normalizeNavigationUrl } from './browserAgentProtocol';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('accepts existing HTML documents and preserves encoded names, query and fragment', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-navigation-'));
  directories.push(directory);
  for (const extension of ['html', 'HTM', 'xhtml']) {
    const file = path.join(directory, `报告 #100%.${extension}`);
    fs.writeFileSync(file, '<html>Report</html>');
    const url = pathToFileURL(file);
    url.search = '?view=chart';
    url.hash = '#section';
    await expect(normalizeNavigationUrl(url.href)).resolves.toBe(url.href);
  }
  const folder = path.join(directory, 'folder.html');
  fs.mkdirSync(folder);
  const text = path.join(directory, 'report.txt');
  fs.writeFileSync(text, 'report');
  for (const invalid of [folder, text, path.join(directory, 'missing.html')]) {
    await expect(normalizeNavigationUrl(pathToFileURL(invalid).href)).rejects.toThrow(
      'existing .html, .htm or .xhtml file',
    );
  }
});

test('retains web navigation and rejects unsupported protocols and metadata endpoints', async () => {
  await expect(normalizeNavigationUrl('about:blank')).resolves.toBe('about:blank');
  await expect(normalizeNavigationUrl('https://example.com')).resolves.toBe('https://example.com/');
  await expect(normalizeNavigationUrl('javascript:alert(1)')).rejects.toThrow('Only http');
  await expect(normalizeNavigationUrl('http://169.254.169.254/')).rejects.toThrow('metadata');
});
