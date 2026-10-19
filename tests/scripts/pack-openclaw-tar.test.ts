import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createZstdDecompress } from 'node:zlib';

import { list as listTar } from 'tar';
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
