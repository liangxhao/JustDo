'use strict';

const RUNTIME_COMPANION_CHECKS = [
  {
    marker: 'subagent-registry.runtime',
    path: 'dist/subagent-registry.runtime.js',
  },
  {
    marker: 'model-provider-auth.worker.js',
    path: 'dist/agents/model-provider-auth.worker.js',
  },
  {
    marker: 'compaction-planning.worker.js',
    path: 'dist/agents/compaction-planning.worker.js',
  },
  {
    marker: 'code-mode.worker.js',
    path: 'dist/agents/code-mode.worker.js',
  },
  {
    marker: 'audit-event-writer.worker.js',
    path: 'dist/audit/audit-event-writer.worker.js',
  },
  {
    marker: 'sqlite-readonly-location.worker.js',
    path: 'dist/infra/sqlite-readonly-location.worker.js',
  },
  {
    marker: 'service-child-relay.js',
    path: 'dist/process/supervisor/service-child-relay.js',
  },
  {
    marker: 'service-child-windows-job-anchor.js',
    path: 'dist/process/supervisor/service-child-windows-job-anchor.js',
  },
];

const STALE_RUNTIME_WORKER_URL_PATTERN =
  /resolveRuntimeWorkerUrl\(\s*\{\s*currentModuleUrl:\s*import\.meta\.url,/;

function rewriteRuntimeWorkerImportMetaUrls(source, replacement) {
  return source.replace(
    /resolveRuntimeWorkerUrl\(\s*\{\s*currentModuleUrl:\s*import\.meta\.url,/g,
    match => match.replace('import.meta.url', replacement),
  );
}

function hasStaleRuntimeWorkerImportMetaUrl(bundle) {
  return STALE_RUNTIME_WORKER_URL_PATTERN.test(bundle);
}

function getRuntimeCompanionPathsReferencedByBundle(bundle) {
  return RUNTIME_COMPANION_CHECKS.filter(({ marker }) => bundle.includes(marker)).map(
    ({ path: relativePath }) => relativePath,
  );
}

module.exports = {
  getRuntimeCompanionPathsReferencedByBundle,
  hasStaleRuntimeWorkerImportMetaUrl,
  rewriteRuntimeWorkerImportMetaUrls,
};
