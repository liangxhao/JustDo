import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const { prepareBrowserExtension, readProductName, verifyBrowserExtension } =
  require('../../scripts/prepare-browser-extension.cjs') as {
    prepareBrowserExtension: (options: { outputDir?: string; repoRoot: string }) => {
      outputDir: string;
      productName: string;
      sourceDir: string;
    };
    readProductName: (repoRoot: string) => string;
    verifyBrowserExtension: (extensionDir: string, productName: string) => unknown;
  };

const projectRoot = path.resolve(__dirname, '../..');

const createFixture = (productName = 'ExampleApp') => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-browser-extension-'));
  fs.writeFileSync(
    path.join(repoRoot, 'package.json'),
    `${JSON.stringify({ name: 'internal-name', productName }, null, 2)}\n`,
    'utf8',
  );
  fs.cpSync(
    path.join(projectRoot, 'resources', 'browser-extension'),
    path.join(repoRoot, 'resources', 'browser-extension'),
    { recursive: true },
  );
  for (const size of [16, 32, 48, 128]) {
    const iconDir = path.join(repoRoot, 'resources', 'icons', 'png');
    fs.mkdirSync(iconDir, { recursive: true });
    fs.copyFileSync(
      path.join(projectRoot, 'resources', 'icons', 'png', `${size}x${size}.png`),
      path.join(iconDir, `${size}x${size}.png`),
    );
  }
  return repoRoot;
};

describe('browser extension preparation', () => {
  test('packages the generated extension as an unpacked application resource', () => {
    const builderConfig = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'electron-builder.json'), 'utf8'),
    ) as { extraResources?: Array<{ from?: string; to?: string }> };

    expect(builderConfig.extraResources).toContainEqual(
      expect.objectContaining({
        from: 'build/browser-extension/chrome-extension',
        to: 'browser-extension/chrome-extension',
      }),
    );
  });

  test('brands the loadable extension from productName and preserves relay protocols', () => {
    const repoRoot = createFixture('ExampleApp');

    try {
      const first = prepareBrowserExtension({ repoRoot });
      const second = prepareBrowserExtension({ repoRoot });
      const manifest = JSON.parse(
        fs.readFileSync(path.join(second.outputDir, 'manifest.json'), 'utf8'),
      ) as { action: { default_title: string }; description: string; name: string };
      const popup = fs.readFileSync(path.join(second.outputDir, 'popup.js'), 'utf8');
      const relayCore = fs.readFileSync(
        path.join(second.outputDir, 'modules', 'relay-core.js'),
        'utf8',
      );

      expect(first.productName).toBe('ExampleApp');
      expect(second.productName).toBe('ExampleApp');
      expect(manifest).toMatchObject({
        name: 'ExampleApp',
        action: { default_title: 'ExampleApp' },
      });
      expect(manifest.description).toContain('ExampleApp');
      expect(popup).toContain('chrome.runtime.getManifest().name');
      expect(relayCore).toContain('openclaw-extension-relay');
      expect(relayCore).toContain('openclaw-extension-token.');
      expect(fs.existsSync(path.join(second.outputDir, 'manifest.template.json'))).toBe(false);
      expect(() => verifyBrowserExtension(second.outputDir, 'ExampleApp')).not.toThrow();
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('reads productName instead of the internal package name', () => {
    const repoRoot = createFixture('VisibleBrand');

    try {
      expect(readProductName(repoRoot)).toBe('VisibleBrand');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('rejects an invalid productName', () => {
    const repoRoot = createFixture('Invalid Brand');

    try {
      expect(() => prepareBrowserExtension({ repoRoot })).toThrow(
        'package.json productName must be a non-reserved English word',
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('rejects an output directory outside the managed build root', () => {
    const repoRoot = createFixture();

    try {
      expect(() =>
        prepareBrowserExtension({
          repoRoot,
          outputDir: path.join(repoRoot, 'outside-browser-extension'),
        }),
      ).toThrow('Browser extension output must be inside');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('rejects an extension with an incorrectly sized icon', () => {
    const repoRoot = createFixture();

    try {
      const { outputDir } = prepareBrowserExtension({ repoRoot });
      fs.copyFileSync(
        path.join(outputDir, 'icons', 'icon16.png'),
        path.join(outputDir, 'icons', 'icon128.png'),
      );

      expect(() => verifyBrowserExtension(outputDir, 'ExampleApp')).toThrow(
        'icon must be a 128x128 PNG',
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
