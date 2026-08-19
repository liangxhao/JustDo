'use strict';

/**
 * Clean up unnecessary files from the OpenClaw runtime to reduce package size.
 *
 * Two strategies:
 * 1. Remove unnecessary files (.map, .d.ts, README, etc.) from all packages
 * 2. Replace large packages not needed at runtime with lightweight stubs
 *    (same approach as AutoClaw — import succeeds, actual calls throw in existing try-catch)
 */

const fs = require('fs');
const path = require('path');

const REMOVE_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 200,
};

function resolveRepoRoot() {
  return path.resolve(__dirname, '..');
}

function removeDirectory(dirPath) {
  fs.rmSync(dirPath, REMOVE_OPTIONS);
}

// ─── Strategy 1: File cleanup patterns ───

const PATTERNS_TO_DELETE = [
  // Source maps
  /\.map$/i,
  // TypeScript declarations
  /\.d\.ts$/i,
  /\.d\.cts$/i,
  /\.d\.mts$/i,
  // Documentation files
  /^readme(\.(md|txt|rst))?$/i,
  /^changelog(\.(md|txt|rst))?$/i,
  /^history(\.(md|txt|rst))?$/i,
  /^license(\.(md|txt))?$/i,
  /^licence(\.(md|txt))?$/i,
  /^authors(\.(md|txt))?$/i,
  /^contributors(\.(md|txt))?$/i,
  // Config files not needed at runtime
  /^\.eslintrc/i,
  /^\.prettierrc/i,
  /^\.editorconfig$/i,
  /^\.npmignore$/i,
  /^\.gitignore$/i,
  /^\.gitattributes$/i,
  /^tsconfig(\..+)?\.json$/i,
  /^jest\.config/i,
  /^vitest\.config/i,
  /^\.babelrc/i,
  /^babel\.config/i,
  // Test files
  /\.test\.\w+$/i,
  /\.spec\.\w+$/i,
];

const DIRS_TO_DELETE = new Set([
  'test',
  'tests',
  '__tests__',
  '__mocks__',
  '.github',
  'example',
  'examples',
  'coverage',
]);

// ─── Strategy 2: Stub replacements ───
// Packages not needed in headless gateway mode, replaced with lightweight stubs.
// The stub allows require/import to succeed but throws when actually called.
// Callers already have try-catch protection.

const PACKAGES_TO_STUB = [
  'koffi',            // Windows FFI for terminal PTY — not needed in gateway mode
];

const GENERIC_STUB_INDEX_CJS = `// Stub (CJS): this package is not needed for headless gateway operation.
module.exports = new Proxy({}, {
  get(_, prop) {
    if (prop === '__esModule') return false;
    if (prop === 'default') return module.exports;
    if (prop === 'then') return undefined;
    return function() {
      throw new Error(require('./package.json').name + ' is not available in this build');
    };
  }
});
`;

const GENERIC_STUB_INDEX_ESM = `// Stub (ESM): this package is not needed for headless gateway operation.
const handler = {
  get(_, prop) {
    if (prop === 'then') return undefined;
    return function() {
      throw new Error('This package is not available in this build (stub)');
    };
  }
};
const stub = new Proxy({}, handler);
export default stub;
export const chromium = stub;
export const devices = stub;
export const firefox = stub;
export const webkit = stub;
export const getDocument = stub;
export const version = '0.0.0-stub';
`;

function stubPackage(pkgDir, pkgName, stats) {
  if (!fs.existsSync(pkgDir)) return;

  // Read original version for the stub package.json
  let version = '0.0.0-stub';
  try {
    const origPkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    version = origPkg.version || version;
  } catch { /* ignore */ }

  // Remove all contents
  removeDirectory(pkgDir);
  fs.mkdirSync(pkgDir, { recursive: true });

  // Write dual CJS + ESM stub files
  fs.writeFileSync(path.join(pkgDir, 'index.js'), GENERIC_STUB_INDEX_CJS, 'utf8');
  fs.writeFileSync(path.join(pkgDir, 'index.mjs'), GENERIC_STUB_INDEX_ESM, 'utf8');
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
    name: pkgName,
    version,
    main: 'index.js',
    exports: {
      '.': {
        import: './index.mjs',
        require: './index.js',
        default: './index.js',
      },
    },
  }, null, 2) + '\n', 'utf8');

  stats.stubbed.push(pkgName);
}

// ─── File cleanup ───

function shouldDeleteFile(filename) {
  return PATTERNS_TO_DELETE.some((pattern) => pattern.test(filename));
}

function cleanDir(dirPath, stats) {
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      if (DIRS_TO_DELETE.has(entry.name.toLowerCase())) {
        removeDirectory(fullPath);
        stats.dirsRemoved++;
        continue;
      }
      cleanDir(fullPath, stats);
      // Remove empty directories
      try {
        const remaining = fs.readdirSync(fullPath);
        if (remaining.length === 0) {
          fs.rmdirSync(fullPath);
        }
      } catch { /* ignore */ }
    } else if (entry.isFile() && shouldDeleteFile(entry.name)) {
      try {
        const size = fs.statSync(fullPath).size;
        fs.unlinkSync(fullPath);
        stats.filesRemoved++;
        stats.bytesFreed += size;
      } catch { /* ignore */ }
    }
  }
}

// ─── Extension pruning policy ───

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function listLocalExtensionIds(repoRoot) {
  const sourceDir = path.join(repoRoot, 'openclaw-extensions');
  if (!fs.existsSync(sourceDir)) {
    return [];
  }

  return fs
    .readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function loadExtensionPrunePolicy(repoRoot) {
  const policyPath = path.join(repoRoot, 'resources', 'openclaw-extension-prune.json');
  if (!fs.existsSync(policyPath)) {
    return { policyPath, keep: [], protected: [] };
  }

  const policy = readJson(policyPath);
  if (!Array.isArray(policy.keep)) {
    throw new Error(`Invalid extension prune policy, "keep" must be an array: ${policyPath}`);
  }
  if (!Array.isArray(policy.remove)) {
    throw new Error(`Invalid extension prune policy, "remove" must be an array: ${policyPath}`);
  }

  const remove = policy.remove.flatMap((group, index) => {
    if (!group || !Array.isArray(group.extensions)) {
      throw new Error(
        `Invalid extension prune policy, "remove[${index}].extensions" must be an array: ${policyPath}`,
      );
    }
    return group.extensions;
  });
  const invalidIds = [...policy.keep, ...remove].filter(
    extensionId => typeof extensionId !== 'string' || extensionId.trim().length === 0,
  );
  if (invalidIds.length > 0) {
    throw new Error(
      `Invalid extension prune policy, extension ids must be non-empty strings: ${policyPath}`,
    );
  }

  const duplicates = [...policy.keep, ...remove].filter(
    (extensionId, index, extensionIds) => extensionIds.indexOf(extensionId) !== index,
  );
  if (duplicates.length > 0) {
    throw new Error(
      `Invalid extension prune policy, duplicate extension ids: ${[...new Set(duplicates)].join(', ')}`,
    );
  }

  return {
    policyPath,
    keep: policy.keep,
    remove,
    protected: listLocalExtensionIds(repoRoot),
  };
}

function pruneRuntimeExtensions(runtimeRoot, stats, options = {}) {
  const repoRoot = options.repoRoot || resolveRepoRoot();
  const label = options.label || 'prune-openclaw-runtime';
  const extensionsDir = path.join(runtimeRoot, 'dist', 'extensions');
  if (!fs.existsSync(extensionsDir)) {
    return;
  }

  const policy = loadExtensionPrunePolicy(repoRoot);
  if (policy.keep.length === 0) {
    console.log(`[${label}] No extension keep policy found, skipping extension directory pruning.`);
    return { kept: [], protected: [], removed: [] };
  }

  const keep = new Set([...policy.keep, ...policy.protected]);
  const reviewed = new Set([...policy.keep, ...policy.remove, ...policy.protected]);
  const removed = [];
  const protectedKept = [];
  const entries = fs.readdirSync(extensionsDir, { withFileTypes: true });
  const unknown = entries
    .filter(entry => entry.isDirectory() && !reviewed.has(entry.name))
    .map(entry => entry.name)
    .sort();

  if (unknown.length > 0) {
    throw new Error(
      `Unreviewed OpenClaw extension dirs found: ${unknown.join(', ')}. ` +
        `Update ${policy.policyPath} before pruning this runtime.`,
    );
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (keep.has(entry.name)) {
      if (policy.protected.includes(entry.name) && !policy.keep.includes(entry.name)) {
        protectedKept.push(entry.name);
      }
      continue;
    }

    const fullPath = path.join(extensionsDir, entry.name);
    const size = getDirectorySize(fullPath);
    removeDirectory(fullPath);
    removed.push(entry.name);
    stats.extensionDirsRemoved++;
    stats.bytesFreed += size;
  }

  console.log(
    `[${label}] Extension keep policy: kept ${policy.keep.length} OpenClaw-managed extensions`
      + (protectedKept.length > 0 ? `, protected local extensions: ${protectedKept.join(', ')}` : ''),
  );
  console.log(
    `[${label}] Removed ${removed.length} extension dirs`
      + (removed.length > 0 ? `: ${removed.join(', ')}` : ''),
  );

  return { kept: policy.keep, protected: protectedKept, removed };
}

function getDirectorySize(dirPath) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    try {
      if (entry.isDirectory()) {
        total += getDirectorySize(fullPath);
      } else if (entry.isFile()) {
        total += fs.statSync(fullPath).size;
      }
    } catch { /* ignore */ }
  }

  return total;
}

function logSummary(stats) {
  const mbFreed = (stats.bytesFreed / 1024 / 1024).toFixed(1);
  console.log(
    `[prune-openclaw-runtime] Stubbed: ${stats.stubbed.length > 0 ? stats.stubbed.join(', ') : 'none'}`
  );
  console.log(
    `[prune-openclaw-runtime] Removed ${stats.filesRemoved} files, ${stats.dirsRemoved} dirs, `
      + `${stats.extensionDirsRemoved} extension dirs, freed ${mbFreed} MB`
  );
}

// ─── Main ───

function main() {
  const runtimeRoot = process.argv[2]
    || path.join(__dirname, '..', 'vendor', 'openclaw-runtime', 'current');

  if (!fs.existsSync(runtimeRoot)) {
    console.error(`[prune-openclaw-runtime] Runtime root not found: ${runtimeRoot}`);
    process.exit(1);
  }

  console.log(`[prune-openclaw-runtime] Cleaning ${runtimeRoot} ...`);

  const stats = { filesRemoved: 0, dirsRemoved: 0, extensionDirsRemoved: 0, bytesFreed: 0, stubbed: [] };

  const nodeModulesDir = path.join(runtimeRoot, 'node_modules');
  if (!fs.existsSync(nodeModulesDir)) {
    console.log('[prune-openclaw-runtime] No node_modules found, skipping node_modules cleanup.');
    logSummary(stats);
    return;
  }

  // Step 1: Replace large unnecessary packages with stubs
  for (const pkgName of PACKAGES_TO_STUB) {
    stubPackage(path.join(nodeModulesDir, pkgName), pkgName, stats);
  }

  // Step 1b: Remove broken .bin symlinks left behind by stubbed packages
  const binDir = path.join(nodeModulesDir, '.bin');
  if (fs.existsSync(binDir)) {
    try {
      for (const entry of fs.readdirSync(binDir)) {
        const linkPath = path.join(binDir, entry);
        try {
          fs.statSync(linkPath); // follows symlink — throws if target is missing
        } catch {
          fs.unlinkSync(linkPath);
          stats.filesRemoved++;
        }
      }
    } catch { /* ignore */ }
  }

  // Step 2: Clean unnecessary files from node_modules only
  cleanDir(nodeModulesDir, stats);

  // Step 3: Clean node_modules inside extensions (but not extension source files)
  const extensionsDir = path.join(runtimeRoot, 'dist', 'extensions');
  if (fs.existsSync(extensionsDir)) {
    try {
      for (const ext of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
        if (!ext.isDirectory()) continue;
        const extNodeModules = path.join(extensionsDir, ext.name, 'node_modules');
        if (fs.existsSync(extNodeModules)) {
          cleanDir(extNodeModules, stats);
        }
      }
    } catch { /* ignore */ }
  }

  logSummary(stats);
}

if (require.main === module) {
  main();
}

module.exports = {
  pruneRuntimeExtensions,
};
