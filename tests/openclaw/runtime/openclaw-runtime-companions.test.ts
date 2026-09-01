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

  it('requires every companion referenced by the v2026.8.1 bundle', () => {
    const bundle = `
      distWorkerPath: 'infra/sqlite-readonly-location.worker.js';
      distWorkerPath: 'agents/model-provider-auth.worker.js';
      distWorkerPath: 'process/supervisor/service-child-relay.js';
      distWorkerPath: 'process/supervisor/service-child-windows-job-anchor.js';
    `;

    expect(getRuntimeCompanionPathsReferencedByBundle(bundle)).toEqual([
      'dist/agents/model-provider-auth.worker.js',
      'dist/infra/sqlite-readonly-location.worker.js',
      'dist/process/supervisor/service-child-relay.js',
      'dist/process/supervisor/service-child-windows-job-anchor.js',
    ]);
  });
});
