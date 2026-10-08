import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { describe, expect, test, vi } from 'vitest';

const { prepareBrowserExtension, verifyBrowserExtension } =
  require('../../scripts/browser/prepare-browser-extension.cjs') as {
    prepareBrowserExtension: (options: {
      outputDir?: string;
      productName?: string;
      repoRoot: string;
    }) => {
      overlayDir: string;
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
  fs.cpSync(
    path.join(projectRoot, 'resources/icons/png'),
    path.join(repoRoot, 'resources/icons/png'),
    {
      recursive: true,
    },
  );
  return repoRoot;
};

describe('browser extension preparation', () => {
  test('reads bootstrap status without starting another pairing request', async () => {
    const repoRoot = createFixture();
    try {
      const prepared = prepareBrowserExtension({ repoRoot });
      const background = fs.readFileSync(path.join(prepared.outputDir, 'background.js'), 'utf8');
      const getter = background.match(
        /getNativeBootstrapStatus: (async \(\) => \{[\s\S]*?\n  \}),/,
      );
      expect(getter).not.toBeNull();
      const attempt = vi.fn();
      const status = vi.fn(async () => ({ disabled: false, state: 'waiting' }));
      const readStatus = vm.runInNewContext(`(${getter![1]})`, {
        tabAccessReady: Promise.resolve(),
        retiredCopilotCustodyBlocked: false,
        nativeBootstrap: { attempt, status },
      });

      await readStatus();
      await readStatus();

      expect(status).toHaveBeenCalledTimes(2);
      expect(attempt).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
  test.each(['apply', 'disconnect', 'manual'])(
    'preserves native controller custody with the product transport: %s',
    async outcome => {
      const repoRoot = createFixture();
      try {
        const prepared = prepareBrowserExtension({ repoRoot });
        const source = fs.readFileSync(
          path.join(prepared.outputDir, 'modules/native-bootstrap.js'),
          'utf8',
        );
        const background = fs.readFileSync(path.join(prepared.outputDir, 'background.js'), 'utf8');
        expect(background).toContain('requestBootstrap: requestLocalBootstrap');
        const createController = vm.runInNewContext(
          source.replace(/^import .*;$/gm, '').replace(/\bexport /g, '') +
            ';createNativeBootstrapController',
          {
            randomRelayBase64Url: () => 'nonce',
            parsePairingString: () => ({ relayUrl: 'fixture' }),
            ACCESS_MODE_ALL: 'all',
            crypto: {},
          },
        );
        const stored: Record<string, unknown> = {};
        let resolveBootstrap!: (value: unknown) => void;
        let requests = 0;
        let applied = 0;
        let pairing: { relayUrl: string } | undefined;
        const controller = createController({
          chromeApi: {
            storage: {
              local: {
                get: async () => ({ ...stored }),
                set: async (values: Record<string, unknown>) => Object.assign(stored, values),
                remove: async (keys: string[]) =>
                  keys.forEach(key => {
                    delete stored[key];
                  }),
              },
            },
          },
          getPairing: async () => pairing,
          applyPairing: async () => {
            applied += 1;
            return { ok: true };
          },
          requestBootstrap: () => {
            requests += 1;
            return new Promise(resolve => {
              resolveBootstrap = resolve;
            });
          },
        });
        const first = controller.attempt();
        const second = controller.attempt();
        while (!resolveBootstrap) await Promise.resolve();
        if (outcome === 'disconnect') await controller.disableSynchronously();
        if (outcome === 'manual') pairing = { relayUrl: 'manual' };
        resolveBootstrap({ v: 1, ok: true, nonce: 'nonce', pairingString: 'private' });
        await Promise.all([first, second]);
        expect(requests).toBe(1);
        expect(applied).toBe(outcome === 'apply' ? 1 : 0);
        if (outcome === 'disconnect') expect(stored.nativeBootstrapDisabled).toBe(true);
      } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    },
  );
  test('keeps the native 9.8 strict authentication JSON parser in the shipped baseline', () => {
    const source = fs.readFileSync(
      path.join(projectRoot, 'resources/browser-extension/openclaw/modules/strict-json.js'),
      'utf8',
    );
    const parse = vm.runInNewContext(
      source.replace('export function parseStrictJsonObject', 'function parseStrictJsonObject') +
        ';parseStrictJsonObject',
    );
    expect(parse('{"type":"challenge","nonce":"test"}')).toEqual({
      type: 'challenge',
      nonce: 'test',
    });
    expect(parse('{"nonce":"first","nonce":"second"}')).toBeNull();
    expect(parse('{"nested":{"key":1,"key":2}}')).toBeNull();
    expect(parse('[]')).toBeNull();
    expect(parse('not-json')).toBeNull();
  });
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
      const appearanceSettings = fs.readFileSync(
        path.join(second.outputDir, 'options.html'),
        'utf8',
      );
      expect(appearanceSettings).toContain('modules/appearance-settings.js');
      expect(appearanceSettings).toContain('appearance.css');
      expect(fs.existsSync(path.join(second.outputDir, 'modules/appearance.js'))).toBe(true);

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
      const openClawManifest = JSON.parse(
        fs.readFileSync(path.join(second.sourceDir, 'manifest.json'), 'utf8'),
      ) as { action: { default_popup?: string }; side_panel?: unknown };
      const openClawOptionsHtml = fs.readFileSync(
        path.join(second.sourceDir, 'options.html'),
        'utf8',
      );
      const optionsHtml = fs.readFileSync(path.join(second.outputDir, 'options.html'), 'utf8');
      const optionsJs = fs.readFileSync(path.join(second.outputDir, 'options.js'), 'utf8');

      expect(first.sourceDir).toBe(second.sourceDir);
      expect(path.basename(second.sourceDir)).toBe('openclaw');
      expect(path.basename(second.overlayDir)).toBe('conversation-overlay');
      expect(openClawManifest.action.default_popup).toBe('popup.html');
      expect(openClawManifest.side_panel).toBeUndefined();
      expect(openClawOptionsHtml).toContain('<h2>Diagnostics</h2>');
      expect(fs.existsSync(path.join(second.sourceDir, 'sidepanel.html'))).toBe(false);
      expect(fs.existsSync(path.join(second.overlayDir, 'sidepanel.html'))).toBe(true);
      expect(second.productName).toBe(projectProductName);
      expect(manifest).toMatchObject({
        name: projectProductName,
        version: '2.3.0',
        action: { default_title: projectProductName },
      });
      expect(manifest.description).toContain(projectProductName);
      expect(manifest.permissions).toEqual(
        expect.arrayContaining(['activeTab', 'nativeMessaging', 'scripting', 'sidePanel']),
      );
      expect(manifest.action).not.toHaveProperty('default_popup');
      expect(manifest.host_permissions).toBeUndefined();
      expect(manifest.optional_host_permissions).toEqual(['http://*/*', 'https://*/*']);
      expect(fs.readFileSync(path.join(second.outputDir, 'background.js'), 'utf8')).toContain(
        'openPanelOnActionClick: true',
      );
      expect(fs.readFileSync(path.join(second.outputDir, 'sidepanel.js'), 'utf8')).toContain(
        'chrome.runtime.openOptionsPage()',
      );
      expect(popup).toContain('chrome.runtime.openOptionsPage()');
      const relayAuth = fs.readFileSync(
        path.join(second.outputDir, 'modules/relay-auth-v2.js'),
        'utf8',
      );
      expect(relayAuth).toContain('openclaw-extension-relay.v2');
      expect(relayAuth).toContain('from "./strict-json.js"');
      expect(
        fs.readFileSync(path.join(second.outputDir, 'modules/strict-json.js'), 'utf8'),
      ).toContain('parseStrictJsonObject');
      expect(relayCore).toContain('authVersion');
      expect(fs.existsSync(path.join(second.outputDir, 'modules', 'relay-auth-v2.js'))).toBe(true);
      expect(fs.existsSync(path.join(second.outputDir, 'options.html'))).toBe(true);
      expect(optionsHtml).toContain('id="automaticConnection"');
      expect(optionsHtml).toContain('id="manualConnection"');
      expect(optionsHtml).toContain('id="tabAccess"');
      expect(optionsHtml).toContain('id="appearance"');
      expect(optionsHtml.match(/<section\b/g)).toHaveLength(4);
      expect(optionsHtml).not.toMatch(/openclaw|Diagnostics/i);
      expect(optionsHtml).toContain('icons/icon128.png');
      for (const size of [16, 32, 48, 128]) {
        expect(fs.readFileSync(path.join(second.outputDir, `icons/icon${size}.png`))).toEqual(
          fs.readFileSync(path.join(repoRoot, `resources/icons/png/${size}x${size}.png`)),
        );
      }
      expect(optionsHtml).toContain('id="useLocal"');
      expect(optionsJs).toContain('setNativeBootstrapEnabled');
      expect(optionsJs).toContain("status.state === 'connecting'");
      expect(optionsJs).toContain("pairingString.value = ''");
      expect(optionsJs).toContain("'paired'");
      expect(optionsJs).toContain('setInterval(() =>');
      expect(fs.existsSync(path.join(second.outputDir, 'sidepanel.html'))).toBe(true);
      expect(
        fs.existsSync(path.join(second.outputDir, 'modules', 'app-server-background.js')),
      ).toBe(true);
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
      const optionsI18n = fs.readFileSync(path.join(outputDir, 'modules/options-i18n.js'), 'utf8');
      expect(optionsI18n).toContain('In Acme, open Settings');
      expect(optionsHtml).toContain('Acme Browser Settings');
      expect(optionsHtml).toContain('automaticConnection');
      expect(optionsHtml + optionsI18n).not.toMatch(/openclaw/i);
      expect(popupHtml).toContain('Acme Browser');
      expect(popupJs).toContain('Waiting for local Acme');
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
        'files do not match the composed locked snapshots',
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

  test('rejects a modified OpenClaw baseline source file', () => {
    const repoRoot = createFixture();

    try {
      fs.appendFileSync(
        path.join(repoRoot, 'resources', 'browser-extension', 'openclaw', 'options.js'),
        '\n// unexpected mutation\n',
        'utf8',
      );

      expect(() => prepareBrowserExtension({ repoRoot })).toThrow(
        'Browser extension OpenClaw baseline checksum mismatch: options.js',
      );
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('accepts product-owned conversation overlay changes without a duplicate checksum edit', () => {
    const repoRoot = createFixture();
    const marker = '// product overlay change';

    try {
      fs.appendFileSync(
        path.join(
          repoRoot,
          'resources',
          'browser-extension',
          'conversation-overlay',
          'sidepanel.js',
        ),
        `\n${marker}\n`,
        'utf8',
      );

      const { outputDir } = prepareBrowserExtension({ repoRoot });
      expect(fs.readFileSync(path.join(outputDir, 'sidepanel.js'), 'utf8')).toContain(marker);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
