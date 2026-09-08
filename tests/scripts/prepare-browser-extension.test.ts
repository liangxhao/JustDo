import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const { prepareBrowserExtension, verifyBrowserExtension } =
  require('../../scripts/prepare-browser-extension.cjs') as {
    prepareBrowserExtension: (options: {
      outputDir?: string;
      productName?: string;
      repoRoot: string;
    }) => {
      outputDir: string;
      productName: string;
      sourceDir: string;
    };
    verifyBrowserExtension: (
      extensionDir: string,
      options?: { productName?: string; repoRoot?: string },
    ) => unknown;
  };

const projectRoot = path.resolve(__dirname, '../..');
const projectProductName = JSON.parse(
  fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
).productName as string;

const createFixture = () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-browser-extension-'));
  fs.cpSync(
    path.join(projectRoot, 'resources', 'browser-extension'),
    path.join(repoRoot, 'resources', 'browser-extension'),
    { recursive: true },
  );
  fs.copyFileSync(path.join(projectRoot, 'package.json'), path.join(repoRoot, 'package.json'));
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

  test('packages the product-branded extension with relay authentication v2 intact', () => {
    const repoRoot = createFixture();

    try {
      const first = prepareBrowserExtension({ repoRoot });
      const second = prepareBrowserExtension({ repoRoot });
      const manifest = JSON.parse(
        fs.readFileSync(path.join(second.outputDir, 'manifest.json'), 'utf8'),
      ) as {
        action: { default_title: string };
        description: string;
        name: string;
        permissions: string[];
        version: string;
      };
      const popup = fs.readFileSync(path.join(second.outputDir, 'popup.js'), 'utf8');
      const relayCore = fs.readFileSync(
        path.join(second.outputDir, 'modules', 'relay-core.js'),
        'utf8',
      );

      expect(first.sourceDir).toBe(second.sourceDir);
      expect(second.productName).toBe(projectProductName);
      expect(manifest).toMatchObject({
        name: projectProductName,
        version: '2.2.0',
        action: { default_title: projectProductName },
      });
      expect(manifest.description).toContain(projectProductName);
      expect(manifest.permissions).not.toContain('nativeMessaging');
      expect(popup).toContain('chrome.runtime.openOptionsPage()');
      expect(relayCore).toContain('openclaw-extension-relay.v2');
      expect(relayCore).toContain('authVersion');
      expect(fs.existsSync(path.join(second.outputDir, 'modules', 'relay-auth-v2.js'))).toBe(true);
      expect(fs.existsSync(path.join(second.outputDir, 'options.html'))).toBe(true);
      expect(fs.existsSync(path.join(second.outputDir, 'manifest.template.json'))).toBe(false);
      expect(() => verifyBrowserExtension(second.outputDir, { repoRoot })).not.toThrow();
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('injects package.json productName into every customer-facing extension surface', () => {
    const repoRoot = createFixture();
    const packagePath = path.join(repoRoot, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as {
      productName: string;
    };
    packageJson.productName = 'Acme';
    fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');

    try {
      const { outputDir } = prepareBrowserExtension({ repoRoot });
      const manifest = JSON.parse(
        fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'),
      ) as { action: { default_title: string }; description: string; name: string };
      const optionsHtml = fs.readFileSync(path.join(outputDir, 'options.html'), 'utf8');
      const popupHtml = fs.readFileSync(path.join(outputDir, 'popup.html'), 'utf8');
      const popupJs = fs.readFileSync(path.join(outputDir, 'popup.js'), 'utf8');

      expect(manifest).toMatchObject({
        name: 'Acme',
        action: { default_title: 'Acme' },
      });
      expect(manifest.description).toContain('Acme');
      expect(optionsHtml).toContain('Connect to Acme');
      expect(optionsHtml).not.toContain('Use local OpenClaw');
      expect(optionsHtml).not.toContain('automaticSetup');
      expect(optionsHtml).not.toContain('openclaw browser');
      expect(popupHtml).toContain('Acme Browser');
      expect(popupJs).toContain('Open Acme to finish setup');
      expect(() => verifyBrowserExtension(outputDir, { repoRoot })).not.toThrow();
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

      expect(() => verifyBrowserExtension(outputDir, { repoRoot })).toThrow(
        'icon must be a 128x128 PNG',
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test.each([
    'THIRD_PARTY_NOTICES.txt',
    'modules/relay-auth-v2-crypto.js',
    'modules/tab-access-command-scope.js',
  ])('rejects a locked snapshot missing %s', relativePath => {
    const repoRoot = createFixture();

    try {
      const { outputDir } = prepareBrowserExtension({ repoRoot });
      fs.rmSync(path.join(outputDir, relativePath));

      expect(() => verifyBrowserExtension(outputDir, { repoRoot })).toThrow(
        'files do not match the locked OpenClaw snapshot',
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('rejects a modified locked extension file', () => {
    const repoRoot = createFixture();

    try {
      const { outputDir } = prepareBrowserExtension({ repoRoot });
      fs.appendFileSync(path.join(outputDir, 'options.js'), '\n// unexpected mutation\n', 'utf8');

      expect(() => verifyBrowserExtension(outputDir, { repoRoot })).toThrow(
        'Browser extension file checksum mismatch: options.js',
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
