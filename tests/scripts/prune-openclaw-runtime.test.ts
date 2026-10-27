import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

const { pruneExtensionDependencies, pruneRuntimeExtensions } =
  require('../../scripts/openclaw/prune-openclaw-runtime.cjs') as {
    pruneExtensionDependencies: (extensionRoot: string) => unknown;
    pruneRuntimeExtensions: (
      runtimeRoot: string,
      stats: { extensionDirsRemoved: number; bytesFreed: number },
      options: { repoRoot: string; label: string },
    ) => { removed: string[] };
  };

test('preinstalled plugin requirements remain present after runtime pruning on every platform', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const metadata = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const policy = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'plugins/extensions/prune-policy.json'), 'utf8'),
  );
  const removed = policy.remove.flatMap((group: { extensions: string[] }) => group.extensions);
  for (const plugin of metadata.openclaw.plugins) {
    expect(removed, `${plugin.id} is required by packaging`).not.toContain(plugin.id);
  }
});

test('prunes debug symbols and reviewed SDK sources while keeping Markdown and native binaries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-prune-'));
  const files = [
    'node_modules/openai/package.json',
    'node_modules/openai/index.js',
    'node_modules/openai/index.mjs',
    'node_modules/openai/src/client.ts',
    'node_modules/openai/src/README.md',
    'node_modules/openai/src/tests/guide.md',
    'node_modules/openai/src/LICENSE',
    'node_modules/openai/src/licenses/MIT',
    'node_modules/openai/src/THIRD_PARTY_NOTICES/vendor.txt',
    'node_modules/native/LICENSE.txt',
    'node_modules/native/NOTICE',
    'node_modules/native/tests/COPYING',
    'node_modules/native/tests/guide.md',
    'node_modules/other/src/client.ts',
    'node_modules/native/conpty.node',
    'node_modules/native/conpty.pdb',
    'node_modules/native/README.md',
  ];
  try {
    for (const file of files) {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.endsWith('package.json') ? '{"name":"openai"}' : 'fixture');
    }
    pruneExtensionDependencies(root);
    for (const file of files) {
      expect(fs.existsSync(path.join(root, file)), file).toBe(
        !file.endsWith('.pdb') && file !== 'node_modules/openai/src/client.ts',
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime root and all plugin dependencies preserve legal files without opt-in', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-prune-'));
  try {
    const files = ['LICENSE', 'LICENSE-MIT', 'COPYING.txt', 'NOTICE', 'THIRD_PARTY_NOTICES.txt'];
    for (const file of files) {
      const target = path.join(root, 'node_modules/fixture', file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'fixture');
    }
    const { spawnSync } = require('node:child_process');
    const result = spawnSync(
      process.execPath,
      [path.resolve('scripts/openclaw/prune-openclaw-runtime.cjs'), root],
      { encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    for (const file of files)
      expect(fs.existsSync(path.join(root, 'node_modules/fixture', file))).toBe(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pruning keeps every file in an authenticated upstream bundled tree and its proof', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-prune-proof-'));
  const pristine = path.join(root, 'pristine');
  const runtime = path.join(root, 'runtime');
  const { readOpenClawSourceLock } = require('../../scripts/openclaw/verify-openclaw-runtime-patches.cjs');
  const { inspectPristineBundledDependencies, restorePristineBundledDependencies, verifyBundledDependencies } =
    require('../../scripts/openclaw/openclaw-bundled-dependencies.cjs');
  const sourceLock = readOpenClawSourceLock(process.cwd(),
    JSON.parse(fs.readFileSync('package.json', 'utf8')).openclaw.version);
  const pkg = { name: 'openclaw', version: sourceLock.version, bundleDependencies: ['fixture-bundled'],
    dependencies: { 'fixture-bundled': '1.0.0' } };
  const put = (owner: string, file: string, value: string) => {
    const target = path.join(owner, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value);
  };
  try {
    for (const owner of [pristine, runtime]) {
      put(owner, 'package.json', JSON.stringify(pkg));
      put(owner, 'node_modules/fixture-bundled/package.json', JSON.stringify({ name: 'fixture-bundled', version: '1.0.0' }));
    }
    for (const file of ['index.js', 'index.d.ts', 'tests/identity.test.js', 'README.md', 'LICENSE', 'OPENCLAW_PATCH_NOTICE.md'])
      put(pristine, 'node_modules/fixture-bundled/' + file, file);
    put(runtime, 'npm-shrinkwrap.json', JSON.stringify({ name: pkg.name, version: pkg.version,
      packages: { 'node_modules/fixture-bundled': { version: '1.0.0', inBundle: true,
        resolved: 'https://registry.example.test/fixture-bundled.tgz',
        integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` } } }));
    put(runtime, 'node_modules/unrelated/index.d.ts', 'remove this ordinary declaration');
    const pristineProof = inspectPristineBundledDependencies(pristine, { sourceLock });
    const proof = restorePristineBundledDependencies(runtime, pristine, { sourceLock, pristineProof });
    const proofBytes = fs.readFileSync(path.join(runtime, 'runtime-bundled-dependencies.json'));
    execFileSync(process.execPath, [path.resolve('scripts/openclaw/prune-openclaw-runtime.cjs'), runtime]);
    expect(verifyBundledDependencies(runtime, { sourceLock })).toEqual(proof);
    expect(fs.readFileSync(path.join(runtime, 'runtime-bundled-dependencies.json'))).toEqual(proofBytes);
    expect(fs.existsSync(path.join(runtime, 'node_modules/unrelated/index.d.ts'))).toBe(false);
  } finally {
    expect(path.dirname(root)).toBe(os.tmpdir());
    expect(path.basename(root)).toMatch(/^bundled-prune-proof-/u);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('prunes public-cloud plugins while retaining the intranet OpenAI adapter and local extensions', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const targetVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
    .openclaw.version.replace(/^v/u, '');
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-plugin-prune-'));
  const extensionsRoot = path.join(runtimeRoot, 'dist', 'extensions');
  const excluded = ['cloudflare', 'elevenlabs', 'kie', 'anthropic', 'github', 'x'];
  const retained = [
    'openai',
    'browser',
    'cua-computer',
    'tts-local-cli',
    'stt-local-cli',
    'typesafe',
  ];
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    for (const id of [...excluded, ...retained]) {
      const extensionRoot = path.join(extensionsRoot, id);
      fs.mkdirSync(extensionRoot, { recursive: true });
      fs.writeFileSync(path.join(extensionRoot, 'index.js'), 'export default {};');
    }
    const computerRoot = path.join(extensionsRoot, 'cua-computer');
    for (const id of ['openai', 'tts-local-cli']) {
      fs.writeFileSync(
        path.join(extensionsRoot, id, 'package.json'),
        JSON.stringify({ version: targetVersion, openclaw: { runtimeBundled: true } }),
      );
    }
    const nativeRoot = path.join(
      computerRoot,
      'node_modules',
      '@trycua',
      'cua-driver-win32-x64-msvc',
    );
    fs.mkdirSync(nativeRoot, { recursive: true });
    const nativeFiles = ['package.json', 'cua_driver_node_runtime.node', 'cua_driver_sdk.dll'];
    for (const filename of nativeFiles) fs.writeFileSync(path.join(nativeRoot, filename), filename);
    fs.writeFileSync(path.join(nativeRoot, 'index.d.ts'), 'export {};');
    const stats = { extensionDirsRemoved: 0, bytesFreed: 0 };

    const result = pruneRuntimeExtensions(runtimeRoot, stats, { repoRoot, label: 'test' });
    pruneExtensionDependencies(computerRoot);

    expect(result.removed.sort()).toEqual([...excluded].sort());
    expect(stats.extensionDirsRemoved).toBe(excluded.length);
    expect(fs.readdirSync(extensionsRoot).sort()).toEqual([...retained].sort());
    expect(fs.readdirSync(nativeRoot).sort()).toEqual([...nativeFiles].sort());
    fs.writeFileSync(
      path.join(extensionsRoot, 'openai', 'package.json'),
      JSON.stringify({ version: targetVersion }),
    );
    expect(() => pruneRuntimeExtensions(runtimeRoot, stats, { repoRoot, label: 'test' })).toThrow(
      /Missing local source replacement: openai/,
    );
  } finally {
    log.mockRestore();
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
