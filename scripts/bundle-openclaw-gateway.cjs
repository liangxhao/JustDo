'use strict';

/**
 * Bundle the openclaw gateway entry point into a single file using esbuild.
 *
 * This eliminates the expensive ESM module resolution overhead (~1100 files)
 * that causes Electron's utilityProcess to take 80-100s to start the gateway.
 * The single-file bundle loads in ~2-12s instead.
 *
 * Usage:
 *   node scripts/bundle-openclaw-gateway.cjs [runtime-dir]
 *
 * If runtime-dir is not specified, defaults to vendor/openclaw-runtime/current.
 */

const fs = require('fs');
const path = require('path');
const { patchOpenClawRuntime } = require('./patch-openclaw-runtime.cjs');
const { decideRuntimeBundle } = require('./openclaw-runtime-freeze.cjs');
const {
  getRuntimeCompanionPathsReferencedByBundle,
  hasStaleRuntimeWorkerImportMetaUrl,
  rewriteRuntimeWorkerImportMetaUrls,
} = require('./openclaw-runtime-companions.cjs');
const {
  INITIAL_BUNDLE_PENDING_FILENAME,
  verifyFrozenOpenClawRuntime,
  verifyOpenClawPatchManifest,
} = require('./verify-openclaw-runtime-patches.cjs');
const {
  ensureOpenClawGatewayBundleLauncher,
} = require('../src/main/openclaw/runtime/openclawGatewayBundleLauncher.cjs');

const rootDir = path.resolve(__dirname, '..');
const runtimeDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(rootDir, 'vendor', 'openclaw-runtime', 'current');

const bundleOutPath = path.join(runtimeDir, 'gateway-bundle.mjs');
const initialBundlePendingPath = path.join(runtimeDir, INITIAL_BUNDLE_PENDING_FILENAME);
const scriptPath = __filename;

function ensureGatewayLauncher() {
  const result = ensureOpenClawGatewayBundleLauncher(runtimeDir);
  if (result.changed) {
    console.log(
      `[bundle-openclaw-gateway] ${result.replaced ? 'Replaced' : 'Generated'} ` +
        `${path.relative(runtimeDir, result.launcherPath)}.`,
    );
  } else {
    console.log('[bundle-openclaw-gateway] Gateway launcher is up-to-date.');
  }
}

// Prefer gateway-entry.js (dedicated gateway entry, skips CLI overhead).
// Fall back to entry.js (full CLI entry) if gateway-entry.js doesn't exist.
const gatewayEntryPath = path.join(runtimeDir, 'dist', 'gateway-entry.js');
const fullEntryPath = path.join(runtimeDir, 'dist', 'entry.js');
const entryPath = fs.existsSync(gatewayEntryPath) ? gatewayEntryPath : fullEntryPath;

if (!fs.existsSync(entryPath)) {
  console.error(`[bundle-openclaw-gateway] Entry point not found: ${entryPath}`);
  console.error(`[bundle-openclaw-gateway] Make sure the openclaw runtime is built first.`);
  process.exit(1);
}

// An existing runtime is an explicit frozen development artifact. Rebuilding
// its gateway bundle would run the current patch set against it, so preserve
// the bundle unless the caller explicitly opted into a runtime reinstall.
const bundleDecision = decideRuntimeBundle({
  forceInstall: process.env.OPENCLAW_FORCE_INSTALL === '1',
  bundleExists: fs.existsSync(bundleOutPath),
  initialBundlePending: fs.existsSync(initialBundlePendingPath),
});
if (bundleDecision === 'verify-frozen') {
  try {
    verifyFrozenOpenClawRuntime(runtimeDir, { requireBundle: true });
  } catch (error) {
    console.error(
      `[bundle-openclaw-gateway] Existing runtime bundle is incomplete or damaged; ` +
        `use OPENCLAW_FORCE_INSTALL=1 to rebuild it. ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
  console.log('[bundle-openclaw-gateway] Existing runtime bundle is frozen, skipping rebuild.');
  console.log(
    '[bundle-openclaw-gateway] Use OPENCLAW_FORCE_INSTALL=1 to rebuild and apply patches.',
  );
  ensureGatewayLauncher();
  process.exit(0);
}
if (bundleDecision === 'reject') {
  console.error(
    '[bundle-openclaw-gateway] Existing runtime has no completed bundle; ' +
      'use OPENCLAW_FORCE_INSTALL=1 to rebuild it.',
  );
  process.exit(1);
}

// Consume the one-shot marker before starting so an interrupted or failed
// initial bundle cannot be retried and re-patched without explicit force.
fs.rmSync(initialBundlePendingPath, { force: true });

// Skip if bundle is already up-to-date (newer than the entry point).
if (fs.existsSync(bundleOutPath)) {
  const bundleStat = fs.statSync(bundleOutPath);
  const entryStat = fs.statSync(entryPath);
  const scriptStat = fs.statSync(scriptPath);
  if (bundleStat.mtimeMs > Math.max(entryStat.mtimeMs, scriptStat.mtimeMs)) {
    try {
      const manifest = verifyOpenClawPatchManifest(runtimeDir, { repoRoot: rootDir });
      console.log(`[bundle-openclaw-gateway] Bundle is up-to-date, skipping.`);
      console.log(
        `[bundle-openclaw-gateway] Patch manifest is current; skipped ${manifest.patches.length} patch(es).`,
      );
      ensureGatewayLauncher();
      process.exit(0);
    } catch (error) {
      console.log(
        `[bundle-openclaw-gateway] Bundle proof is stale or missing; rebuilding from source. ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

console.log(`[bundle-openclaw-gateway] Bundling: ${path.relative(runtimeDir, entryPath)}`);
console.log(`[bundle-openclaw-gateway] Output:   ${path.relative(runtimeDir, bundleOutPath)}`);

// Native addons and heavy optional deps that must NOT be bundled.
// These are resolved at runtime from node_modules/.
const EXTERNAL_PACKAGES = [
  // Native image processing
  'sharp',
  '@img/*',
  // Native terminal
  '@lydell/*',
  // Native clipboard
  '@mariozechner/*',
  // Native canvas
  '@napi-rs/*',
  // Native audio (davey)
  '@snazzah/*',
  // Native FFI
  'koffi',
  // Electron (provided by host)
  'electron',
  // LLM runtime (large, optional)
  'node-llama-cpp',
  // FFmpeg binary (large, optional)
  'ffmpeg-static',
  // Browser automation (large, optional)
  'chromium-bidi',
  'playwright-core',
  'playwright',
  // Native SQLite
  'better-sqlite3',
  // TypeScript runtime compiler — uses dynamic require("../dist/babel.cjs")
  // that esbuild can't rewrite correctly (resolves relative to bundle instead
  // of the original jiti module location).
  'jiti',
];

let esbuild;
try {
  esbuild = require('esbuild');
} catch {
  console.error('[bundle-openclaw-gateway] esbuild not found. Run: npm install --save-dev esbuild');
  process.exit(1);
}

const t0 = Date.now();

function toPosixPath(value) {
  return value.replace(/\\/g, '/');
}

function isPathInside(parentDir, candidatePath) {
  const relative = path.relative(parentDir, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function createRuntimeImportMetaUrlPlugin(openclawRuntimeDir) {
  const runtimeRoot = path.resolve(openclawRuntimeDir);
  const runtimeRoots = [runtimeRoot];

  try {
    const realRuntimeRoot = fs.realpathSync(runtimeRoot);
    if (!runtimeRoots.includes(realRuntimeRoot)) {
      runtimeRoots.push(realRuntimeRoot);
    }
  } catch {
    // The caller already validates runtime existence before bundling.
  }

  const runtimeRootCandidates = runtimeRoots.map(rootPath => ({
    runtimeRoot: rootPath,
    distRoot: path.join(rootPath, 'dist'),
  }));

  return {
    name: 'openclaw-runtime-import-meta-url',
    setup(build) {
      build.onLoad({ filter: /\.[cm]?js$/ }, args => {
        const filePath = path.resolve(args.path);
        const matchedRoot = runtimeRootCandidates.find(({ distRoot }) =>
          isPathInside(distRoot, filePath),
        );
        if (!matchedRoot) {
          return null;
        }

        const source = fs.readFileSync(filePath, 'utf8');
        if (!source.includes('import.meta.url')) {
          return null;
        }

        const runtimeRelativePath = `./${toPosixPath(path.relative(matchedRoot.runtimeRoot, filePath))}`;
        const replacement = `new URL(${JSON.stringify(runtimeRelativePath)}, import.meta.url).href`;
        let contents = source;

        contents = rewriteRuntimeWorkerImportMetaUrls(contents, replacement);
        contents = contents.replace(
          /importRuntimeModule\(\s*import\.meta\.url\s*,\s*SUBAGENT_REGISTRY_RUNTIME_SPEC\s*\)/g,
          `importRuntimeModule(${replacement}, SUBAGENT_REGISTRY_RUNTIME_SPEC)`,
        );
        contents = contents.replace(
          /resolveProviderAuthWarmWorkerUrl\(\s*import\.meta\.url\s*\)/g,
          `resolveProviderAuthWarmWorkerUrl(${replacement})`,
        );
        contents = contents.replace(
          /resolveCompactionPlanningWorkerUrl\(\s*currentModuleUrl\s*=\s*import\.meta\.url\s*\)/g,
          `resolveCompactionPlanningWorkerUrl(currentModuleUrl = ${replacement})`,
        );
        contents = contents.replace(
          /resolveCodeModeWorkerUrl\(\s*import\.meta\.url\s*\)/g,
          `resolveCodeModeWorkerUrl(${replacement})`,
        );
        contents = contents.replace(
          /resolveAuditEventWriterUrl\(\s*currentModuleUrl\s*=\s*import\.meta\.url\s*\)/g,
          `resolveAuditEventWriterUrl(currentModuleUrl = ${replacement})`,
        );

        if (contents === source) {
          return null;
        }

        return {
          contents,
          loader: 'js',
        };
      });
    },
  };
}

const STALE_RUNTIME_IMPORT_META_PATTERNS = [
  /importRuntimeModule\(\s*import\.meta\.url\s*,\s*SUBAGENT_REGISTRY_RUNTIME_SPEC\s*\)/,
  /resolveProviderAuthWarmWorkerUrl\(\s*import\.meta\.url\s*\)/,
  /resolveCompactionPlanningWorkerUrl\(\s*currentModuleUrl\s*=\s*import\.meta\.url\s*\)/,
  /resolveCodeModeWorkerUrl\(\s*import\.meta\.url\s*\)/,
  /resolveAuditEventWriterUrl\(\s*currentModuleUrl\s*=\s*import\.meta\.url\s*\)/,
];

function verifyBundledRuntimeCompanions(openclawRuntimeDir, bundledPath) {
  const bundle = fs.readFileSync(bundledPath, 'utf8');
  const stalePatterns = STALE_RUNTIME_IMPORT_META_PATTERNS.filter(pattern => pattern.test(bundle));

  if (stalePatterns.length > 0 || hasStaleRuntimeWorkerImportMetaUrl(bundle)) {
    throw new Error(
      'Bundled gateway still contains runtime-relative import.meta.url call sites. ' +
        'Update createRuntimeImportMetaUrlPlugin() before shipping this bundle.',
    );
  }

  const referencedCompanions = getRuntimeCompanionPathsReferencedByBundle(bundle);
  if (referencedCompanions.length === 0) {
    console.log(
      '[bundle-openclaw-gateway] No known runtime companion references found in bundle; ' +
        'assuming OpenClaw inlined or renamed them.',
    );
    return;
  }

  const missing = referencedCompanions.filter(
    relativePath => !fs.existsSync(path.join(openclawRuntimeDir, relativePath)),
  );

  if (missing.length > 0) {
    throw new Error(
      'Bundled gateway companion files referenced by the bundle are missing: ' + missing.join(', '),
    );
  }
}

esbuild
  .build({
    entryPoints: [entryPath],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: bundleOutPath,
    external: EXTERNAL_PACKAGES,
    // Inject createRequire so that esbuild's __require shim works in ESM context.
    // Without this, CJS modules (e.g. @smithy/*) that call require("buffer")
    // fail with "Dynamic require of X is not supported" when loaded via import().
    banner: {
      js:
        `import { createRequire as __bundleCreateRequire } from 'node:module';\n` +
        `import { fileURLToPath as __bundleFileURLToPath } from 'node:url';\n` +
        `const require = __bundleCreateRequire(import.meta.url);\n` +
        `const __filename = __bundleFileURLToPath(import.meta.url);\n` +
        `const __dirname = __bundleFileURLToPath(new URL('.', import.meta.url));\n`,
    },
    // Silence warnings about __dirname/__filename in ESM (they're polyfilled above).
    // Also silence the "ignored-bare-import" warning for packages like zod with sideEffects:false.
    logLevel: 'warning',
    logOverride: {
      'ignored-bare-import': 'silent',
      // v2026.8.1 compiles a spread override in PluginInstallRecordShape into
      // two literal `source` keys. The latter intentionally widens the union
      // with `marketplace`, so the generated-code warning is non-actionable.
      'duplicate-object-key': 'silent',
    },
    plugins: [createRuntimeImportMetaUrlPlugin(runtimeDir)],
  })
  .then(result => {
    verifyBundledRuntimeCompanions(runtimeDir, bundleOutPath);
    patchOpenClawRuntime(runtimeDir, {
      label: 'bundle-openclaw-gateway',
      freshBundlePass: true,
    });
    ensureGatewayLauncher();
    const elapsed = Date.now() - t0;
    const sizeKB = Math.round(fs.statSync(bundleOutPath).size / 1024);
    console.log(
      `[bundle-openclaw-gateway] Done in ${elapsed}ms (${sizeKB} KB)` +
        (result.warnings.length ? `, ${result.warnings.length} warnings` : ''),
    );
  })
  .catch(err => {
    console.error('[bundle-openclaw-gateway] esbuild failed:', err.message || err);
    process.exit(1);
  });
