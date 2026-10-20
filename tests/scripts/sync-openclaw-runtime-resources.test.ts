import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test, vi } from 'vitest';

const {
  renameExtensionIntoPlace,
  resolveExtensionInstallTimeoutMs,
  syncDocChannels,
  syncGatewayConfigChannels,
  syncLocalExtensions,
} = require('../../scripts/openclaw/sync-openclaw-runtime-resources.cjs') as {
  renameExtensionIntoPlace: (
    sourceDir: string,
    targetDir: string,
    options?: {
      rename?: (sourceDir: string, targetDir: string) => void;
      sleep?: (delayMs: number) => void;
      maxRetries?: number;
      retryDelayMs?: number;
    },
  ) => void;
  resolveExtensionInstallTimeoutMs: (env?: Record<string, string | undefined>) => number;
  syncDocChannels: (
    repoRoot: string,
    runtimeRoot: string,
    label: string,
  ) => {
    sourceDir: string;
    targetDir: string;
    copiedFiles: number;
  };
  syncGatewayConfigChannels: (
    repoRoot: string,
    runtimeRoot: string,
    label: string,
  ) => {
    sourceFile: string;
    targetFile: string;
  };
  syncLocalExtensions: (
    repoRoot: string,
    runtimeRoot: string,
    label: string,
    options?: {
      installProductionDependencies?: (
        extensionDir: string,
        installTarget: { targetId: string; os: string; cpu: string },
      ) => void;
      installTarget?: { targetId: string; os: string; cpu: string };
    },
  ) => {
    sourceDir: string;
    targetDir: string;
    copied: string[];
  };
};

test('retries transient Windows errors while moving an extension into place', () => {
  const rename = vi
    .fn<(sourceDir: string, targetDir: string) => void>()
    .mockImplementationOnce(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    })
    .mockImplementationOnce(() => {
      throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
    })
    .mockImplementation(() => undefined);
  const sleep = vi.fn<(delayMs: number) => void>();

  renameExtensionIntoPlace('staged', 'installed', {
    rename,
    sleep,
    maxRetries: 2,
    retryDelayMs: 25,
  });

  expect(rename).toHaveBeenCalledTimes(3);
  expect(sleep.mock.calls).toEqual([[25], [25]]);
});

test('does not retry a non-transient extension rename error', () => {
  const error = Object.assign(new Error('source is missing'), { code: 'ENOENT' });
  const rename = vi.fn(() => {
    throw error;
  });
  const sleep = vi.fn();

  expect(() => renameExtensionIntoPlace('staged', 'installed', { rename, sleep })).toThrow(error);
  expect(rename).toHaveBeenCalledOnce();
  expect(sleep).not.toHaveBeenCalled();
});

test('copies the complete staged tree when extension rename retries are exhausted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-publish-'));
  const source = path.join(root, 'staged');
  const target = path.join(root, 'installed');
  const rename = vi.fn(() => {
    throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  });
  try {
    fs.mkdirSync(path.join(source, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(source, 'assets', 'viewer.html'), 'complete payload');
    fs.writeFileSync(path.join(source, 'package.json'), '{"name":"fixture"}');

    renameExtensionIntoPlace(source, target, { rename, sleep: () => {}, maxRetries: 1 });

    expect(rename).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(path.join(target, 'assets', 'viewer.html'), 'utf8')).toBe('complete payload');
    expect(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).toBe('{"name":"fixture"}');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('does not merge the copy fallback into an occupied destination', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-publish-'));
  const target = path.join(root, 'installed');
  const error = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  try {
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'existing.txt'), 'preserved');
    expect(() => renameExtensionIntoPlace(path.join(root, 'staged'), target, {
      rename: () => { throw error; }, maxRetries: 0,
    })).toThrow(error);
    expect(fs.readdirSync(target)).toEqual(['existing.txt']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails publication when copying the staged extension fails', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-publish-'));
  try {
    expect(() => renameExtensionIntoPlace(path.join(root, 'missing'), path.join(root, 'installed'), {
      rename: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
      maxRetries: 0,
    })).toThrow(/rename and copy fallback failed/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('uses a bounded configurable timeout for locked extension installs', () => {
  expect(resolveExtensionInstallTimeoutMs({})).toBe(20 * 60 * 1000);
  expect(resolveExtensionInstallTimeoutMs({ JUSTDO_EXTENSION_NPM_CI_TIMEOUT_MS: '1800000' })).toBe(
    30 * 60 * 1000,
  );
  expect(() =>
    resolveExtensionInstallTimeoutMs({ JUSTDO_EXTENSION_NPM_CI_TIMEOUT_MS: '0' }),
  ).toThrow(/60000 to 3600000/u);
});

test('stages all local extensions and installs only declared production dependencies', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-runtime-resources-'));
  const repoRoot = path.join(tempRoot, 'repo');
  const runtimeRoot = path.join(tempRoot, 'runtime');
  const extensionsRoot = path.join(repoRoot, 'plugins/extensions');
  const targetRoot = path.join(runtimeRoot, 'dist', 'extensions');
  const installProductionDependencies = vi.fn(
    (extensionDir: string, _installTarget: { targetId: string; os: string; cpu: string }) => {
      const dependencyDir = path.join(extensionDir, 'node_modules', 'fixture-dep');
      fs.mkdirSync(dependencyDir, { recursive: true });
      fs.writeFileSync(
        path.join(dependencyDir, 'package.json'),
        JSON.stringify({ name: 'fixture-dep', version: '1.0.0' }),
      );
      fs.writeFileSync(path.join(dependencyDir, 'index.js'), 'module.exports = true;', 'utf8');
    },
  );
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  try {
    fs.mkdirSync(path.join(extensionsRoot, 'dependency-free'), { recursive: true });
    fs.writeFileSync(
      path.join(extensionsRoot, 'dependency-free', 'package.json'),
      JSON.stringify({ name: 'dependency-free', version: '1.0.0' }),
      'utf8',
    );
    fs.mkdirSync(path.join(extensionsRoot, 'with-dependency'), { recursive: true });
    fs.writeFileSync(
      path.join(extensionsRoot, 'with-dependency', 'package.json'),
      JSON.stringify({
        name: 'with-dependency',
        version: '1.0.0',
        dependencies: { 'fixture-dep': '1.0.0' },
      }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(extensionsRoot, 'with-dependency', 'package-lock.json'),
      '{"lockfileVersion":3}',
      'utf8',
    );
    fs.mkdirSync(path.join(targetRoot, 'dependency-free'), { recursive: true });
    fs.writeFileSync(path.join(targetRoot, 'dependency-free', 'stale.txt'), 'stale', 'utf8');

    const result = syncLocalExtensions(repoRoot, runtimeRoot, 'test', {
      installProductionDependencies,
      installTarget: { targetId: 'win-x64', os: 'win32', cpu: 'x64' },
    });

    expect(result.copied).toEqual(['dependency-free', 'with-dependency']);
    expect(installProductionDependencies).toHaveBeenCalledOnce();
    expect(path.basename(installProductionDependencies.mock.calls[0][0])).toBe('with-dependency');
    expect(installProductionDependencies.mock.calls[0][1]).toEqual({
      targetId: 'win-x64',
      os: 'win32',
      cpu: 'x64',
    });
    expect(fs.existsSync(path.join(targetRoot, 'dependency-free', 'stale.txt'))).toBe(false);
    expect(
      fs.existsSync(
        path.join(targetRoot, 'with-dependency', 'node_modules', 'fixture-dep', 'index.js'),
      ),
    ).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, 'vendor', 'openclaw-plugins'))).toBe(false);
  } finally {
    logSpy.mockRestore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('syncs rebuilt App packages with exact native bindings and nested companion entries', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'app-runtime-resources-'));
  const repoRoot = path.join(tempRoot, 'repo');
  const runtimeRoot = path.join(tempRoot, 'runtime');
  const sourceRoot = path.join(repoRoot, 'plugins/extensions');
  const destination = path.join(repoRoot, 'build/app-plugins');
  const ids = ['sample-one', 'sample-two'];
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const build = () =>
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import { buildAppPlugins } from ${JSON.stringify(pathToFileURL(path.resolve('scripts/plugins/build-app-plugins.mjs')).href)}; await buildAppPlugins({ sourceRoot: process.argv[1], destination: process.argv[2] });`,
        sourceRoot,
        destination,
      ],
      { cwd: path.resolve('.'), timeout: 30_000, stdio: 'pipe' },
    );

  try {
    for (const id of ids) {
      const source = path.join(sourceRoot, id);
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(
        path.join(source, 'package.json'),
        JSON.stringify({
          name: id,
          version: '1.0.0',
          type: 'module',
          justdo: { bundle: true },
          openclaw: { extensions: ['./index.ts'] },
          app: { main: 'main.ts', browser: 'browser.ts' },
        }),
      );
      fs.writeFileSync(
        path.join(source, 'app.plugin.json'),
        JSON.stringify({
          manifestVersion: 1,
          apiVersion: 1,
          id,
          nativePluginId: id,
          version: '1.0.0',
          entries: { main: 'main/index.mjs', browser: 'ui/index.mjs' },
          capabilities: [],
          commands: [],
          slots: [],
        }),
      );
      fs.writeFileSync(
        path.join(source, 'openclaw.plugin.json'),
        JSON.stringify({
          id,
          configSchema: { type: 'object', properties: {} },
        }),
      );
      fs.writeFileSync(
        path.join(source, 'index.ts'),
        `export const revision = 1; export default { id: ${JSON.stringify(id)}, register(api) { api.seenRevision = revision; } };`,
      );
      fs.writeFileSync(path.join(source, 'main.ts'), 'export function register() {}');
      fs.writeFileSync(path.join(source, 'browser.ts'), 'export function register() {}');
    }

    // A clean checkout must fail explicitly rather than silently re-bundle native code.
    expect(() => syncLocalExtensions(repoRoot, runtimeRoot, 'test')).toThrow(
      'Build app plugins before syncing native runtime resources',
    );
    build();
    const firstCatalog = JSON.parse(
      fs.readFileSync(path.join(destination, 'catalog.json'), 'utf8'),
    );
    expect(syncLocalExtensions(repoRoot, runtimeRoot, 'test').copied).toEqual(ids);
    fs.writeFileSync(
      path.join(sourceRoot, ids[0], 'index.ts'),
      `export const revision = 2; export default { id: ${JSON.stringify(ids[0])}, register(api) { api.seenRevision = revision; } };`,
    );
    build();
    const catalog = JSON.parse(fs.readFileSync(path.join(destination, 'catalog.json'), 'utf8'));
    expect(catalog[0].hash).not.toBe(firstCatalog[0].hash);
    expect(syncLocalExtensions(repoRoot, runtimeRoot, 'test').copied).toEqual(ids);

    for (const { id, hash } of catalog) {
      const target = path.join(runtimeRoot, 'dist/extensions', id);
      const built = path.join(destination, 'packages', id, hash);
      const nativeBytes = fs.readFileSync(path.join(target, 'index.js'));
      const binding = JSON.parse(
        fs.readFileSync(path.join(target, 'app/native.binding.json'), 'utf8'),
      );
      expect(nativeBytes.equals(fs.readFileSync(path.join(built, 'index.js')))).toBe(true);
      expect(createHash('sha256').update(nativeBytes).digest('hex')).toBe(binding.sha256);
      expect(
        JSON.parse(fs.readFileSync(path.join(target, 'app/app.artifact.json'), 'utf8')).hash,
      ).toBe(hash);
      expect(fs.readFileSync(path.join(target, 'app/main/index.mjs'), 'utf8')).toContain(
        'register',
      );
      expect(fs.readFileSync(path.join(target, 'app/ui/index.mjs'), 'utf8')).toContain('register');
      expect(
        JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).openclaw.extensions,
      ).toEqual(['./index.js']);
      expect(fs.existsSync(path.join(target, 'index.ts'))).toBe(false);
      expect(fs.existsSync(path.join(target, 'app.plugin.json'))).toBe(false);
      expect(
        JSON.parse(fs.readFileSync(path.join(target, 'openclaw.plugin.json'), 'utf8')).contracts
          .gatewayMethodDispatch,
      ).toEqual(['authenticated-request']);
    }

    // A custom Native entry imports no application SDK. The App builder still
    // supplies its receipt/dispatch boundary and preserves the author's exports.
    const publicSdkStub = path.join(tempRoot, 'node_modules/openclaw');
    fs.mkdirSync(publicSdkStub, { recursive: true });
    fs.writeFileSync(
      path.join(publicSdkStub, 'package.json'),
      JSON.stringify({
        name: 'openclaw',
        type: 'module',
        exports: { './plugin-sdk/gateway-method-runtime': './dispatch.js' },
      }),
    );
    fs.writeFileSync(
      path.join(publicSdkStub, 'dispatch.js'),
      'export async function dispatchGatewayMethod(method, params, options) { return { ok: true, payload: { method, params, options } }; }',
    );
    const entry = path.join(runtimeRoot, 'dist/extensions', ids[0], 'index.js');
    const proof = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `
            import assert from 'node:assert/strict';
            import { pathToFileURL } from 'node:url';
            const source = process.argv[1];
            const module = await import(pathToFileURL(source).href);
            assert.equal(module.revision, 2);
            const handlers = new Map();
            const api = {
              id: ${JSON.stringify(ids[0])}, source,
              lifecycle: { signal: new AbortController().signal, onDispose: () => () => {} },
              registerGatewayMethod: (name, handler) => handlers.set(name, handler),
            };
            module.default.register(api);
            assert.equal(api.seenRevision, 2);
            assert.equal(handlers.size, 2);
            let receipt;
            const request = (params, respond) => ({
              params, respond, client: { connect: { client: { mode: 'backend' } } },
              context: { isConfigReloadSettled: () => true,
                getGatewayMethodRegistry: () => ({ descriptors: () => [] }),
              },
              hasCurrentClientAuthority: () => true,
            });
            handlers.get(api.id + '.app.handshake')(request({}, (ok, value) => {
              assert.equal(ok, true); receipt = value;
            }));
            assert.equal(receipt.pluginId, api.id);
            assert.equal(receipt.processId, process.pid);
            const options = { expectFinal: true, timeoutMs: 2000 };
            await handlers.get(api.id + '.app.dispatch')(request({
              registrationId: receipt.registrationId, processId: receipt.processId,
              method: 'sessions.list', params: { limit: 7 }, options,
            }, (ok, payload) => {
              assert.equal(ok, true);
              assert.deepEqual(payload, { method: 'sessions.list', params: { limit: 7 }, options });
            }));
            console.log(JSON.stringify({ automaticNativeBridge: true, namedExportsPreserved: true }));
          `,
          entry,
        ],
        { cwd: tempRoot, timeout: 10_000, encoding: 'utf8' },
      ),
    );
    expect(proof).toEqual({ automaticNativeBridge: true, namedExportsPreserved: true });
  } finally {
    logSpy.mockRestore();
    expect(path.dirname(tempRoot)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(tempRoot)).toMatch(/^app-runtime-resources-/u);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}, 30_000);

test('reuses locked target dependencies without reinstalling them', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-runtime-resources-'));
  const repoRoot = path.join(tempRoot, 'repo');
  const runtimeRoot = path.join(tempRoot, 'runtime');
  const extensionRoot = path.join(repoRoot, 'plugins/extensions', 'with-dependency');
  const targetRoot = path.join(runtimeRoot, 'dist', 'extensions', 'with-dependency');
  const installProductionDependencies = vi.fn(
    (extensionDir: string, _installTarget: { targetId: string; os: string; cpu: string }) => {
      const dependencyDir = path.join(extensionDir, 'node_modules', 'fixture-dep');
      fs.mkdirSync(dependencyDir, { recursive: true });
      fs.writeFileSync(
        path.join(dependencyDir, 'package.json'),
        JSON.stringify({ name: 'fixture-dep', version: '1.0.0' }),
      );
      fs.writeFileSync(path.join(dependencyDir, 'index.js'), 'first');
    },
  );
  const installTarget = { targetId: 'win-x64', os: 'win32', cpu: 'x64' };
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  try {
    fs.mkdirSync(extensionRoot, { recursive: true });
    fs.writeFileSync(
      path.join(extensionRoot, 'package.json'),
      JSON.stringify({ name: 'with-dependency', dependencies: { 'fixture-dep': '1.0.0' } }),
    );
    fs.writeFileSync(path.join(extensionRoot, 'package-lock.json'), '{"lockfileVersion":3}');
    fs.writeFileSync(path.join(extensionRoot, 'index.ts'), 'export const revision = 1;');

    syncLocalExtensions(repoRoot, runtimeRoot, 'test', {
      installProductionDependencies,
      installTarget,
    });
    fs.writeFileSync(path.join(extensionRoot, 'index.ts'), 'export const revision = 2;');
    syncLocalExtensions(repoRoot, runtimeRoot, 'test', {
      installProductionDependencies,
      installTarget,
    });

    expect(installProductionDependencies).toHaveBeenCalledOnce();
    expect(fs.readFileSync(path.join(targetRoot, 'index.ts'), 'utf8')).toContain('revision = 2');
    expect(
      fs.readFileSync(path.join(targetRoot, 'node_modules', 'fixture-dep', 'index.js'), 'utf8'),
    ).toBe('first');
  } finally {
    logSpy.mockRestore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('rebuilds an assembly when its installed dependency is incomplete', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-runtime-resources-'));
  const repoRoot = path.join(tempRoot, 'repo');
  const runtimeRoot = path.join(tempRoot, 'runtime');
  const extensionRoot = path.join(repoRoot, 'plugins/extensions', 'with-dependency');
  const targetDependencyRoot = path.join(
    runtimeRoot,
    'dist',
    'extensions',
    'with-dependency',
    'node_modules',
    'fixture-dep',
  );
  const installProductionDependencies = vi.fn((extensionDir: string) => {
    const dependencyDir = path.join(extensionDir, 'node_modules', 'fixture-dep');
    fs.mkdirSync(dependencyDir, { recursive: true });
    fs.writeFileSync(
      path.join(dependencyDir, 'package.json'),
      JSON.stringify({ name: 'fixture-dep', version: '1.0.0' }),
    );
  });
  const installTarget = { targetId: 'win-x64', os: 'win32', cpu: 'x64' };
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  try {
    fs.mkdirSync(extensionRoot, { recursive: true });
    fs.writeFileSync(
      path.join(extensionRoot, 'package.json'),
      JSON.stringify({ name: 'with-dependency', dependencies: { 'fixture-dep': '1.0.0' } }),
    );
    fs.writeFileSync(path.join(extensionRoot, 'package-lock.json'), '{"lockfileVersion":3}');

    syncLocalExtensions(repoRoot, runtimeRoot, 'test', {
      installProductionDependencies,
      installTarget,
    });
    fs.rmSync(path.join(targetDependencyRoot, 'package.json'));
    syncLocalExtensions(repoRoot, runtimeRoot, 'test', {
      installProductionDependencies,
      installTarget,
    });

    expect(installProductionDependencies).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(path.join(targetDependencyRoot, 'package.json'))).toBe(true);
    expect(warnSpy).toHaveBeenCalledOnce();
  } finally {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('cleans an interrupted owned staging directory before synchronization', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-runtime-resources-'));
  const repoRoot = path.join(tempRoot, 'repo');
  const runtimeRoot = path.join(tempRoot, 'runtime');
  const sourceRoot = path.join(repoRoot, 'plugins/extensions', 'dependency-free');
  const residueRoot = path.join(
    runtimeRoot,
    'dist',
    'extensions',
    '.justdo-extension-acpx-interrupted',
  );
  const unrelatedHiddenRoot = path.join(runtimeRoot, 'dist', 'extensions', '.other-extension');
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  try {
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.writeFileSync(
      path.join(sourceRoot, 'package.json'),
      JSON.stringify({ name: 'dependency-free', version: '1.0.0' }),
    );
    fs.mkdirSync(residueRoot, { recursive: true });
    fs.mkdirSync(unrelatedHiddenRoot, { recursive: true });

    syncLocalExtensions(repoRoot, runtimeRoot, 'test');

    expect(fs.existsSync(residueRoot)).toBe(false);
    expect(fs.existsSync(unrelatedHiddenRoot)).toBe(true);
  } finally {
    logSpy.mockRestore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('replaces OpenClaw doc channels and removes stale target files', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-runtime-resources-'));
  const repoRoot = path.join(tempRoot, 'repo');
  const runtimeRoot = path.join(tempRoot, 'runtime');
  const sourceDir = path.join(repoRoot, 'resources', 'openclaw', 'docs', 'channels');
  const targetDir = path.join(runtimeRoot, 'docs', 'channels');
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  try {
    fs.mkdirSync(path.join(sourceDir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'index.md'), 'replacement', 'utf8');
    fs.writeFileSync(path.join(sourceDir, 'nested', 'guide.md'), 'guide', 'utf8');
    fs.mkdirSync(path.join(targetDir, 'stale'), { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'obsolete.md'), 'obsolete', 'utf8');
    fs.writeFileSync(path.join(targetDir, 'stale', 'old.md'), 'old', 'utf8');
    const result = syncDocChannels(repoRoot, runtimeRoot, 'test');

    expect(result).toEqual({ sourceDir, targetDir, copiedFiles: 2 });
    expect(fs.readFileSync(path.join(targetDir, 'index.md'), 'utf8')).toBe('replacement');
    expect(fs.readFileSync(path.join(targetDir, 'nested', 'guide.md'), 'utf8')).toBe('guide');
    expect(fs.existsSync(path.join(targetDir, 'obsolete.md'))).toBe(false);
    expect(fs.existsSync(path.join(targetDir, 'stale'))).toBe(false);
  } finally {
    logSpy.mockRestore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('replaces the OpenClaw gateway channel config document', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-runtime-resources-'));
  const repoRoot = path.join(tempRoot, 'repo');
  const runtimeRoot = path.join(tempRoot, 'runtime');
  const sourceFile = path.join(repoRoot, 'resources', 'openclaw', 'docs', 'gateway', 'config-channels.md');
  const targetFile = path.join(runtimeRoot, 'docs', 'gateway', 'config-channels.md');
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

  try {
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.writeFileSync(sourceFile, 'replacement', 'utf8');
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, 'original', 'utf8');

    const result = syncGatewayConfigChannels(repoRoot, runtimeRoot, 'test');

    expect(result).toEqual({ sourceFile, targetFile });
    expect(fs.readFileSync(targetFile, 'utf8')).toBe('replacement');
  } finally {
    logSpy.mockRestore();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
