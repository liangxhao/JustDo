import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { afterEach, describe, expect, test } from 'vitest';

import {
  createLocalHtmlPreview,
  isAllowedLocalHtmlPreviewResource,
  isLocalHtmlPreviewUrl,
  isSameLocalHtmlPreviewScope,
  isWindowsNetworkOrDevicePath,
  resolveLocalHtmlPreviewFilePath,
} from './localHtmlPreviewServer';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('local HTML preview server', () => {
  test('serves an HTML entry and its ordinary web assets from an unguessable loopback URL', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-html-preview-'));
    temporaryDirectories.push(directory);
    fs.writeFileSync(
      path.join(directory, 'report.html'),
      '<link rel="stylesheet" href="style.css">',
    );
    fs.writeFileSync(path.join(directory, 'style.css'), 'body { color: red; }');

    const result = await createLocalHtmlPreview('report.html', directory);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.filePath).toBe(fs.realpathSync(path.join(directory, 'report.html')));
    expect(result.rootPath).toBe(fs.realpathSync(directory));
    expect(result.previewRootUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/$/u);
    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/report\.html$/u);
    expect(isLocalHtmlPreviewUrl(result.url)).toBe(true);
    expect(
      isSameLocalHtmlPreviewScope(result.url, new URL('style.css', result.url).toString()),
    ).toBe(true);
    expect(isSameLocalHtmlPreviewScope(result.url, 'https://example.com/')).toBe(false);
    const htmlResponse = await fetch(result.url);
    expect(htmlResponse.headers.get('referrer-policy')).toBe('same-origin');
    expect(htmlResponse.headers.get('content-security-policy')).toContain("connect-src 'self'");
    expect(htmlResponse.headers.get('content-security-policy')).toContain(
      "script-src 'self' 'unsafe-inline' blob:",
    );
    expect(htmlResponse.headers.get('content-security-policy')).toContain(
      "worker-src 'self' blob:",
    );
    const previewOrigin = new URL(result.url).origin;
    expect(
      isAllowedLocalHtmlPreviewResource(result.url, `blob:${previewOrigin}/embedded-module`),
    ).toBe(true);
    expect(isAllowedLocalHtmlPreviewResource(result.url, 'data:image/png;base64,AA==')).toBe(true);
    expect(
      isAllowedLocalHtmlPreviewResource(result.url, 'blob:https://example.com/embedded-module'),
    ).toBe(false);
    expect(await htmlResponse.text()).toContain('style.css');
    const cssResponse = await fetch(new URL('style.css', result.url));
    expect(cssResponse.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(await cssResponse.text()).toBe('body { color: red; }');
    const repeated = await createLocalHtmlPreview('report.html', directory);
    expect(repeated.success && repeated.url).toBe(result.url);
  });

  test('redirects root-relative assets into the referring isolated preview scope', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-html-preview-'));
    temporaryDirectories.push(directory);
    fs.mkdirSync(path.join(directory, 'assets'));
    fs.writeFileSync(
      path.join(directory, 'report.html'),
      '<link rel="stylesheet" href="/assets/style.css"><script src="/assets/app.js"></script>',
    );
    fs.writeFileSync(
      path.join(directory, 'assets', 'style.css'),
      'body { background: url(/assets/background.png); }',
    );
    fs.writeFileSync(path.join(directory, 'assets', 'app.js'), 'document.title = "ready";');
    fs.writeFileSync(path.join(directory, 'assets', 'background.png'), 'png');

    const result = await createLocalHtmlPreview('report.html', directory);

    expect(result.success).toBe(true);
    if (!result.success) return;
    const html = await (await fetch(result.url)).text();
    expect(html).toContain('href="/assets/style.css"');
    expect(html).toContain('src="/assets/app.js"');
    const origin = new URL(result.url).origin;
    const cssResponse = await fetch(`${origin}/assets/style.css`, {
      headers: { Referer: result.url },
    });
    expect(cssResponse.url).toBe(new URL('assets/style.css', result.previewRootUrl).toString());
    expect(await cssResponse.text()).toContain('url(/assets/background.png)');
    const imageResponse = await fetch(`${origin}/assets/background.png`, {
      headers: { Referer: cssResponse.url },
    });
    expect(imageResponse.url).toBe(
      new URL('assets/background.png', result.previewRootUrl).toString(),
    );
  });

  test('rejects non-HTML entry points', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-html-preview-'));
    temporaryDirectories.push(directory);
    fs.writeFileSync(path.join(directory, 'notes.txt'), 'not html');

    await expect(createLocalHtmlPreview('notes.txt', directory)).resolves.toEqual({
      success: false,
      errorCode: 'invalid_type',
    });
  });

  test('accepts a file URL for an HTML entry point', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-html-preview-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'report with spaces.html');
    fs.writeFileSync(filePath, '<p>Report</p>');

    const result = await createLocalHtmlPreview(pathToFileURL(filePath).toString());

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.filePath).toBe(fs.realpathSync(filePath));
    await expect(resolveLocalHtmlPreviewFilePath(result.url)).resolves.toBe(result.filePath);
  });

  test('rejects remote-host file URLs before accessing the filesystem', async () => {
    await expect(
      createLocalHtmlPreview('file://attacker.example/share/report.html'),
    ).resolves.toEqual({
      success: false,
      errorCode: 'invalid_source',
    });
  });

  test('recognizes Windows network and device paths before filesystem access', () => {
    expect(isWindowsNetworkOrDevicePath('\\\\attacker.example\\share\\report.html', 'win32')).toBe(
      true,
    );
    expect(isWindowsNetworkOrDevicePath('//attacker.example/share/report.html', 'win32')).toBe(
      true,
    );
    expect(
      isWindowsNetworkOrDevicePath('\\\\?\\UNC\\attacker.example\\share\\report.html', 'win32'),
    ).toBe(true);
    expect(isWindowsNetworkOrDevicePath('\\\\.\\C:\\report.html', 'win32')).toBe(true);
    expect(isWindowsNetworkOrDevicePath('C:\\reports\\report.html', 'win32')).toBe(false);
    expect(isWindowsNetworkOrDevicePath('//srv/report.html', 'linux')).toBe(false);
  });

  test.runIf(process.platform === 'win32')(
    'rejects raw Windows network paths before accessing the filesystem',
    async () => {
      await expect(
        createLocalHtmlPreview('\\\\attacker.example\\share\\report.html'),
      ).resolves.toEqual({
        success: false,
        errorCode: 'invalid_source',
      });
    },
  );

  test('does not expose dotfiles beside the selected document', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-html-preview-'));
    temporaryDirectories.push(directory);
    fs.writeFileSync(path.join(directory, 'report.html'), '<p>Report</p>');
    fs.writeFileSync(path.join(directory, '.secret.txt'), 'secret');

    const result = await createLocalHtmlPreview(path.join(directory, 'report.html'));

    expect(result.success).toBe(true);
    if (!result.success) return;
    const response = await fetch(new URL('.secret.txt', result.url));
    expect(response.status).toBe(404);
  });
});
