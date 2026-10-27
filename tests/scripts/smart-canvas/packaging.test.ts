import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Script } from 'node:vm';

import { expect, test, vi } from 'vitest';

import { uiContentKind } from '../../../plugins/extensions/smart-canvas/ui/content-kind';

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

test(
  'packages Smart Canvas and its single component resource without extra dependencies',
  async () => {
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
        compiled: 1,
        errors: 0,
      });
      expect(
        JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).openclaw.extensions,
      ).toEqual(['./index.js']);
      const manifest = JSON.parse(
        fs.readFileSync(path.join(target, 'openclaw.plugin.json'), 'utf8'),
      );
      expect(manifest).toMatchObject({
        id: 'smart-canvas',
        name: 'Smart Canvas',
        enabledByDefault: true,
        skills: ['./skills'],
      });
      expect(fs.readdirSync(path.join(target, 'skills'))).toEqual(['visualize']);
      expect(fs.statSync(path.join(target, 'skills/visualize/SKILL.md')).isFile()).toBe(true);
      expect(
        fs.statSync(path.join(target, 'skills/visualize/references/fixed-components.md')).isFile(),
      ).toBe(true);
      const plugin = (await import(pathToFileURL(path.join(target, 'index.js')).href)).default;
      expect(plugin.id).toBe(manifest.id);
      expect(plugin.name).toBe(manifest.name);
      const definitions: Array<typeof uiContentKind> = [];
      const on = vi.fn();
      const registerTool = vi.fn();
      const registerHttpRoute = vi.fn();
      plugin.register({
        on,
        registerTool,
        registerBoardWidgetContentKind: (definition: typeof uiContentKind) =>
          definitions.push(definition),
        registerHttpRoute,
      });
      expect(on).not.toHaveBeenCalled();
      expect(registerTool).not.toHaveBeenCalled();
      expect(registerHttpRoute).not.toHaveBeenCalled();
      expect(definitions.map(definition => definition.kind).sort()).toEqual([
        'interactive-answer',
      ]);
      const resources = definitions.flatMap(definition => definition.resources.paths);
      expect(resources).toEqual(['/__smart_canvas__/ui.js']);
      expect(
        fs.existsSync(path.join(target, 'skills/visualize/references/offline-libraries.md')),
      ).toBe(false);
      for (const definition of definitions) {
        for (const resourcePath of definition.resources.paths) {
          const resource = await definition.resources.readPublicResource(resourcePath);
          expect(resource?.contentType).toBe('text/javascript; charset=utf-8');
          expect(resource?.body.byteLength).toBeGreaterThan(0);
          expect(() => new Script(new TextDecoder().decode(resource?.body))).not.toThrow();
        }
        expect(await definition.resources.readPublicResource('/unregistered')).toBeUndefined();
      }
    } finally {
      log.mockRestore();
      expect(path.dirname(fixture)).toBe(path.resolve(os.tmpdir()));
      expect(path.basename(fixture)).toMatch(/^smart-canvas-packaging-/);
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  },
  60_000,
);
