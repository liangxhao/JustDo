import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test, vi } from 'vitest';

const { syncLocalExtensions } =
  require('../../../scripts/openclaw/sync-openclaw-runtime-resources.cjs') as {
    syncLocalExtensions: (
      repoRoot: string,
      runtimeRoot: string,
      label: string,
      options: {
        installProductionDependencies: (
          extensionDir: string,
          installTarget: { targetId: string },
        ) => void;
      },
    ) => { copied: string[] };
  };
const { precompileOpenClawExtensions } =
  require('../../../scripts/openclaw/precompile-openclaw-extensions.cjs') as {
    precompileOpenClawExtensions: (
      runtimeRoot: string,
      options: { required: boolean },
    ) => Promise<{ compiled: number; errors: number }>;
  };

test('packages Smart Canvas as a deferred skill-only extension', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-canvas-packaging-'));
  const repoRoot = path.join(fixture, 'repo');
  const runtimeRoot = path.join(fixture, 'runtime');
  const source = path.join(repoRoot, 'plugins/extensions', 'smart-canvas');
  const target = path.join(runtimeRoot, 'dist', 'extensions', 'smart-canvas');
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    const pluginSource = path.resolve('plugins/extensions/smart-canvas');
    const installDependencies = vi.fn();
    fs.cpSync(pluginSource, source, {
      recursive: true,
      filter: filename =>
        path.basename(filename) !== 'node_modules' &&
        path.relative(pluginSource, filename).split(path.sep)[0] !== 'assets',
    });
    const legacyAsset = path.join(source, 'assets/libraries/retired-library.js');
    fs.mkdirSync(path.dirname(legacyAsset), { recursive: true });
    fs.writeFileSync(legacyAsset, 'retired source asset');
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.writeFileSync(
      path.join(runtimeRoot, 'runtime-build-info.json'),
      JSON.stringify({ target: 'win-x64' }),
    );
    expect(
      syncLocalExtensions(repoRoot, runtimeRoot, 'test', {
        installProductionDependencies: installDependencies,
      }).copied,
    ).toEqual(['smart-canvas']);
    expect(installDependencies).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(target, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(target, 'assets'))).toBe(false);
    fs.mkdirSync(path.join(target, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(target, 'assets/stale.js'), 'retired runtime asset');
    expect(
      syncLocalExtensions(repoRoot, runtimeRoot, 'test', {
        installProductionDependencies: installDependencies,
      }).copied,
    ).toEqual(['smart-canvas']);
    expect(installDependencies).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(target, 'assets'))).toBe(false);
    expect(fs.readFileSync(legacyAsset, 'utf8')).toBe('retired source asset');
    expect(await precompileOpenClawExtensions(runtimeRoot, { required: true })).toMatchObject({
      errors: 0,
    });
    const { openclaw } = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
    expect(openclaw.extensions).toEqual(['./index.js']);
    expect(openclaw.build.workerEntries).toBeUndefined();
    const manifest = JSON.parse(fs.readFileSync(path.join(target, 'openclaw.plugin.json'), 'utf8'));
    expect(manifest).toMatchObject({
      id: 'smart-canvas',
      name: 'Smart Canvas',
      enabledByDefault: true,
      skills: ['./skills'],
      activation: { onStartup: false },
    });
    expect(fs.readdirSync(path.join(target, 'skills'))).toEqual(['visualize']);
    expect(fs.statSync(path.join(target, 'skills/visualize/SKILL.md')).isFile()).toBe(true);
    expect(fs.readdirSync(path.join(target, 'skills/visualize/references')).sort()).toEqual([
      'delivery-examples.md',
      'hosted-html.md',
      'native-html.md',
    ]);
    const entry = path.join(target, 'index.js');
    const plugin = (await import(pathToFileURL(entry).href)).default;
    expect(plugin.id).toBe(manifest.id);
    expect(plugin.name).toBe(manifest.name);
    const on = vi.fn();
    const registerTool = vi.fn();
    const registerBoardWidgetContentKind = vi.fn();
    const registerHttpRoute = vi.fn();
    plugin.register({ on, registerTool, registerBoardWidgetContentKind, registerHttpRoute });
    expect(on).not.toHaveBeenCalled();
    expect(registerTool).not.toHaveBeenCalled();
    expect(registerBoardWidgetContentKind).not.toHaveBeenCalled();
    expect(registerHttpRoute).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(target, 'ui/widget-renderer.js'))).toBe(false);
  } finally {
    log.mockRestore();
    expect(path.dirname(fixture)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(fixture)).toMatch(/^smart-canvas-packaging-/);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}, 60_000);
