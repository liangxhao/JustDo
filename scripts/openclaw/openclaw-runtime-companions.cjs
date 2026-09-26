'use strict';

const fs = require('fs');
const path = require('path');

const RUNTIME_COMPANION_CHECKS = [
  { marker: 'resolveStartupMigrationBuildIdentity', path: 'build-info.json' },
  { marker: 'legacy-config-binding-repair.runtime', path: 'dist/legacy-config-binding-repair.runtime.js' },
  {
    marker: 'node-host-launcher.mjs',
    path: 'node-host-launcher.mjs',
  },
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
    marker: 'code-mode-node.worker.js',
    path: 'dist/agents/code-mode-node.worker.js',
  },
  {
    marker: 'audit-event-writer.worker.js',
    path: 'dist/audit/audit-event-writer.worker.js',
  },
  {
    marker: 'openclaw-database-verify.worker.js',
    path: 'dist/state/openclaw-database-verify.worker.js',
  },
  {
    marker: 'sqlite-readonly-location.worker.js',
    path: 'dist/infra/sqlite-readonly-location.worker.js',
  },
  {
    marker: 'session-accessor.sqlite-archive.worker.js',
    path: 'dist/config/sessions/session-accessor.sqlite-archive.worker.js',
  },
  {
    marker: 'session-transcript-reconcile.worker.js',
    path: 'dist/config/sessions/session-transcript-reconcile.worker.js',
  },
  {
    marker: 'tailscale-route-owner.worker.js',
    path: 'dist/infra/tailscale-route-owner.worker.js',
  },
  {
    marker: 'service-child-relay.js',
    path: 'dist/process/supervisor/service-child-relay.js',
  },
  {
    marker: 'service-child-group-anchor.js',
    path: 'dist/process/supervisor/service-child-group-anchor.js',
  },
  {
    marker: 'service-child-windows-job-anchor.js',
    path: 'dist/process/supervisor/service-child-windows-job-anchor.js',
  },
  {
    marker: 'web-tree-sitter.wasm',
    path: 'web-tree-sitter.wasm',
  },
];

const RUNTIME_BUNDLED_ASSET_COPIES = [
  {
    // Native migration checkpoints resolve this beside their executing module.
    // The bundled module lives at the runtime root, outside the original dist/.
    marker: 'resolveStartupMigrationBuildIdentity',
    source: 'dist/build-info.json',
    target: 'build-info.json',
  },
  {
    marker: 'web-tree-sitter.wasm',
    source: 'node_modules/web-tree-sitter/web-tree-sitter.wasm',
    target: 'web-tree-sitter.wasm',
  },
];

const STALE_RUNTIME_WORKER_URL_PATTERNS = [
  /new URL\([^\n;]*["']\.\/legacy-config-binding-repair\.runtime\.js["'],\s*import\.meta\.url\)/,
  /new URL\(["']\.\.\/node-host-launcher\.mjs["'],\s*import\.meta\.url\)/,
  /resolveRuntimeWorkerUrl\(\s*\{\s*currentModuleUrl:\s*import\.meta\.url,/,
  /resolveDatabaseVerifyWorkerUrl\(\s*currentModuleUrl\s*=\s*import\.meta\.url\s*\)/,
  /(?:const\s+)?currentModuleUrl\s*=\s*import\.meta\.url;\s*(?:const\s+)?runtimeProcessEntrypoints\s*=/,
];

function rewriteRuntimeWorkerImportMetaUrls(source, replacement) {
  return source
    .replace(/new URL\(([^\n;]*["']\.\/legacy-config-binding-repair\.runtime\.js["']),\s*import\.meta\.url\)/g,
      (_match, args) => `new URL(${args}, ${replacement})`,
    )
    .replace(/new URL\((["'])\.\.\/node-host-launcher\.mjs\1,\s*import\.meta\.url\)/g,
      match => match.replace('import.meta.url', replacement),
    )
    .replace(/const currentModuleUrl\s*=\s*import\.meta\.url\s*;/g, match =>
      match.replace('import.meta.url', replacement),
    )
    .replace(/resolveRuntimeWorkerUrl\(\s*\{\s*currentModuleUrl:\s*import\.meta\.url,/g, match =>
      match.replace('import.meta.url', replacement),
    )
    .replace(
      /resolveDatabaseVerifyWorkerUrl\(\s*currentModuleUrl\s*=\s*import\.meta\.url\s*\)/g,
      match => match.replace('import.meta.url', replacement),
    );
}

function hasStaleRuntimeWorkerImportMetaUrl(bundle) {
  return STALE_RUNTIME_WORKER_URL_PATTERNS.some(pattern => pattern.test(bundle));
}

function getRuntimeCompanionPathsReferencedByBundle(bundle) {
  return RUNTIME_COMPANION_CHECKS.filter(({ marker }) => bundle.includes(marker)).map(
    ({ path: relativePath }) => relativePath,
  );
}

function syncRuntimeBundledAssets(runtimeRoot, bundle) {
  const copied = [];

  for (const asset of RUNTIME_BUNDLED_ASSET_COPIES) {
    if (!bundle.includes(asset.marker)) continue;

    const sourcePath = path.join(runtimeRoot, asset.source);
    const targetPath = path.join(runtimeRoot, asset.target);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(
        `Bundled runtime asset source is missing: ${asset.source} (required by ${asset.marker})`,
      );
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
    copied.push(asset.target);
  }

  return copied;
}

module.exports = {
  getRuntimeCompanionPathsReferencedByBundle,
  hasStaleRuntimeWorkerImportMetaUrl,
  rewriteRuntimeWorkerImportMetaUrls,
  syncRuntimeBundledAssets,
};
