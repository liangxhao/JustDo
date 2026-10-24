import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Script } from 'node:vm';

import { expect, test, vi } from 'vitest';

import { OFFLINE_LIBRARY_RESOURCES } from '../../../plugins/extensions/widget-kit/libraries/resources';
import { uiContentKind } from '../../../plugins/extensions/widget-kit/ui/content-kind';

const { syncLocalExtensions } =
  require('../../../scripts/openclaw/sync-openclaw-runtime-resources.cjs') as {
    syncLocalExtensions: (
      repoRoot: string,
      runtimeRoot: string,
      label: string,
    ) => { copied: string[] };
  };
const { precompileOpenClawExtensions } =
  require('../../../scripts/openclaw/precompile-openclaw-extensions.cjs') as {
    precompileOpenClawExtensions: (
      runtimeRoot: string,
      options: { required: boolean },
    ) => Promise<{ compiled: number; errors: number }>;
  };

test.each([
  { packageName: 'openclaw-interactive-ui', pluginId: 'interactive-ui', retired: true },
  { packageName: 'third-party', pluginId: 'interactive-ui', retired: false },
  { packageName: 'openclaw-interactive-ui', pluginId: 'other-plugin', retired: false },
])(
  'packages Widget Kit and retires only the former app-owned bundle ($packageName, $pluginId)',
  async ({ packageName, pluginId, retired }) => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'widget-kit-packaging-'));
    const repoRoot = path.join(fixture, 'repo');
    const runtimeRoot = path.join(fixture, 'runtime');
    const source = path.join(repoRoot, 'plugins/extensions', 'widget-kit');
    const target = path.join(runtimeRoot, 'dist', 'extensions', 'widget-kit');
    const previous = path.join(runtimeRoot, 'dist', 'extensions', 'interactive-ui');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      fs.cpSync(path.resolve('plugins/extensions/widget-kit'), source, { recursive: true });
      fs.mkdirSync(previous, { recursive: true });
      fs.writeFileSync(path.join(previous, 'package.json'), JSON.stringify({ name: packageName }));
      fs.writeFileSync(
        path.join(previous, 'openclaw.plugin.json'),
        JSON.stringify({ id: pluginId }),
      );

      expect(syncLocalExtensions(repoRoot, runtimeRoot, 'test').copied).toEqual(['widget-kit']);
      expect(fs.existsSync(previous)).toBe(!retired);
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
        id: 'widget-kit',
        name: 'Widget Kit',
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
      plugin.register({
        registerBoardWidgetContentKind: (definition: typeof uiContentKind) =>
          definitions.push(definition),
      });
      expect(definitions.map(definition => definition.kind).sort()).toEqual([
        'interactive-answer',
        'offline-html',
      ]);
      const resources = definitions.flatMap(definition => definition.resources.paths);
      expect(resources).toEqual([
        '/__widget_kit__/ui.js',
        ...OFFLINE_LIBRARY_RESOURCES.map(resource => resource.path),
      ]);
      expect(
        fs.statSync(path.join(target, 'skills/visualize/references/offline-libraries.md')).isFile(),
      ).toBe(true);
      const prepared = JSON.parse(
        fs.readFileSync(path.join(source, 'assets/integrity.json'), 'utf8'),
      );
      for (const file of ['integrity.json', ...Object.keys(prepared.files)]) {
        expect(fs.readFileSync(path.join(target, 'assets', file))).toEqual(
          fs.readFileSync(path.join(source, 'assets', file)),
        );
      }
      expect(fs.statSync(path.join(target, 'index.js')).size).toBeLessThan(200_000);
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
      expect(path.basename(fixture)).toMatch(/^widget-kit-packaging-/);
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  },
  60_000,
);
