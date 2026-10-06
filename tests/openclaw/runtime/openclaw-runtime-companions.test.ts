import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  getRuntimeCompanionPathsReferencedByBundle,
  hasStaleRuntimeWorkerImportMetaUrl,
  rewriteRuntimeWorkerImportMetaUrls,
  syncRuntimeBundledAssets,
} = require('../../../scripts/openclaw/openclaw-runtime-companions.cjs') as {
  getRuntimeCompanionPathsReferencedByBundle: (bundle: string) => string[];
  hasStaleRuntimeWorkerImportMetaUrl: (bundle: string) => boolean;
  rewriteRuntimeWorkerImportMetaUrls: (source: string, replacement: string) => string;
  syncRuntimeBundledAssets: (runtimeRoot: string, bundle: string) => string[];
};

describe('OpenClaw runtime companions', () => {
  it('keeps the Windows command Job launcher in dist after bundling', () => {
    const source = `function resolveManagedWindowsJobEntrypointUrl() {
      const current = new URL(import.meta.url);
      const distIndex = current.pathname.lastIndexOf('/dist/');
      return new URL(current.pathname.slice(0, distIndex + 6) + 'tooling/managed-windows-job-launcher.js', current);
    }`;
    expect(hasStaleRuntimeWorkerImportMetaUrl(source)).toBe(true);
    const rewritten = rewriteRuntimeWorkerImportMetaUrls(source,
      'new URL("./dist/managed-windows-job-fixture.mjs", "file:///runtime/gateway-bundle.mjs").href');
    expect(hasStaleRuntimeWorkerImportMetaUrl(rewritten)).toBe(false);
    expect(new Function(rewritten + '; return resolveManagedWindowsJobEntrypointUrl().href;')())
      .toBe('file:///runtime/dist/tooling/managed-windows-job-launcher.js');
    expect(getRuntimeCompanionPathsReferencedByBundle(rewritten))
      .toContain('dist/tooling/managed-windows-job-launcher.js');
    expect(rewriteRuntimeWorkerImportMetaUrls(rewritten, 'another')).toBe(rewritten);
  });
  it('makes the original build identity available beside the bundled migration reader', () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-build-identity-'));
    try {
      fs.mkdirSync(path.join(runtimeRoot, 'dist'));
      const sourcePath = path.join(runtimeRoot, 'dist', 'build-info.json');
      const metadata = { version: '2026.9.6', builtAt: '2026-09-23T16:33:12.144Z' };
      fs.writeFileSync(sourcePath, JSON.stringify(metadata));
      const bundledRequire = createRequire(path.join(runtimeRoot, 'gateway-bundle.mjs'));
      expect(() => bundledRequire('./build-info.json')).toThrow();

      const copied = syncRuntimeBundledAssets(runtimeRoot, 'resolveStartupMigrationBuildIdentity');

      expect(copied).toEqual(['build-info.json']);
      expect(bundledRequire('./build-info.json')).toEqual(metadata);
      expect(fs.readFileSync(path.join(runtimeRoot, 'build-info.json'))).toEqual(
        fs.readFileSync(sourcePath),
      );
      expect(
        getRuntimeCompanionPathsReferencedByBundle('resolveStartupMigrationBuildIdentity'),
      ).toEqual(['build-info.json']);
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('rejects a migration-capable bundle whose upstream build metadata is missing', () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-build-identity-'));
    try {
      expect(() =>
        syncRuntimeBundledAssets(runtimeRoot, 'resolveStartupMigrationBuildIdentity'),
      ).toThrow('dist/build-info.json');
      expect(fs.existsSync(path.join(runtimeRoot, 'build-info.json'))).toBe(false);
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });

  it('resolves the native launcher from the original entry location after bundling', () => {
    const source = 'await import(new URL("../node-host-launcher.mjs", import.meta.url).href);';
    expect(hasStaleRuntimeWorkerImportMetaUrl(source)).toBe(true);
    const rewritten = rewriteRuntimeWorkerImportMetaUrls(
      source,
      'new URL("./dist/entry.js", import.meta.url).href',
    );
    expect(hasStaleRuntimeWorkerImportMetaUrl(rewritten)).toBe(false);
    expect(rewritten).toContain(
      'new URL("../node-host-launcher.mjs", new URL("./dist/entry.js", import.meta.url).href)',
    );
    expect(getRuntimeCompanionPathsReferencedByBundle(rewritten)).toEqual([
      'node-host-launcher.mjs',
    ]);
  });

  it('anchors the shared v2026.9.6 process entrypoints module to its dist location', () => {
    const source = `
      const currentModuleUrl = import.meta.url;
      const runtimeProcessEntrypoints = {
        sqliteReadOnly: {
          currentModuleUrl,
          sourceWorkerName: 'sqlite-readonly-location.worker',
          distWorkerPath: 'infra/sqlite-readonly-location.worker.js',
        },
      };
    `;

    expect(hasStaleRuntimeWorkerImportMetaUrl(source)).toBe(true);

    const rewritten = rewriteRuntimeWorkerImportMetaUrls(
      source,
      "new URL('./dist/runtime-process-entrypoints.js', import.meta.url).href",
    );

    expect(hasStaleRuntimeWorkerImportMetaUrl(rewritten)).toBe(false);
    expect(rewritten).toContain(
      "const currentModuleUrl = new URL('./dist/runtime-process-entrypoints.js', import.meta.url).href;",
    );
  });

  it('anchors generic runtime workers to their original dist module', () => {
    const source = `
      const workerUrl = resolveRuntimeWorkerUrl({
        currentModuleUrl: import.meta.url,
        sourceWorkerName: 'sqlite-readonly-location.worker',
        distWorkerPath: 'infra/sqlite-readonly-location.worker.js',
      });
      const unrelated = import.meta.url;
    `;

    const rewritten = rewriteRuntimeWorkerImportMetaUrls(
      source,
      "new URL('./dist/sqlite-readonly-location.js', import.meta.url).href",
    );

    expect(hasStaleRuntimeWorkerImportMetaUrl(rewritten)).toBe(false);
    expect(rewritten).toContain(
      "currentModuleUrl: new URL('./dist/sqlite-readonly-location.js', import.meta.url).href",
    );
    expect(rewritten).toContain('const unrelated = import.meta.url');
  });

  it('anchors the database verifier worker to its original dist module', () => {
    const source = `
      function resolveDatabaseVerifyWorkerUrl(currentModuleUrl = import.meta.url) {
        return new URL('./openclaw-database-verify.worker.js', currentModuleUrl);
      }
    `;

    const rewritten = rewriteRuntimeWorkerImportMetaUrls(
      source,
      "new URL('./dist/state/openclaw-database-verify.js', import.meta.url).href",
    );

    expect(hasStaleRuntimeWorkerImportMetaUrl(rewritten)).toBe(false);
    expect(rewritten).toContain(
      "currentModuleUrl = new URL('./dist/state/openclaw-database-verify.js', import.meta.url).href",
    );
  });

  it('requires every companion referenced by the v2026.9.6 bundle', () => {
    const bundle = `
      distWorkerPath: 'infra/sqlite-readonly-location.worker.js';
      distWorkerPath: 'agents/model-provider-auth.worker.js';
      return new URL('./openclaw-database-verify.worker.js', currentModuleUrl);
      distWorkerPath: 'config/sessions/session-accessor.sqlite-archive.worker.js';
      distWorkerPath: 'config/sessions/session-transcript-reconcile.worker.js';
      distWorkerPath: 'infra/tailscale-route-owner.worker.js';
      distWorkerPath: 'process/supervisor/service-child-relay.js';
      distWorkerPath: 'process/supervisor/service-child-group-anchor.js';
      distWorkerPath: 'process/supervisor/service-child-windows-job-anchor.js';
    `;

    expect(getRuntimeCompanionPathsReferencedByBundle(bundle)).toEqual([
      'dist/agents/model-provider-auth.worker.js',
      'dist/state/openclaw-database-verify.worker.js',
      'dist/infra/sqlite-readonly-location.worker.js',
      'dist/config/sessions/session-accessor.sqlite-archive.worker.js',
      'dist/config/sessions/session-transcript-reconcile.worker.js',
      'dist/infra/tailscale-route-owner.worker.js',
      'dist/process/supervisor/service-child-relay.js',
      'dist/process/supervisor/service-child-group-anchor.js',
      'dist/process/supervisor/service-child-windows-job-anchor.js',
    ]);
  });

  it('copies web-tree-sitter WASM beside a bundle that resolves it via import.meta.url', () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-runtime-companions-'));
    const sourcePath = path.join(
      runtimeRoot,
      'node_modules',
      'web-tree-sitter',
      'web-tree-sitter.wasm',
    );

    try {
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, Buffer.from([0x00, 0x61, 0x73, 0x6d]));

      const copied = syncRuntimeBundledAssets(
        runtimeRoot,
        `return new URL('web-tree-sitter.wasm', import.meta.url).href;`,
      );

      expect(copied).toEqual(['web-tree-sitter.wasm']);
      expect(fs.readFileSync(path.join(runtimeRoot, 'web-tree-sitter.wasm'))).toEqual(
        fs.readFileSync(sourcePath),
      );
      expect(getRuntimeCompanionPathsReferencedByBundle('load web-tree-sitter.wasm')).toContain(
        'web-tree-sitter.wasm',
      );
    } finally {
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  });
});

it('anchors the dynamically loaded binding repair companion to dist after bundling', () => {
  const source =
    'const modulePath = new URL(source ? "./legacy-config-binding-repair.runtime.ts" : "./legacy-config-binding-repair.runtime.js", import.meta.url);';
  const replacement = 'new URL("./dist/io.snapshot.mjs", import.meta.url).href';
  expect(hasStaleRuntimeWorkerImportMetaUrl(source)).toBe(true);
  const rewritten = rewriteRuntimeWorkerImportMetaUrls(source, replacement);
  expect(hasStaleRuntimeWorkerImportMetaUrl(rewritten)).toBe(false);
  expect(rewritten).toContain('"./legacy-config-binding-repair.runtime.js", ' + replacement);
  expect(getRuntimeCompanionPathsReferencedByBundle(rewritten)).toContain(
    'dist/legacy-config-binding-repair.runtime.js',
  );
});

it('anchors the 9.8 shared entrypoint factory and inventories every native worker', () => {
  const source =
    'function runtimeProcessEntrypoint(modulePath) { return { currentModuleUrl: import.meta.url, sourceWorkerName: modulePath, distWorkerPath: modulePath + ".js" }; } const entries = { readonly: runtimeProcessEntrypoint("infra/sqlite-readonly-location.worker"), state: runtimeProcessEntrypoint("state/openclaw-state.worker"), memory: runtimeProcessEntrypoint("worker/memory-worker-entry") };';
  expect(hasStaleRuntimeWorkerImportMetaUrl(source)).toBe(true);
  const replacement =
    'new URL("./dist/runtime-process-entrypoints-native.mjs", "file:///runtime/gateway-bundle.mjs").href';
  const rewritten = rewriteRuntimeWorkerImportMetaUrls(source, replacement);
  expect(hasStaleRuntimeWorkerImportMetaUrl(rewritten)).toBe(false);
  expect(new Function(rewritten + '; return entries.readonly.currentModuleUrl;')()).toBe(
    'file:///runtime/dist/runtime-process-entrypoints-native.mjs',
  );
  expect(getRuntimeCompanionPathsReferencedByBundle(rewritten)).toEqual([
    'dist/infra/sqlite-readonly-location.worker.js',
    'dist/state/openclaw-state.worker.js',
    'dist/worker/memory-worker-entry.js',
  ]);
  expect(rewriteRuntimeWorkerImportMetaUrls(rewritten, replacement)).toBe(rewritten);
});
it.each(['facade-activation-check', 'plugin-metadata-readers', 'telegram-ingress-worker'])(
  'anchors the %s companion to its original module',
  name => {
    const source = 'new URL("./' + name + '.runtime.js", import.meta.url)';
    const rewritten = rewriteRuntimeWorkerImportMetaUrls(source, 'originalModuleUrl');
    expect(hasStaleRuntimeWorkerImportMetaUrl(source)).toBe(true);
    expect(hasStaleRuntimeWorkerImportMetaUrl(rewritten)).toBe(false);
    expect(rewritten).toContain(', originalModuleUrl)');
    expect(getRuntimeCompanionPathsReferencedByBundle(rewritten)).toContain(
      'dist/' + name + '.runtime.js',
    );
  },
);
it('preserves the source module for compile-cache self workers and lazy runtime imports', () => {
  const source =
    'new Worker(new URL(import.meta.url)); importRuntimeModule(import.meta.url, ["./subagent-registry.runtime", ".js"]);';
  const rewritten = rewriteRuntimeWorkerImportMetaUrls(source, 'originalModuleUrl');
  expect(hasStaleRuntimeWorkerImportMetaUrl(source)).toBe(true);
  expect(hasStaleRuntimeWorkerImportMetaUrl(rewritten)).toBe(false);
  expect(rewritten).toContain('new Worker(new URL(originalModuleUrl))');
  expect(rewritten).toContain('importRuntimeModule(originalModuleUrl,');
});
