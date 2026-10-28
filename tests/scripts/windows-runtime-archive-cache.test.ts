import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

type Source = { dir: string; prefix: string; exclude?: string[] };
type BuildContext = {
  outputTar: string;
  outputMetadata: string;
  prepared: unknown;
  readEntries: () => Array<{ path: string }>;
};
const { prepareCachedRuntimeArchive } = require('../../scripts/packaging/windows-runtime-archive-cache.cjs') as {
  prepareCachedRuntimeArchive: (
    sources: Source[], outputDir: string, build: (context: BuildContext) => Promise<void>,
    options?: Record<string, unknown>,
  ) => Promise<{ reused: boolean }>;
};
const { packMultipleSources, compressTarArchive } = require('../../scripts/openclaw/pack-openclaw-tar.cjs');
const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-archive-cache-'));
  roots.push(root);
  const source = path.join(root, '资源 with spaces');
  const output = path.join(root, 'output');
  fs.mkdirSync(path.join(source, 'empty'), { recursive: true });
  const modulePath = path.join(source, 'module.js');
  fs.writeFileSync(modulePath, 'first bytes');
  fs.writeFileSync(path.join(source, '.env'), 'excluded');
  const sources: Source[] = [{ dir: source, prefix: 'runtime' }];
  const build = vi.fn(async ({ outputTar, outputMetadata, prepared, readEntries }: BuildContext) => {
    packMultipleSources(sources, outputTar, prepared);
    const entries = readEntries();
    fs.writeFileSync(outputMetadata, JSON.stringify({ entries: entries.map(entry => entry.path) }));
  });
  const compress = vi.fn((input: string, archive: string) => compressTarArchive(input, archive, { workers: 0 }));
  const options = { log: vi.fn(), compress };
  const run = (overrides: Record<string, unknown> = {}) => prepareCachedRuntimeArchive(sources, output, build, { ...options, ...overrides });
  const snapshot = () => fs.readdirSync(output).sort().map(name => [name, fs.readFileSync(path.join(output, name)).toString('base64')]);
  return { root, source, output, modulePath, sources, build, compress, run, snapshot };
}

test('reuses identical content despite refreshed timestamps and changes to excluded files', async () => {
  const f = fixture();
  expect(await f.run()).toEqual({ reused: false });
  const original = f.snapshot();
  fs.utimesSync(f.modulePath, new Date(), new Date(Date.now() + 10_000));
  fs.writeFileSync(path.join(f.source, '.env'), 'changed excluded input');

  expect(await f.run()).toEqual({ reused: true });
  expect(f.build).toHaveBeenCalledTimes(1);
  expect(f.compress).toHaveBeenCalledTimes(1);
  expect(f.snapshot()).toEqual(original);
});

test('detects same-length content changes even when timestamps are preserved', async () => {
  const f = fixture();
  await f.run();
  const stat = fs.statSync(f.modulePath);
  fs.writeFileSync(f.modulePath, 'other bytes');
  fs.utimesSync(f.modulePath, stat.atime, stat.mtime);

  expect(await f.run()).toEqual({ reused: false });
  expect(f.compress).toHaveBeenCalledTimes(2);
});

test.each(['added file', 'missing file', 'empty directory', 'exclusion rule'])(
  'invalidates the inventory for a changed %s', async change => {
    const f = fixture();
    await f.run();
    if (change === 'added file') fs.writeFileSync(path.join(f.source, 'added.js'), 'added');
    if (change === 'missing file') fs.rmSync(f.modulePath);
    if (change === 'empty directory') fs.mkdirSync(path.join(f.source, 'another empty'));
    if (change === 'exclusion rule') f.sources[0].exclude = ['module.js'];

    expect(await f.run()).toEqual({ reused: false });
    expect(f.build).toHaveBeenCalledTimes(2);
  },
);

test('binds packaging recipe inputs and explicit compression requests', async () => {
  const f = fixture();
  const recipe = path.join(f.root, 'recipe.cjs');
  fs.writeFileSync(recipe, 'first recipe');
  await f.run({ recipeFiles: [recipe] });
  fs.writeFileSync(recipe, 'other recipe');
  expect(await f.run({ recipeFiles: [recipe] })).toEqual({ reused: false });
  vi.stubEnv('RUNTIME_COMPRESSION_WORKERS', '0');
  expect(await f.run({ recipeFiles: [recipe] })).toEqual({ reused: false });
  vi.stubEnv('RUNTIME_COMPRESSION_WORKERS', 'invalid');
  await expect(f.run({ recipeFiles: [recipe] })).rejects.toThrow(/RUNTIME_COMPRESSION_WORKERS/);
});

test.each(['win-resources.tar.zst', 'win-resources-metadata.json', 'win-resources-proof.json'])(
  'rebuilds when the cached %s is corrupted', async name => {
    const f = fixture();
    await f.run();
    fs.writeFileSync(path.join(f.output, name), 'corrupted');

    expect(await f.run()).toEqual({ reused: false });
    expect(f.build).toHaveBeenCalledTimes(2);
  },
);

test.each(['validation', 'compression', 'publication'])(
  'preserves the last complete generation after a %s failure', async failure => {
    const f = fixture();
    await f.run();
    const original = f.snapshot();
    fs.writeFileSync(f.modulePath, 'changed source');
    const options: Record<string, unknown> = {};
    if (failure === 'validation') f.build.mockImplementationOnce(async () => { throw new Error('validation failed'); });
    if (failure === 'compression') options.compress = async () => { throw new Error('compression failed'); };
    if (failure === 'publication') options.rename = (from: string, to: string) => {
      if (path.dirname(to) === f.output && path.basename(to) === 'win-resources-metadata.json') throw new Error('publication failed');
      fs.renameSync(from, to);
    };

    await expect(f.run(options)).rejects.toThrow(`${failure} failed`);
    expect(f.snapshot()).toEqual(original);
    expect(await f.run()).toEqual({ reused: false });
    expect(await f.run()).toEqual({ reused: true });
  },
);

test('rejects archive bytes that changed after the source fingerprint was collected', async () => {
  const f = fixture();
  f.build.mockImplementationOnce(async ({ outputTar, prepared, readEntries }: BuildContext) => {
    fs.writeFileSync(f.modulePath, 'other bytes');
    packMultipleSources(f.sources, outputTar, prepared);
    readEntries();
  });

  await expect(f.run()).rejects.toThrow(/archive content differs/);
  expect(fs.readdirSync(f.output)).toEqual([]);
});

test('rejects unsupported archive members that tar skips before its entry callback', async () => {
  const f = fixture();
  f.build.mockImplementationOnce(async ({ outputTar, prepared, readEntries }: BuildContext) => {
    packMultipleSources(f.sources, outputTar, prepared);
    const header = Buffer.alloc(512);
    new (require('tar').Header)({
      path: 'runtime/unexpected-sparse', type: 'SparseFile', mode: 0o644, size: 0,
    }).encode(header);
    fs.writeFileSync(outputTar, Buffer.concat([header, fs.readFileSync(outputTar)]));
    readEntries();
  });

  await expect(f.run()).rejects.toThrow(/unsupported entry.*unexpected-sparse/);
  expect(f.compress).not.toHaveBeenCalled();
  expect(fs.readdirSync(f.output)).toEqual([]);
});

test('requires byte verification before publishing reusable evidence', async () => {
  const f = fixture();
  f.build.mockImplementationOnce(async ({ outputTar, prepared }: BuildContext) => {
    packMultipleSources(f.sources, outputTar, prepared);
  });

  await expect(f.run()).rejects.toThrow(/source verification was not completed/);
  expect(fs.readdirSync(f.output)).toEqual([]);
});

test('verifies chunk-spanning files and PAX Unicode paths without buffering the full tar', async () => {
  const f = fixture();
  const contents = Buffer.alloc(17 * 1024 * 1024, 0x11);
  contents.fill(0x22, 16 * 1024 * 1024);
  fs.writeFileSync(path.join(f.source, `${'目录'.repeat(35)}.js`), contents);

  expect(await f.run()).toEqual({ reused: false });
  expect(await f.run()).toEqual({ reused: true });
  expect(f.compress).toHaveBeenCalledTimes(1);
});

test('follows aliases while binding their topology and rejecting cycles', async () => {
  const f = fixture();
  const target = path.join(f.source, 'original');
  const alias = path.join(f.source, 'alias');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'module.js'), 'alias bytes');
  fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await f.run();
  fs.rmSync(alias);
  fs.mkdirSync(alias);
  fs.writeFileSync(path.join(alias, 'module.js'), 'alias bytes');
  expect(await f.run()).toEqual({ reused: false });
  fs.symlinkSync(f.source, path.join(f.source, 'cycle'), process.platform === 'win32' ? 'junction' : 'dir');
  await expect(f.run()).rejects.toThrow(/directory cycle/);
});
