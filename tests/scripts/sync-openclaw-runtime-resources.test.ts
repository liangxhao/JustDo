import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  const extensionsRoot = path.join(repoRoot, 'openclaw-extensions');
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

test('reuses locked target dependencies without reinstalling them', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-runtime-resources-'));
  const repoRoot = path.join(tempRoot, 'repo');
  const runtimeRoot = path.join(tempRoot, 'runtime');
  const extensionRoot = path.join(repoRoot, 'openclaw-extensions', 'with-dependency');
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
  const extensionRoot = path.join(repoRoot, 'openclaw-extensions', 'with-dependency');
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
  const sourceRoot = path.join(repoRoot, 'openclaw-extensions', 'dependency-free');
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
  const sourceDir = path.join(repoRoot, 'resources', 'docs', 'channels');
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
  const sourceFile = path.join(repoRoot, 'resources', 'docs', 'gateway', 'config-channels.md');
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


test.each(['openclaw-collaboration', 'third-party'])('retires only the former app-owned collaboration package (%s)', packageName => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-retired-extension-'));
  try {
    const repoRoot = path.join(tempRoot, 'repo');
    const runtimeRoot = path.join(tempRoot, 'runtime');
    fs.mkdirSync(path.join(repoRoot, 'openclaw-extensions'), { recursive: true });
    const retired = path.join(runtimeRoot, 'dist', 'extensions', 'collaboration');
    fs.mkdirSync(retired, { recursive: true });
    fs.writeFileSync(path.join(retired, 'package.json'), JSON.stringify({ name: packageName }));
    syncLocalExtensions(repoRoot, runtimeRoot, 'test');
    expect(fs.existsSync(retired)).toBe(packageName !== 'openclaw-collaboration');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
