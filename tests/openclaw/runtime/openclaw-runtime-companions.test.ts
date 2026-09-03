import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  getRuntimeCompanionPathsReferencedByBundle,
  hasStaleRuntimeWorkerImportMetaUrl,
  rewriteRuntimeWorkerImportMetaUrls,
} = require('../../../scripts/openclaw-runtime-companions.cjs') as {
  getRuntimeCompanionPathsReferencedByBundle: (bundle: string) => string[];
  hasStaleRuntimeWorkerImportMetaUrl: (bundle: string) => boolean;
  rewriteRuntimeWorkerImportMetaUrls: (source: string, replacement: string) => string;
};

describe('OpenClaw runtime companions', () => {
  it('anchors the shared v2026.8.2 process entrypoints module to its dist location', () => {
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

  it('requires every companion referenced by the v2026.8.2 bundle', () => {
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
});
