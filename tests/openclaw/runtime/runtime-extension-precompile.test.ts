import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

const { syncOpenClawRuntimeResources } = require('../../../scripts/sync-openclaw-runtime-resources.cjs') as {
  syncOpenClawRuntimeResources: (runtimeRoot: string, options: { repoRoot: string }) => void;
};
const { precompileOpenClawExtensions } = require('../../../scripts/precompile-openclaw-extensions.cjs') as {
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
    JSON.stringify({ openclaw: { version: 'v2026.9.2' } }),
  );
  for (const relative of ['reference/templates', 'channels', 'gateway']) {
    fs.mkdirSync(path.join(repoRoot, 'resources', 'docs', relative), { recursive: true });
  }
  fs.writeFileSync(path.join(repoRoot, 'resources/docs/gateway/config-channels.md'), 'fixture');
  fs.writeFileSync(path.join(repoRoot, 'resources/openclaw-extension-prune.json'), JSON.stringify({
    version: 1, openclawVersion: '2026.9.2', keep: [], remove: [],
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
  test('recompiles the current bridge after packaging resynchronizes its source', async () => {
    const { repoRoot, runtimeRoot, sourceDir, outputDir } = createFixture();
    syncOpenClawRuntimeResources(runtimeRoot, { repoRoot });
    await precompileOpenClawExtensions(runtimeRoot, { required: true });
    const firstBuild = fs.readFileSync(path.join(outputDir, 'index.js'), 'utf8');
    fs.appendFileSync(path.join(sourceDir, 'index.ts'), '\nexport const testBuildRevision = "second";\n');

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
