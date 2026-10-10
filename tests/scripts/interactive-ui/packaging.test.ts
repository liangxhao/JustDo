import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Script } from 'node:vm';

import { expect, test, vi } from 'vitest';

import { scenarioContentKind } from '../../../openclaw-extensions/interactive-ui/scenario/content-kind';

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

test('packages both optional kinds, on-demand skills and separate renderers with native build tooling', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'interactive-ui-packaging-'));
  const repoRoot = path.join(fixture, 'repo');
  const runtimeRoot = path.join(fixture, 'runtime');
  const source = path.join(repoRoot, 'openclaw-extensions', 'interactive-ui');
  const target = path.join(runtimeRoot, 'dist', 'extensions', 'interactive-ui');
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    fs.cpSync(path.resolve('openclaw-extensions/interactive-ui'), source, { recursive: true });

    expect(syncLocalExtensions(repoRoot, runtimeRoot, 'test').copied).toEqual(['interactive-ui']);
    expect(await precompileOpenClawExtensions(runtimeRoot, { required: true })).toMatchObject({
      compiled: 1,
      errors: 0,
    });
    expect(
      JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).openclaw.extensions,
    ).toEqual(['./index.js']);
    const manifest = JSON.parse(fs.readFileSync(path.join(target, 'openclaw.plugin.json'), 'utf8'));
    expect(manifest).toMatchObject({ enabledByDefault: false, skills: ['./skills'] });
    expect(fs.statSync(path.join(target, 'skills/scenario-explorer/SKILL.md')).isFile()).toBe(true);
    expect(fs.statSync(path.join(target, 'skills/interactive-answer/SKILL.md')).isFile()).toBe(
      true,
    );
    const plugin = (await import(pathToFileURL(path.join(target, 'index.js')).href)).default;
    const definitions: Array<typeof scenarioContentKind> = [];
    plugin.register({
      registerBoardWidgetContentKind: (definition: typeof scenarioContentKind) =>
        definitions.push(definition),
    });
    expect(definitions.map(definition => definition.kind).sort()).toEqual([
      'interactive-answer',
      'scenario-explorer',
    ]);
    const resources = definitions.flatMap(definition => definition.resources.paths);
    expect(new Set(resources).size).toBe(resources.length);
    expect(resources).toContain('/__interactive_ui__/ui.js');
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
    expect(path.basename(fixture)).toMatch(/^interactive-ui-packaging-/);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
