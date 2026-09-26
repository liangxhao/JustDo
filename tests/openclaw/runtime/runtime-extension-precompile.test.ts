import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, test, vi } from 'vitest';

const { syncOpenClawRuntimeResources } = require('../../../scripts/openclaw/sync-openclaw-runtime-resources.cjs') as {
  syncOpenClawRuntimeResources: (runtimeRoot: string, options: { repoRoot: string }) => void;
};
const { precompileOpenClawExtensions } = require('../../../scripts/openclaw/precompile-openclaw-extensions.cjs') as {
  precompileOpenClawExtensions: (runtimeRoot: string, options: { required: boolean }) => Promise<{
    compiled: number; skipped: number; errors: number;
  }>;
};

const roots: string[] = [];

function createFixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-extension-precompile-'));
  roots.push(repoRoot);
  const runtimeRoot = path.join(repoRoot, 'runtime');
  const sourceDir = path.join(repoRoot, 'openclaw-extensions', 'runtime-services');
  const outputDir = path.join(runtimeRoot, 'dist', 'extensions', 'runtime-services');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({ openclaw: { version: 'v2026.9.6' } }),
  );
  for (const relative of ['reference/templates', 'channels', 'gateway']) {
    fs.mkdirSync(path.join(repoRoot, 'resources', 'docs', relative), { recursive: true });
  }
  fs.writeFileSync(path.join(repoRoot, 'resources/docs/gateway/config-channels.md'), 'fixture');
  fs.writeFileSync(path.join(repoRoot, 'resources/openclaw-extension-prune.json'), JSON.stringify({
    version: 1, openclawVersion: '2026.9.6', keep: [], remove: [],
  }));
  fs.cpSync(path.join(process.cwd(), 'openclaw-extensions/runtime-services'), sourceDir, { recursive: true });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  return { repoRoot, runtimeRoot, sourceDir, outputDir };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('local extension packaging', () => {
  test.each([
    ['setup-api.ts', 'setup-api.js'],
    ['setup-api.mts', 'setup-api.mjs'],
    ['setup-api.cts', 'setup-api.cjs'],
    ['dist/setup-api.ts', 'dist/setup-api.js'],
    ['dist/setup-api.mts', 'dist/setup-api.mjs'],
    ['dist/setup-api.cts', 'dist/setup-api.cjs'],
  ])('emits an executable setup module for %s', async (source, output) => {
    const { runtimeRoot, outputDir } = createFixture();
    fs.mkdirSync(path.dirname(path.join(outputDir, source)), { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'package.json'), JSON.stringify({ type: 'module' }));
    fs.writeFileSync(path.join(outputDir, source), 'export const enabled: boolean = true;');

    await precompileOpenClawExtensions(runtimeRoot, { required: true });

    const setup = await import(pathToFileURL(path.join(outputDir, output)).href);
    expect(setup.enabled).toBe(true);
    expect(fs.existsSync(path.join(outputDir, source))).toBe(false);
  });

  test('compiles setup hooks independently of an already compiled main entry', async () => {
    const { runtimeRoot, outputDir } = createFixture();
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'package.json'), JSON.stringify({
      type: 'module', openclaw: { extensions: ['./index.js'] },
    }));
    fs.writeFileSync(path.join(outputDir, 'index.js'), 'export default {};');
    fs.writeFileSync(path.join(outputDir, 'setup-helper.ts'), 'export const reason: string = "ACP runtime configured";');
    fs.writeFileSync(path.join(outputDir, 'setup-api.ts'),
      'import { reason } from "./setup-helper.ts"; export const probe = (enabled: boolean) => enabled ? reason : null;');

    const result = await precompileOpenClawExtensions(runtimeRoot, { required: true });

    expect(result).toMatchObject({ compiled: 1, errors: 0 });
    expect(fs.existsSync(path.join(outputDir, 'setup-api.ts'))).toBe(false);
    const setup = await import(pathToFileURL(path.join(outputDir, 'setup-api.js')).href);
    expect(setup.probe(true)).toBe('ACP runtime configured');
    expect(setup.probe(false)).toBeNull();
    expect(fs.readFileSync(path.join(outputDir, 'index.js'), 'utf8')).toBe('export default {};');
    expect(await precompileOpenClawExtensions(runtimeRoot, { required: true })).toMatchObject({ compiled: 0, skipped: 1 });
  });

  test('retains a failed setup source and rejects required packaging', async () => {
    const { runtimeRoot, outputDir } = createFixture();
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'setup-api.ts'), 'export const broken: = ;');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(precompileOpenClawExtensions(runtimeRoot, { required: true })).rejects.toThrow('Failed to compile 1 extension');

    expect(fs.existsSync(path.join(outputDir, 'setup-api.ts'))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'setup-api.js'))).toBe(false);
  });

  test('recompiles the current bridge after packaging resynchronizes its source', async () => {
    const { repoRoot, runtimeRoot, sourceDir, outputDir } = createFixture();
    fs.writeFileSync(path.join(sourceDir, 'setup-api.ts'), 'export const revision: number = 1;');
    syncOpenClawRuntimeResources(runtimeRoot, { repoRoot });
    await precompileOpenClawExtensions(runtimeRoot, { required: true });
    const firstBuild = fs.readFileSync(path.join(outputDir, 'index.js'), 'utf8');
    fs.appendFileSync(path.join(sourceDir, 'index.ts'), '\nexport const testBuildRevision = "second";\n');
    fs.writeFileSync(path.join(sourceDir, 'setup-api.ts'), 'export const revision: number = 2;');

    // beforePack repeats resource sync after the runtime pipeline already compiled the plugin.
    syncOpenClawRuntimeResources(runtimeRoot, { repoRoot });
    const result = await precompileOpenClawExtensions(runtimeRoot, { required: true });

    expect(result).toMatchObject({ compiled: 1, errors: 0 });
    expect(JSON.parse(fs.readFileSync(path.join(outputDir, 'package.json'), 'utf8')).openclaw.extensions).toEqual(['./index.js']);
    expect(fs.existsSync(path.join(outputDir, 'index.ts'))).toBe(false);
    const secondBuild = fs.readFileSync(path.join(outputDir, 'index.js'), 'utf8');
    expect(secondBuild).not.toBe(firstBuild);
    expect(secondBuild).toContain('testBuildRevision');
    expect(secondBuild).toContain('openclaw/plugin-sdk/session-store-runtime');
    expect(fs.readFileSync(path.join(outputDir, 'setup-api.js'), 'utf8')).toContain('revision = 2');
    expect(fs.existsSync(path.join(outputDir, 'setup-api.ts'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(outputDir, 'openclaw.plugin.json'), 'utf8')).activation.onStartup).toBe(true);
  });

  test('fails packaging on compilation errors while retaining the source entry', async () => {
    const { repoRoot, runtimeRoot, sourceDir, outputDir } = createFixture();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fs.writeFileSync(path.join(sourceDir, 'index.ts'), 'export default { broken: ;');
    syncOpenClawRuntimeResources(runtimeRoot, { repoRoot });

    await expect(precompileOpenClawExtensions(runtimeRoot, { required: true })).rejects.toThrow('Failed to compile 1 extension');

    expect(fs.existsSync(path.join(outputDir, 'index.ts'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(outputDir, 'package.json'), 'utf8')).openclaw.extensions).toEqual(['./index.ts']);
  });
});
