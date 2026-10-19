import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createZstdDecompress } from 'node:zlib';

import { list as listTar } from 'tar';
import { expect, test } from 'vitest';

const {
  compressTarArchive,
  packMultipleSources,
  verifyRuntimeKnowledgeEntries,
  verifyLegalMetadataEntries,
} = require('../../scripts/openclaw/pack-openclaw-tar.cjs') as {
  compressTarArchive: (sourceTar: string, outputArchive: string) => Promise<void>;
  verifyRuntimeKnowledgeEntries: (entries: Set<string>, prefix: string, root: string) => number;
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

test('pre-compresses a runtime tar without changing its entries', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-runtime-zstd-'));
  const runtimeRoot = path.join(tempRoot, 'runtime');
  const tarPath = path.join(tempRoot, 'runtime.tar');
  const archivePath = path.join(tempRoot, 'runtime.tar.zst');

  try {
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, 'gateway-bundle.mjs'), 'bundle'.repeat(1000), 'utf8');
    packMultipleSources([{ dir: runtimeRoot, prefix: 'cfmind' }], tarPath);

    await compressTarArchive(tarPath, archivePath);

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
