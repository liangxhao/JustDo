import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createZstdDecompress } from 'node:zlib';

import { extract as extractTar, list as listTar } from 'tar';
import { expect, test, vi } from 'vitest';

const {
  PACKAGED_RUNTIME_EXCLUDES,
  resolveCompressionWorkers,
  compressTarArchive,
  packMultipleSources,
  verifyRuntimeKnowledgeEntries,
  verifyRuntimeWorkerEntries,
  verifyLegalMetadataEntries,
} = require('../../scripts/openclaw/pack-openclaw-tar.cjs') as {
  PACKAGED_RUNTIME_EXCLUDES: string[];
  resolveCompressionWorkers: (sourceBytes: number, options: Record<string, unknown>) => number;
  compressTarArchive: (sourceTar: string, outputArchive: string, options?: Record<string, unknown>) => Promise<{ workers: number }>;
  verifyRuntimeKnowledgeEntries: (entries: Set<string>, prefix: string, root: string) => number;
  verifyRuntimeWorkerEntries: (entries: Set<string>, prefix: string, root: string) => number;
  verifyLegalMetadataEntries: (entries: Set<string>, prefix: string, root: string) => number;
  packMultipleSources: (
    sources: Array<{
      dir: string;
      prefix: string;
      exclude?: string[];
      preservePythonLicenses?: boolean;
    }>,
    outputTar: string,
  ) => void;
};

test('omits the standalone deployment bundle while retaining every local Worker and knowledge file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-worker-packaging-'));
  const runtime = path.join(root, 'runtime');
  const workers = [
    'dist/infra/sqlite-store.worker.js',
    'dist/media/image-processor.worker.js',
    'dist/agents/code-mode-node.worker.js',
    'dist/worker-artifacts-cache/local.worker.js',
    'dist/extensions/fixture/worker-artifacts/local.worker.js',
  ];
  try {
    for (const file of [
      ...workers,
      'gateway.asar',
      'gateway-bundle.mjs',
      'dist/worker-artifacts/bundle.tar.gz',
      'docs/worker-artifacts/README.md',
      'skills/example/SKILL.md',
      'LICENSE',
    ]) {
      const target = path.join(runtime, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file);
    }
    const archive = path.join(root, 'runtime.tar');
    packMultipleSources([{ dir: runtime, prefix: 'cfmind', exclude: PACKAGED_RUNTIME_EXCLUDES }], archive);
    const entries = new Set<string>();
    listTar({ file: archive, sync: true, onReadEntry: entry => entries.add(entry.path.replaceAll('\\', '/')) });
    expect([...entries].some(entry => /^cfmind\/dist\/worker-artifacts(?:\/|$)/.test(entry))).toBe(false);
    expect(entries.has('cfmind/gateway.asar')).toBe(false);
    for (const file of [...workers, 'gateway-bundle.mjs', 'docs/worker-artifacts/README.md', 'skills/example/SKILL.md', 'LICENSE'])
      expect(entries.has(`cfmind/${file}`), file).toBe(true);
    expect(verifyRuntimeWorkerEntries(entries, 'cfmind/', runtime)).toBe(workers.length);
    for (const forbidden of ['cfmind/dist/worker-artifacts/', 'cfmind/dist/worker-artifacts/bundle.tar.gz']) {
      expect(() => verifyRuntimeWorkerEntries(new Set([...entries, forbidden]), 'cfmind/', runtime)).toThrow(/deployment artifacts/);
    }
    entries.delete(`cfmind/${workers[0]}`);
    expect(() => verifyRuntimeWorkerEntries(entries, 'cfmind/', runtime)).toThrow(/sqlite-store\.worker\.js/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('omits only optional Control UI encodings while preserving identity assets and source files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'control-ui-encodings-'));
  const source = path.join(root, 'source');
  const omitted = [
    'dist/control-ui/assets/app.js.br',
    'dist/control-ui/assets/app.js.gz',
    'dist/control-ui/assets/nested/app.css.br',
    'dist/control-ui/assets/nested/app.css.gz',
  ];
  const retained = [
    'dist/control-ui/index.html',
    'dist/control-ui/asset-manifest.json',
    'dist/control-ui/assets/app.js',
    'dist/control-ui/assets/nested/app.css',
    'dist/control-ui/assets/image.png.gz',
    'dist/extensions/fixture/assets/app.js.gz',
    'docs/control-ui/assets/app.js.gz',
    'node-runtime/node_modules/npm/assets/app.js.br',
    'LICENSE',
  ];
  try {
    for (const relative of [...omitted, ...retained]) {
      const target = path.join(source, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, relative);
    }
    const archive = path.join(root, 'runtime.tar');
    packMultipleSources([{ dir: source, prefix: 'cfmind' }], archive);
    const entries = new Set<string>();
    listTar({ file: archive, sync: true, onReadEntry: entry => entries.add(entry.path) });
    for (const relative of retained) expect(entries.has(`cfmind/${relative}`), relative).toBe(true);
    for (const relative of omitted) {
      expect(entries.has(`cfmind/${relative}`), relative).toBe(false);
      expect(fs.readFileSync(path.join(source, relative), 'utf8')).toBe(relative);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('retains the complete prepared widget library resource set and legal notices', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'widget-library-archive-'));
  const runtime = path.join(root, 'runtime');
  const prefix = 'dist/extensions/widget-kit/assets';
  const files = [
    'integrity.json',
    'THIRD_PARTY_NOTICES.json',
    'libraries/three-0.186.1.js',
    'libraries/echarts-6.1.0.js',
    'libraries/katex-0.17.0.js',
    'libraries/mermaid-10.9.8.js',
    'libraries/d3-7.9.0.js',
    'libraries/matter-0.20.0.js',
    'licenses/mermaid-10.9.8/LICENSE',
    'licenses/echarts-6.1.0/NOTICE.bundle.txt',
  ];
  try {
    for (const file of files) {
      const target = path.join(runtime, prefix, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file);
    }
    const archive = path.join(root, 'runtime.tar');
    packMultipleSources(
      [{ dir: runtime, prefix: 'cfmind', exclude: PACKAGED_RUNTIME_EXCLUDES }],
      archive,
    );
    const entries = new Set<string>();
    listTar({
      file: archive,
      sync: true,
      onReadEntry: entry => entries.add(entry.path.replaceAll('\\', '/')),
    });
    for (const file of files) expect(entries.has(`cfmind/${prefix}/${file}`), file).toBe(true);
    expect(verifyLegalMetadataEntries(entries, 'cfmind/', runtime)).toBeGreaterThanOrEqual(2);
  } finally {
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root)).toMatch(/^widget-library-archive-/);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('retains legal metadata across all packages, including filtered development directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-archive-'));
  const legalFiles = [
    'LICENSE',
    'node_modules/openai/LICENSE',
    'node_modules/other/COPYING.txt',
    'node_modules/other/NOTICE',
    'node_modules/other/tests/LICENSE-MIT',
    'node_modules/other/tests/licenses/MIT',
    'node_modules/other/tests/THIRD_PARTY_NOTICES/vendor.txt',
    'node_modules/other/tests/third-party-licenses/vendor.txt',
    'dist/extensions/any/node_modules/fixture/THIRD_PARTY_NOTICES.txt',
  ];
  try {
    const source = path.join(root, 'source');
    for (const file of [...legalFiles, 'node_modules/other/tests/runtime.js', 'docs/.env']) {
      const target = path.join(source, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'fixture');
    }
    const archive = path.join(root, 'resources.tar');
    packMultipleSources([{ dir: source, prefix: 'cfmind' }], archive);
    const entries = new Set<string>();
    listTar({
      file: archive,
      sync: true,
      onReadEntry: entry => entries.add(entry.path.replaceAll('\\', '/')),
    });
    for (const file of legalFiles) expect(entries.has(`cfmind/${file}`), file).toBe(true);
    expect(entries.has('cfmind/node_modules/other/tests/runtime.js')).toBe(false);
    expect(entries.has('cfmind/docs/.env')).toBe(false);
    expect(verifyLegalMetadataEntries(entries, 'cfmind/', source)).toBe(legalFiles.length);
    entries.delete('cfmind/node_modules/openai/LICENSE');
    expect(() => verifyLegalMetadataEntries(entries, 'cfmind/', source)).toThrow(/openai\/LICENSE/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.each([0, 2])('pre-compresses a runtime tar with %i native workers without changing its entries', async workers => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-zstd 中文 空格-'));
  const runtimeRoot = path.join(tempRoot, 'runtime');
  const tarPath = path.join(tempRoot, 'runtime.tar');
  const archivePath = path.join(tempRoot, 'runtime.tar.zst');

  try {
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, 'gateway-bundle.mjs'), 'bundle'.repeat(1000), 'utf8');
    packMultipleSources([{ dir: runtimeRoot, prefix: 'cfmind' }], tarPath);

    const result = await compressTarArchive(tarPath, archivePath, { workers, cpuCount: 8, availableMemory: 8 * 1024 ** 3 });
    expect(result.workers).toBe(workers);

    const entries: string[] = [];
    await pipeline(
      fs.createReadStream(archivePath),
      createZstdDecompress(),
      listTar({
        onReadEntry: entry => entries.push(entry.path.replace(/\\/g, '/')),
      }),
    );
    expect(entries).toContain('cfmind/gateway-bundle.mjs');
    expect(fs.statSync(archivePath).size).toBeLessThan(fs.statSync(tarPath).size);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('bounds compression concurrency by CPUs, memory and buffered input size', () => {
  vi.stubEnv('RUNTIME_COMPRESSION_WORKERS', undefined);
  try {
    const enough = { cpuCount: 32, availableMemory: 16 * 1024 ** 3 };
    expect(resolveCompressionWorkers(900 * 1024 ** 2, enough)).toBe(4);
    expect(resolveCompressionWorkers(900 * 1024 ** 2, { ...enough, workers: 8 })).toBe(8);
    expect(resolveCompressionWorkers(900 * 1024 ** 2, { ...enough, cpuCount: 3 })).toBe(2);
    expect(resolveCompressionWorkers(900 * 1024 ** 2, { ...enough, cpuCount: 2 })).toBe(0);
    expect(resolveCompressionWorkers(900 * 1024 ** 2, { ...enough, availableMemory: 3 * 1024 ** 3 })).toBe(0);
    expect(resolveCompressionWorkers(2 * 1024 ** 3, enough)).toBe(0);
    expect(resolveCompressionWorkers(1024, enough)).toBe(0);
    expect(resolveCompressionWorkers(900 * 1024 ** 2, { ...enough, workers: '0' })).toBe(0);
  } finally {
    vi.unstubAllEnvs();
  }
});

test.each(['all', '-1', '9', '2.5', '4 extra'])('rejects invalid compression worker configuration %s', workers => {
  expect(() => resolveCompressionWorkers(1024, { workers })).toThrow(/RUNTIME_COMPRESSION_WORKERS/);
});

test('preserves the last complete archive and removes partial output on a compression failure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-compression-failure-'));
  const archive = path.join(root, 'resources.tar.zst');
  try {
    fs.writeFileSync(archive, 'last complete build');
    await expect(compressTarArchive(root, archive, { workers: 0 })).rejects.toThrow();
    expect(fs.readFileSync(archive, 'utf8')).toBe('last complete build');
    expect(fs.readdirSync(root)).toEqual(['resources.tar.zst']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('omits source-specific duplicate artifacts without removing runtime entries', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-runtime-tar-'));
  const runtimeRoot = path.join(tempRoot, 'runtime');
  const archivePath = path.join(tempRoot, 'runtime.tar');

  try {
    fs.mkdirSync(path.join(runtimeRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, 'gateway.asar'), 'duplicate', 'utf8');
    fs.writeFileSync(path.join(runtimeRoot, 'gateway-bundle.mjs'), 'bundle', 'utf8');
    fs.writeFileSync(path.join(runtimeRoot, 'dist', 'entry.js'), 'entry', 'utf8');

    packMultipleSources(
      [{ dir: runtimeRoot, prefix: 'cfmind', exclude: ['gateway.asar'] }],
      archivePath,
    );

    const entries: string[] = [];
    listTar({
      file: archivePath,
      sync: true,
      onReadEntry: entry => entries.push(entry.path.replace(/\\/g, '/')),
    });

    expect(entries).toContain('cfmind/gateway-bundle.mjs');
    expect(entries).toContain('cfmind/dist/entry.js');
    expect(entries).not.toContain('cfmind/gateway.asar');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('clusters duplicate dependency bytes while preserving independent files, paths and metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-archive-order-'));
  const runtime = path.join(root, 'source 中文 空格');
  const python = path.join(root, 'python');
  const output = path.join(root, 'output');
  const files = new Map([
    ['dist/extensions/fixture/node_modules/sdk/index.js', 'repeated dependency'.repeat(128)],
    ['node_modules/sdk/index.js', 'repeated dependency'.repeat(128)],
    ['node-runtime/node_modules/sdk/index.js', 'complete bundled Node file'],
    ['dist/alpha-ABC123.mjs', 'first compiled alpha'],
    ['dist/alpha-DEF456.mjs', 'second compiled alpha'],
    ['dist/beta-XYZ789.mjs', 'compiled beta'],
    ['gateway-bundle.mjs', 'gateway'],
    ['native/left.dll', 'shared source inode'],
  ]);
  try {
    for (const [relative, content] of files) {
      const target = path.join(runtime, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    fs.linkSync(path.join(runtime, 'native/left.dll'), path.join(runtime, 'native/right.dll'));
    files.set('native/right.dll', 'shared source inode');
    fs.mkdirSync(python);
    fs.writeFileSync(path.join(python, 'python.exe'), 'Python binary');
    fs.mkdirSync(path.join(runtime, 'empty'));
    const archive = path.join(root, 'resources.tar');
    packMultipleSources([{ dir: runtime, prefix: 'cfmind' }, { dir: python, prefix: 'python-win' }], archive);
    const entries: Array<{ path: string; type: string; mode: number | undefined }> = [];
    listTar({ file: archive, sync: true, onReadEntry: entry => entries.push({ path: entry.path, type: entry.type, mode: entry.mode }) });
    const fileEntries = entries.filter(entry => entry.type === 'File');
    const names = fileEntries.map(entry => entry.path);
    expect(Math.abs(names.indexOf('cfmind/dist/extensions/fixture/node_modules/sdk/index.js') - names.indexOf('cfmind/node_modules/sdk/index.js'))).toBe(1);
    expect(Math.abs(names.indexOf('cfmind/dist/alpha-ABC123.mjs') - names.indexOf('cfmind/dist/alpha-DEF456.mjs'))).toBe(1);
    expect(entries.some(entry => entry.type === 'Link' || entry.type === 'SymbolicLink')).toBe(false);
    expect(entries.some(entry => entry.path === 'cfmind/empty/' && entry.type === 'Directory')).toBe(true);
    expect(entries.every(entry => !path.posix.isAbsolute(entry.path) && !path.win32.isAbsolute(entry.path))).toBe(true);
    fs.mkdirSync(output);
    extractTar({ file: archive, cwd: output, sync: true });
    for (const [relative, content] of files) {
      const installed = path.join(output, 'cfmind', relative);
      expect(fs.readFileSync(installed, 'utf8'), relative).toBe(content);
      expect(fileEntries.find(entry => entry.path === `cfmind/${relative}`)?.mode).toBe(fs.statSync(path.join(runtime, relative)).mode & 0o7777);
    }
    expect(fs.readFileSync(path.join(output, 'python-win/python.exe'), 'utf8')).toBe('Python binary');
    expect(fs.statSync(path.join(output, 'cfmind/native/left.dll')).ino).not.toBe(fs.statSync(path.join(output, 'cfmind/native/right.dll')).ino);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('follows source directory aliases and rejects cyclic or escaping archive paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-archive-alias-'));
  const runtime = path.join(root, 'source');
  const alias = path.join(runtime, 'alias');
  try {
    fs.mkdirSync(path.join(runtime, 'original'), { recursive: true });
    fs.writeFileSync(path.join(runtime, 'original/module.js'), 'module bytes');
    fs.symlinkSync(path.join(runtime, 'original'), alias, process.platform === 'win32' ? 'junction' : 'dir');
    const archive = path.join(root, 'resources.tar');
    packMultipleSources([{ dir: runtime, prefix: 'cfmind' }], archive);
    const entries: string[] = [];
    listTar({ file: archive, sync: true, onReadEntry: entry => entries.push(entry.path) });
    expect(entries).toContain('cfmind/alias/module.js');
    expect(entries).toContain('cfmind/original/module.js');
    for (const prefix of ['../escape', '/absolute', 'C:/absolute', 'C:relative']) {
      expect(() => packMultipleSources([{ dir: runtime, prefix }], archive)).toThrow(/must be relative/);
    }
    fs.symlinkSync(runtime, path.join(runtime, 'cycle'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => packMultipleSources([{ dir: runtime, prefix: 'cfmind' }], archive)).toThrow(/directory cycle/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('maps the same source files into separate prefixes without absolute paths or hard links', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-archive-prefixes-'));
  const source = path.join(root, 'source 中文 空格');
  try {
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'module.js'), 'same source file');
    const archive = path.join(root, 'resources.tar');
    packMultipleSources([{ dir: source, prefix: 'first' }, { dir: source, prefix: 'second' }], archive);
    const entries: Array<{ path: string; type: string; linkpath?: string }> = [];
    listTar({ file: archive, sync: true, onReadEntry: entry => entries.push({ path: entry.path, type: entry.type, linkpath: entry.linkpath }) });
    expect(entries).toEqual([
      { path: 'first/module.js', type: 'File', linkpath: undefined },
      { path: 'second/module.js', type: 'File', linkpath: undefined },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('preserves Python runtime and distribution licenses', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-python-license-tar-'));
  const pythonRoot = path.join(tempRoot, 'python-win');
  const distInfoRoot = path.join(
    pythonRoot,
    'Lib',
    'bundled-site-packages',
    'requests-2.34.2.dist-info',
  );
  const archivePath = path.join(tempRoot, 'python.tar');

  try {
    fs.mkdirSync(path.join(distInfoRoot, 'licenses'), { recursive: true });
    fs.writeFileSync(path.join(distInfoRoot, 'licenses', 'LICENSE'), 'license', 'utf8');
    fs.writeFileSync(path.join(distInfoRoot, 'LICENSE.txt'), 'license', 'utf8');
    fs.writeFileSync(path.join(pythonRoot, 'LICENSE.txt'), 'runtime license', 'utf8');

    packMultipleSources(
      [{ dir: pythonRoot, prefix: 'python-win', preservePythonLicenses: true }],
      archivePath,
    );

    const entries: string[] = [];
    listTar({
      file: archivePath,
      sync: true,
      onReadEntry: entry => entries.push(entry.path.replace(/\\/g, '/')),
    });

    expect(entries).toContain(
      'python-win/Lib/bundled-site-packages/requests-2.34.2.dist-info/licenses/LICENSE',
    );
    expect(entries).toContain(
      'python-win/Lib/bundled-site-packages/requests-2.34.2.dist-info/LICENSE.txt',
    );
    expect(entries).toContain('python-win/LICENSE.txt');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test.each(['acpx', 'mxc'])(
  'preserves %s legal metadata and agent-readable Markdown',
  extensionId => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-extension-license-tar-'));
    const runtimeRoot = path.join(tempRoot, 'runtime');
    const extensionRoot = path.join(runtimeRoot, 'dist', 'extensions', extensionId);
    const dependencyRoot = path.join(extensionRoot, 'node_modules', 'fixture');
    const unrelatedRoot = path.join(runtimeRoot, 'node_modules', 'fixture');
    const archivePath = path.join(tempRoot, 'runtime.tar');

    try {
      fs.mkdirSync(dependencyRoot, { recursive: true });
      fs.mkdirSync(unrelatedRoot, { recursive: true });
      fs.writeFileSync(path.join(extensionRoot, 'THIRD_PARTY_NOTICES.md'), 'notices', 'utf8');
      fs.writeFileSync(path.join(dependencyRoot, 'LICENSE.md'), 'license', 'utf8');
      fs.writeFileSync(path.join(dependencyRoot, 'README.md'), 'readme', 'utf8');
      fs.writeFileSync(path.join(unrelatedRoot, 'README.md'), 'pruned', 'utf8');

      packMultipleSources([{ dir: runtimeRoot, prefix: 'cfmind' }], archivePath);

      const entries: string[] = [];
      listTar({
        file: archivePath,
        sync: true,
        onReadEntry: entry => entries.push(entry.path.replace(/\\/g, '/')),
      });

      expect(entries).toContain(`cfmind/dist/extensions/${extensionId}/THIRD_PARTY_NOTICES.md`);
      expect(entries).toContain(
        `cfmind/dist/extensions/${extensionId}/node_modules/fixture/LICENSE.md`,
      );
      expect(entries).toContain(
        `cfmind/dist/extensions/${extensionId}/node_modules/fixture/README.md`,
      );
      expect(entries).toContain('cfmind/node_modules/fixture/README.md');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  },
);

test('keeps native knowledge, Markdown and Python caches while omitting debug symbols', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-knowledge-'));
  const files = [
    'README.md',
    'docs/README.md',
    'docs/examples/README.md',
    'docs/test/contracts.md',
    'docs/CHANGELOG.md',
    'skills/example/SKILL.md',
    'node_modules/sdk/README.md',
    'native/conpty.node',
    'native/conpty.pdb',
    'Lib/__pycache__/module.cpython-312.pyc',
    'docs/.env',
    'skills/tool/.venv/private.md',
  ];
  try {
    const source = path.join(root, 'runtime');
    for (const file of files) {
      const target = path.join(source, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file);
    }
    const archive = path.join(root, 'runtime.tar');
    packMultipleSources([{ dir: source, prefix: 'cfmind' }], archive);
    const entries: string[] = [];
    listTar({
      file: archive,
      sync: true,
      onReadEntry: entry => entries.push(entry.path.replace(/\\/g, '/')),
    });
    for (const file of files)
      expect(entries.includes('cfmind/' + file), file).toBe(
        !file.endsWith('.pdb') && !file.endsWith('.env') && !file.includes('.venv/'),
      );
    expect(verifyRuntimeKnowledgeEntries(new Set(entries), 'cfmind/', source)).toBe(6);
    expect(() =>
      verifyRuntimeKnowledgeEntries(
        new Set(entries.filter(entry => entry !== 'cfmind/docs/examples/README.md')),
        'cfmind/',
        source,
      ),
    ).toThrow(/docs\/examples\/README.md/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
