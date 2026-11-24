import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { list } from 'tar';
import { expect, it, vi } from 'vitest';

const { listBundledExtensionAssets } =
  require('../../scripts/plugins/bundled-extension-assets.cjs') as {
    listBundledExtensionAssets(repoRoot: string): Array<{ runtimeDirectory: string }>;
  };
const { packMultipleSources, packSingleSource } =
  require('../../scripts/packaging/pack-runtime-resources.cjs') as {
    packMultipleSources(
      sources: Array<{ dir: string; prefix: string; preserve: string[] }>,
      file: string,
    ): void;
    packSingleSource(source: string, file: string, prefix: string, preserve: string[]): void;
  };

it.each(['combined', 'single'])(
  'keeps declared assets through %s runtime archive pruning',
  mode => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-assets-tar-'));
    const runtime = path.join(directory, 'runtime');
    const plugin = path.join(directory, 'plugins/extensions/editor-fixture');
    const assetDirectory = 'dist/extensions/editor-fixture/web';
    const assets = [
      'LICENSE',
      'licenses/sdk/LICENSE',
      'public/editor/README.md',
      'public/editor/js/source.map',
      'public/editor/test/local.js',
    ];
    const protectedFiles = assets.map(file => `${assetDirectory}/${file}`);
    const ordinaryFiles = [
      'dist/extensions/editor-fixture/skills/editor/SKILL.md',
      'node_modules/example/README.md',
    ];
    const omittedFiles = [
      'dist/extensions/editor-fixture/web-old/app.js.map',
      'node_modules/fixture/examples/demo.js',
    ];
    try {
      fs.mkdirSync(plugin, { recursive: true });
      fs.writeFileSync(path.join(plugin, 'prepare.cjs'), 'exports.verifyBundledAssets = () => {};');
      fs.writeFileSync(
        path.join(plugin, 'package.json'),
        JSON.stringify({
          bundledAssets: { directory: 'web', prepare: 'prepare.cjs', inputs: [] },
        }),
      );
      for (const file of [...protectedFiles, ...ordinaryFiles, ...omittedFiles]) {
        const destination = path.join(runtime, file);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, 'fixture');
      }
      const archive = path.join(directory, 'runtime.tar');
      const preserve = listBundledExtensionAssets(directory).map(bundle => bundle.runtimeDirectory);
      if (mode === 'combined')
        packMultipleSources([{ dir: runtime, prefix: 'cfmind', preserve }], archive);
      else packSingleSource(runtime, archive, 'cfmind', preserve);
      const entries: string[] = [];
      list({ file: archive, sync: true, onReadEntry: entry => entries.push(entry.path) });
      for (const file of [...protectedFiles, ...ordinaryFiles])
        expect(entries).toContain('cfmind/' + file);
      for (const file of omittedFiles) expect(entries).not.toContain('cfmind/' + file);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

it('copies enrolled runtime assets separately from macOS and Linux generic filters', () => {
  const installer = require('../../scripts/packaging/windows-installer-script.cjs');
  const configureInstaller = vi
    .spyOn(installer, 'configureWindowsInstallerScript')
    .mockImplementation(() => {});
  try {
    const config = require('../../electron-builder.config.cjs');
    const bundles = listBundledExtensionAssets(process.cwd());
    for (const target of ['mac', 'linux']) {
      const runtime = config[target].extraResources.find(
        (resource: { to?: string }) => resource.to === 'cfmind',
      );
      const assetCopies = config[target].extraResources.filter((resource: { to?: string }) =>
        resource.to?.startsWith('cfmind/'),
      );
      expect(assetCopies).toEqual(
        bundles.map(({ runtimeDirectory }) => ({
          from: `${runtime.from}/${runtimeDirectory}`,
          to: `${runtime.to}/${runtimeDirectory}`,
          filter: ['**/*'],
        })),
      );
      for (const { runtimeDirectory } of bundles)
        expect(runtime.filter).toContain(`!${runtimeDirectory}/**`);
      expect(runtime.filter).toContain('!**/*.map');
    }
  } finally {
    configureInstaller.mockRestore();
  }
});
