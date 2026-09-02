'use strict';

/**
 * Download the pre-built openclaw npm package and prepare it as the Electron
 * runtime.  Replaces the old ensure + patch + build-from-source pipeline.
 *
 * Usage:
 *   node scripts/install-openclaw-runtime.cjs <target-id>
 *
 * Example:
 *   node scripts/install-openclaw-runtime.cjs win-x64
 */

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { patchOpenClawRuntime } = require('./patch-openclaw-runtime.cjs');
const { decideRuntimeInstall } = require('./openclaw-runtime-freeze.cjs');
const {
  assertNoActiveRuntimeDevLease,
  resolveRuntimeDevLeaseDir,
} = require('./openclaw-runtime-dev-lease.cjs');
const {
  commitStagedRuntime,
  prepareStagedRuntimeForCommit,
} = require('./openclaw-runtime-staging.cjs');
const { verifyPristineOpenClawContracts } = require('./verify-openclaw-pristine-contracts.cjs');
const {
  buildOpenClawBuildRecipeFingerprint,
  buildOpenClawPatchSetFingerprint,
  hashFile,
  INITIAL_BUNDLE_PENDING_FILENAME,
  readOpenClawSourceLock,
  verifyFrozenOpenClawRuntime,
} = require('./verify-openclaw-runtime-patches.cjs');

const RUNTIME_DEPENDENCY_LOCK_FILENAME = 'npm-shrinkwrap.json';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(message) {
  throw new Error(`[install-openclaw-runtime] ${message}`);
}

function runNpm(args, opts = {}) {
  const isWin = process.platform === 'win32';
  const command = isWin ? process.env.ComSpec || 'cmd.exe' : 'npm';
  const commandArgs = isWin ? ['/d', '/s', '/c', 'npm', ...args] : args;
  const result = spawnSync(command, commandArgs, {
    encoding: 'utf-8',
    stdio: opts.stdio || ['ignore', 'pipe', 'pipe'],
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    timeout: opts.timeout || 10 * 60 * 1000,
    windowsHide: true,
  });

  if (result.error) {
    throw new Error(`npm ${args.join(' ')} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new Error(
      `npm ${args.join(' ')} exited with code ${result.status}` + (stderr ? `\n${stderr}` : ''),
    );
  }

  return (result.stdout || '').trim();
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 1. Parse arguments and read config
// ---------------------------------------------------------------------------

const targetId = (process.argv[2] || '').trim();
if (!targetId) {
  fail('Missing target id. Usage: node scripts/install-openclaw-runtime.cjs <target-id>');
}

const rootDir = path.resolve(__dirname, '..');
const pkg = require(path.join(rootDir, 'package.json'));
const openclawVersion = (pkg.openclaw && pkg.openclaw.version) || '';
if (!openclawVersion) {
  fail('Missing "openclaw.version" in package.json.');
}

// Strip leading "v" for npm specifier (npm uses "2026.5.22", not "v2026.5.22").
const npmVersion = openclawVersion.replace(/^v/, '');
const npmSpec = `openclaw@${npmVersion}`;
const outDir = path.join(rootDir, 'vendor', 'openclaw-runtime', targetId);
const currentRuntimeDir = path.join(rootDir, 'vendor', 'openclaw-runtime', 'current');

const targetPlatform = targetId.split('-')[0];
const targetArch = targetId.split('-')[1];
if (!targetPlatform || !targetArch) {
  fail(`Invalid target id: ${targetId} (expected <platform>-<arch>, e.g. win-x64)`);
}

const platformMap = { mac: 'darwin', win: 'win32', linux: 'linux' };
const npmTargetPlatform = platformMap[targetPlatform];
if (!npmTargetPlatform) {
  fail(`Unsupported platform: ${targetPlatform}`);
}
if (!['x64', 'arm64', 'ia32'].includes(targetArch)) {
  fail(`Unsupported arch: ${targetArch}`);
}
assertNoActiveRuntimeDevLease(resolveRuntimeDevLeaseDir(rootDir));

console.log(
  `[install-openclaw-runtime] Target: ${targetId} (npm platform=${npmTargetPlatform}, arch=${targetArch})`,
);
console.log(`[install-openclaw-runtime] Package: ${npmSpec}`);

// ---------------------------------------------------------------------------
// 2. Build cache check
// ---------------------------------------------------------------------------

const installDecision = decideRuntimeInstall({
  forceInstall: process.env.OPENCLAW_FORCE_INSTALL === '1',
  targetExists: fs.existsSync(outDir),
});
if (installDecision === 'verify-frozen') {
  try {
    verifyFrozenOpenClawRuntime(outDir, { expectedTarget: targetId });
  } catch (error) {
    fail(
      `Existing runtime is incomplete or damaged; refusing to rebuild without ` +
        `OPENCLAW_FORCE_INSTALL=1. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  console.log(
    `[install-openclaw-runtime] Existing runtime is frozen (target=${targetId}), skipping reinstall and patches.`,
  );
  console.log(
    `[install-openclaw-runtime] Use OPENCLAW_FORCE_INSTALL=1 to rebuild from ${openclawVersion}.`,
  );
  process.exit(0);
}

const sourceLock = readOpenClawSourceLock(rootDir, openclawVersion);
const patchSetSha256 = buildOpenClawPatchSetFingerprint(rootDir, openclawVersion);
const buildRecipeSha256 = buildOpenClawBuildRecipeFingerprint(rootDir, openclawVersion);

// ---------------------------------------------------------------------------
// 3. Download npm tarball
// ---------------------------------------------------------------------------

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-install-'));
const packDir = path.join(tmpDir, 'pack');
const extractDir = path.join(tmpDir, 'extract');
const stagingOutDir = path.join(
  path.dirname(outDir),
  `.${path.basename(outDir)}.staging-${process.pid}-${Date.now()}`,
);
let commitCandidateDir = stagingOutDir;
fs.mkdirSync(packDir, { recursive: true });
fs.mkdirSync(extractDir, { recursive: true });

(async () => {
  try {
    console.log(`[install-openclaw-runtime] [1/8] Downloading ${npmSpec} from npm...`);
    runNpm(['pack', npmSpec, '--pack-destination', packDir]);

    const tarball = fs.readdirSync(packDir).find(f => f.endsWith('.tgz'));
    if (!tarball) {
      fail('npm pack did not produce a tarball.');
    }
    const tarballPath = path.join(packDir, tarball);
    const npmIntegrityRaw = runNpm(['view', npmSpec, 'dist.integrity', '--json']);
    const npmIntegrity = JSON.parse(npmIntegrityRaw);
    if (typeof npmIntegrity !== 'string' || !npmIntegrity.startsWith('sha512-')) {
      fail(`npm registry returned an invalid integrity for ${npmSpec}.`);
    }
    const npmTarballSha256 = hashFile(tarballPath);
    const localIntegrity = `sha512-${crypto
      .createHash('sha512')
      .update(fs.readFileSync(tarballPath))
      .digest('base64')}`;
    if (
      npmIntegrity !== sourceLock.integrity ||
      localIntegrity !== sourceLock.integrity ||
      npmTarballSha256 !== sourceLock.tarballSha256
    ) {
      fail(
        `npm source proof mismatch for ${npmSpec}; registry metadata, downloaded bytes, and source-lock.json must agree.`,
      );
    }
    console.log(`[install-openclaw-runtime] Downloaded: ${tarball}`);

    // ---------------------------------------------------------------------------
    // 4. Extract tarball
    // ---------------------------------------------------------------------------
    console.log(
      `[install-openclaw-runtime] [2/8] Extracting tarball and auditing pristine contracts...`,
    );
    const tar = require('tar');
    tar.x({ file: tarballPath, cwd: extractDir, sync: true });

    const pkgDir = path.join(extractDir, 'package');
    if (!fs.existsSync(pkgDir)) {
      fail('Extracted package directory not found.');
    }
    const extractedPackage = readJsonFile(path.join(pkgDir, 'package.json'));
    if (extractedPackage?.name !== 'openclaw' || extractedPackage?.version !== npmVersion) {
      fail(
        `Unexpected npm package identity: ${String(extractedPackage?.name)}@${String(
          extractedPackage?.version,
        )}; expected openclaw@${npmVersion}.`,
      );
    }
    const pristineAudit = verifyPristineOpenClawContracts(pkgDir, { repoRoot: rootDir });
    console.log(
      `[install-openclaw-runtime] Pristine contracts: ${Object.keys(pristineAudit.upstream).length} upstream, ` +
        `${pristineAudit.retainedGaps.length} retained gaps.`,
    );

    // ---------------------------------------------------------------------------
    // 5. Copy to output directory
    // ---------------------------------------------------------------------------
    console.log(`[install-openclaw-runtime] [3/8] Copying to staging runtime...`);
    fs.mkdirSync(path.dirname(outDir), { recursive: true });
    fs.cpSync(pkgDir, stagingOutDir, { recursive: true, force: true });

    // ---------------------------------------------------------------------------
    // 6. Patch facade-runtime JS dist (critical for esbuild bundling)
    // ---------------------------------------------------------------------------
    console.log(`[install-openclaw-runtime] [4/8] Patching facade-runtime for esbuild bundling...`);
    patchFacadeRuntime(stagingOutDir);

    // ---------------------------------------------------------------------------
    // 7. Patch compiled OpenClaw dist for JustDo integration
    // ---------------------------------------------------------------------------
    console.log(`[install-openclaw-runtime] [5/8] Patching OpenClaw integration...`);
    patchOpenClawRuntime(stagingOutDir, {
      label: 'install-openclaw-runtime',
      pristineInstallPass: true,
    });

    // ---------------------------------------------------------------------------
    // 8. Process skills
    // ---------------------------------------------------------------------------
    console.log(`[install-openclaw-runtime] [6/8] Processing skills...`);
    processSkills(rootDir, stagingOutDir);

    // ---------------------------------------------------------------------------
    // 9. Install production dependencies
    // ---------------------------------------------------------------------------
    console.log(`[install-openclaw-runtime] [7/8] Installing production dependencies...`);
    installProdDeps(
      stagingOutDir,
      npmTargetPlatform,
      targetArch,
      path.join(tmpDir, 'install-state'),
    );

    // ---------------------------------------------------------------------------
    // 10. Pack gateway.asar
    // ---------------------------------------------------------------------------
    console.log(`[install-openclaw-runtime] [8/8] Packing gateway.asar...`);
    await packGatewayAsar(rootDir, stagingOutDir);

    // ---------------------------------------------------------------------------
    // 11. Sanity checks
    // ---------------------------------------------------------------------------
    verifyRuntimeLayout(stagingOutDir);

    // ---------------------------------------------------------------------------
    // 12. Save runtime-build-info.json
    // ---------------------------------------------------------------------------
    const buildMeta = {
      builtAt: new Date().toISOString(),
      target: targetId,
      openclawVersion,
      installMethod: 'npm-package',
      npmPackageVersion: npmVersion,
      npmIntegrity,
      npmTarballSha256,
      patchSetSha256,
      buildRecipeSha256,
      gatewayAsarSha256: hashFile(path.join(stagingOutDir, 'gateway.asar')),
      runtimePackageSha256: hashFile(path.join(stagingOutDir, 'package.json')),
      runtimePackageLockPath: RUNTIME_DEPENDENCY_LOCK_FILENAME,
      runtimePackageLockSha256: hashFile(
        path.join(stagingOutDir, RUNTIME_DEPENDENCY_LOCK_FILENAME),
      ),
    };
    fs.writeFileSync(
      path.join(stagingOutDir, 'runtime-build-info.json'),
      JSON.stringify(buildMeta, null, 2) + '\n',
    );
    fs.writeFileSync(path.join(stagingOutDir, INITIAL_BUNDLE_PENDING_FILENAME), '', 'utf8');

    commitCandidateDir = prepareStagedRuntimeForCommit(stagingOutDir, outDir);
    verifyRuntimeLayout(commitCandidateDir);
    if (
      hashFile(path.join(commitCandidateDir, 'gateway.asar')) !== buildMeta.gatewayAsarSha256 ||
      hashFile(path.join(commitCandidateDir, 'package.json')) !== buildMeta.runtimePackageSha256 ||
      hashFile(path.join(commitCandidateDir, RUNTIME_DEPENDENCY_LOCK_FILENAME)) !==
        buildMeta.runtimePackageLockSha256
    ) {
      fail('Prepared runtime commit candidate does not match the staged source proof.');
    }
    commitStagedRuntime(commitCandidateDir, outDir, currentRuntimeDir);

    console.log(`[install-openclaw-runtime] Done. Runtime: ${outDir}`);
  } finally {
    // ---------------------------------------------------------------------------
    // 13. Cleanup
    // ---------------------------------------------------------------------------
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
    try {
      fs.rmSync(stagingOutDir, { recursive: true, force: true });
    } catch {}
    if (commitCandidateDir !== stagingOutDir) {
      try {
        fs.rmSync(commitCandidateDir, { recursive: true, force: true });
      } catch {}
    }
  }
})().catch(error => {
  console.error(error?.stack || String(error));
  process.exit(1);
});

// ===========================================================================
// Facade-runtime JS patch
// ===========================================================================

function patchFacadeRuntime(runtimeDir) {
  const distDir = path.join(runtimeDir, 'dist');
  if (!fs.existsSync(distDir)) {
    fail('dist/ directory not found in runtime.');
  }

  const facadeFiles = fs.readdirSync(distDir).filter(f => /^facade-runtime-.*\.js$/.test(f));
  if (facadeFiles.length !== 1) {
    throw new Error(
      `facade-runtime target count is ${facadeFiles.length}, expected 1: ${facadeFiles.join(', ')}`,
    );
  }

  const facadePath = path.join(distDir, facadeFiles[0]);
  let content = fs.readFileSync(facadePath, 'utf8');

  const staticImport =
    'import * as _facadeActivationCheckStatic from "./facade-activation-check.runtime.js";';
  const isFullyPatched =
    content.includes(staticImport) &&
    /function loadFacadeActivationCheckRuntime\(\)\s*\{\s*return _facadeActivationCheckStatic;\s*\}/.test(
      content,
    ) &&
    /async function loadFacadeActivationCheckRuntimeAsync\(\)\s*\{\s*return _facadeActivationCheckStatic;\s*\}/.test(
      content,
    ) &&
    !content.includes('createRequire(import.meta.url)') &&
    !content.includes('FACADE_ACTIVATION_CHECK_RUNTIME_CANDIDATES') &&
    !content.includes('getFacadeActivationCheckRuntimeModule') &&
    !content.includes('getCachedPluginSourceModuleLoader');
  if (isFullyPatched) {
    console.log('[install-openclaw-runtime] facade-runtime static loader already verified.');
    return;
  }

  // Only a pristine target is eligible. A partial or unknown facade must fail closed.
  if (!content.includes('createRequire(import.meta.url)')) {
    throw new Error(
      'facade-runtime is neither pristine nor completely patched; rebuild from the locked npm tarball.',
    );
  }
  if (!content.includes('FACADE_ACTIVATION_CHECK_RUNTIME_CANDIDATES')) {
    throw new Error(
      'facade-runtime pristine candidate loader anchor is missing; npm package structure changed.',
    );
  }

  const replaceRequired = (pattern, replacement, description) => {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const count = [...content.matchAll(new RegExp(pattern.source, flags))].length;
    if (count !== 1) throw new Error(`${description} count is ${count}, expected 1`);
    content = content.replace(pattern, replacement);
  };

  // 1. Remove imports that only support the runtime source-loader fallback.
  replaceRequired(
    /import\s*\{\s*createRequire\s*\}\s*from\s*"node:module";\s*\n?/,
    '',
    'facade createRequire import',
  );
  replaceRequired(
    /import\s*\{\s*[A-Za-z_$][\w$]*\s+as\s+getCachedPluginSourceModuleLoader\s*\}\s*from\s*"[^"]*plugin-module-loader-cache[^"]*";\s*\n?/g,
    '',
    'facade plugin source loader import',
  );
  replaceRequired(
    /import\s*\{\s*([A-Za-z_$][\w$]*\s+as\s+getPluginCacheRoot),\s*[A-Za-z_$][\w$]*\s+as\s+getPluginCacheSource\s*\}\s*from\s*("[^"]*plugin-cache[^"]*");/,
    'import { $1 } from $2;',
    'facade plugin cache import',
  );

  // 2. Add static import after the last existing import statement.
  const lastImportIdx = findLastImportEnd(content);
  if (lastImportIdx === 0) throw new Error('facade-runtime import boundary was not found');
  content = content.slice(0, lastImportIdx) + `\n${staticImport}` + content.slice(lastImportIdx);

  // 3. Remove dead code: variable declarations and helper functions.
  // Remove: const nodeRequire = createRequire(import.meta.url);
  replaceRequired(
    /const\s+nodeRequire\s*=\s*createRequire\(import\.meta\.url\);\s*\n?/g,
    '',
    'facade nodeRequire declaration',
  );

  // Remove: const FACADE_ACTIVATION_CHECK_RUNTIME_CANDIDATES = [...];
  replaceRequired(
    /const\s+FACADE_ACTIVATION_CHECK_RUNTIME_CANDIDATES\s*=\s*\[[\s\S]*?\];\s*\n?/g,
    '',
    'facade runtime candidates',
  );

  // Remove the v2026.8.1 plugin-cache accessors used only by the dynamic loader.
  replaceRequired(
    /function\s+getFacadeActivationCheckRuntimeModule\(\)\s*\{[\s\S]*?\n\}\n/,
    '',
    'facade dynamic module getter',
  );
  replaceRequired(
    /function\s+setFacadeActivationCheckRuntimeModule\([^)]*\)\s*\{[\s\S]*?\n\}\n/,
    '',
    'facade dynamic module setter',
  );

  // Remove: getFacadeActivationCheckRuntimeSourceLoader function
  replaceRequired(
    /function\s+getFacadeActivationCheckRuntimeSourceLoader\([\s\S]*?\n\}\n/g,
    '',
    'facade source loader helper',
  );

  // Remove: loadFacadeActivationCheckRuntimeFromCandidates function
  replaceRequired(
    /function\s+loadFacadeActivationCheckRuntimeFromCandidates\([\s\S]*?\n\}\n/g,
    '',
    'facade candidate loader helper',
  );

  // 4. Replace loadFacadeActivationCheckRuntime function body.
  replaceRequired(
    /function\s+loadFacadeActivationCheckRuntime\(\)\s*\{[\s\S]*?\n\}/,
    'function loadFacadeActivationCheckRuntime() {\n\treturn _facadeActivationCheckStatic;\n}',
    'facade synchronous loader',
  );
  replaceRequired(
    /async function\s+loadFacadeActivationCheckRuntimeAsync\(\)\s*\{[\s\S]*?\n\}/,
    'async function loadFacadeActivationCheckRuntimeAsync() {\n\treturn _facadeActivationCheckStatic;\n}',
    'facade asynchronous loader',
  );

  // 5. Make setFacadeActivationCheckRuntimeForTest a no-op (if present).
  content = content.replace(
    /function\s+setFacadeActivationCheckRuntimeForTest\([\s\S]*?\n\}/,
    'function setFacadeActivationCheckRuntimeForTest(_module) {\n\t// no-op: static import cannot be replaced at test time\n}',
  );

  // 6. Fix resetFacadeRuntimeStateForTest: keep only resetFacadeLoaderStateForTest().
  content = content.replace(
    /function\s+resetFacadeRuntimeStateForTest\(\)\s*\{[\s\S]*?\n\}/,
    'function resetFacadeRuntimeStateForTest() {\n\tresetFacadeLoaderStateForTest();\n}',
  );

  // Clean up any double blank lines left by removals.
  content = content.replace(/\n{3,}/g, '\n\n');

  if (
    !content.includes(staticImport) ||
    content.includes('createRequire(import.meta.url)') ||
    content.includes('FACADE_ACTIVATION_CHECK_RUNTIME_CANDIDATES') ||
    content.includes('getFacadeActivationCheckRuntimeModule') ||
    content.includes('getCachedPluginSourceModuleLoader')
  ) {
    throw new Error('facade-runtime static-loader verification failed before commit');
  }

  fs.writeFileSync(facadePath, content, 'utf8');
  console.log(`[install-openclaw-runtime] Patched: ${path.relative(runtimeDir, facadePath)}`);
}

function findLastImportEnd(content) {
  // Find the end of the last import statement (line ending with ;\n).
  const importRegex = /^import\s+[\s\S]*?;\s*$/gm;
  let lastIdx = 0;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    lastIdx = match.index + match[0].length;
  }
  return lastIdx;
}

// ===========================================================================
// Skills processing
// ===========================================================================

function processSkills(electronRoot, runtimeRoot) {
  const configPath = path.join(electronRoot, 'resources', 'builtin-skills.json');
  let config = { version: 1, skills: [], disableOpenClawDefaults: false };
  try {
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      console.log(`[install-openclaw-runtime] [skills] Loaded config from ${configPath}`);
    }
  } catch (error) {
    console.warn(
      `[install-openclaw-runtime] [skills] Failed to load builtin-skills.json: ${error.message}`,
    );
  }

  const runtimeSkillsDir = path.join(runtimeRoot, 'skills');
  const justDoSkillsDir = path.join(electronRoot, 'resources', 'skills');

  if (!fs.existsSync(runtimeSkillsDir)) {
    fs.mkdirSync(runtimeSkillsDir, { recursive: true });
  }

  if (config.disableOpenClawDefaults) {
    console.log('[install-openclaw-runtime] [skills] Deleting OpenClaw default skills...');
    const existingSkills = fs
      .readdirSync(runtimeSkillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
    for (const skillName of existingSkills) {
      fs.rmSync(path.join(runtimeSkillsDir, skillName), { recursive: true, force: true });
      console.log(`[install-openclaw-runtime] [skills] Deleted: ${skillName}`);
    }
  }

  for (const skillConfig of config.skills) {
    if (!skillConfig.enabled) {
      console.log(`[install-openclaw-runtime] [skills] Skipping disabled skill: ${skillConfig.id}`);
      continue;
    }
    const sourceDir = path.join(justDoSkillsDir, skillConfig.id);
    if (!fs.existsSync(sourceDir)) {
      console.warn(
        `[install-openclaw-runtime] [skills] Skill "${skillConfig.id}" not found in JustDo skills directory`,
      );
      continue;
    }
    fs.cpSync(sourceDir, path.join(runtimeSkillsDir, skillConfig.id), {
      recursive: true,
      force: true,
    });
    console.log(`[install-openclaw-runtime] [skills] Copied: ${skillConfig.id}`);
  }
}

// ===========================================================================
// Install production dependencies
// ===========================================================================

function installProdDeps(runtimeDir, npmPlatform, npmArch, isolatedStateDir) {
  // Remove existing node_modules and both npm lockfile forms. The v2026.8.1
  // package no longer ships npm-shrinkwrap.json, so the runtime build owns the
  // production dependency snapshot it later verifies and packages.
  const nmDir = path.join(runtimeDir, 'node_modules');
  if (fs.existsSync(nmDir)) fs.rmSync(nmDir, { recursive: true, force: true });
  for (const lockName of ['package-lock.json', RUNTIME_DEPENDENCY_LOCK_FILENAME]) {
    fs.rmSync(path.join(runtimeDir, lockName), { force: true });
  }
  fs.mkdirSync(isolatedStateDir, { recursive: true });

  // Remove devDependencies from package.json.
  const pkgPath = path.join(runtimeDir, 'package.json');
  const runtimePkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  delete runtimePkg.devDependencies;
  delete runtimePkg.packageManager;
  // @mistralai/mistralai declares its telemetry API as an optional peer even
  // though the ESM observability modules import it statically. The gateway
  // bundle reaches those modules, so the production runtime must carry the
  // peer rather than leaving an unresolved import for startup time.
  runtimePkg.dependencies = {
    ...runtimePkg.dependencies,
    '@opentelemetry/api': '^1.9.0',
  };
  fs.writeFileSync(pkgPath, JSON.stringify(runtimePkg, null, 2) + '\n');

  // Install production dependencies for the target platform.
  runNpm(
    [
      'install',
      '--omit=dev',
      '--package-lock=true',
      '--no-audit',
      '--no-fund',
      '--os',
      npmPlatform,
      '--cpu',
      npmArch,
    ],
    {
      cwd: runtimeDir,
      stdio: 'inherit',
      timeout: 10 * 60 * 1000,
      env: {
        OPENCLAW_STATE_DIR: isolatedStateDir,
        OPENCLAW_CONFIG_PATH: path.join(isolatedStateDir, 'openclaw.json'),
      },
    },
  );

  // Keep the historical runtime artifact name, but generate it from the exact
  // production install instead of relying on a lockfile bundled upstream.
  runNpm(['shrinkwrap'], {
    cwd: runtimeDir,
    stdio: 'inherit',
    timeout: 2 * 60 * 1000,
    env: {
      OPENCLAW_STATE_DIR: isolatedStateDir,
      OPENCLAW_CONFIG_PATH: path.join(isolatedStateDir, 'openclaw.json'),
    },
  });
  if (!fs.existsSync(path.join(runtimeDir, RUNTIME_DEPENDENCY_LOCK_FILENAME))) {
    fail('npm shrinkwrap did not produce the runtime dependency lock.');
  }
}

// ===========================================================================
// Pack gateway.asar
// ===========================================================================

async function packGatewayAsar(electronRoot, runtimeRoot) {
  const { createRequire } = require('module');
  const requireFromElectronRoot = createRequire(path.join(electronRoot, 'package.json'));
  const asar = requireFromElectronRoot('@electron/asar');

  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-gateway-asar-'));
  const stageRoot = path.join(stageDir, 'gateway');
  const gatewayAsarPath = path.join(runtimeRoot, 'gateway.asar');

  // Sanity checks before packing.
  if (!fs.existsSync(path.join(runtimeRoot, 'openclaw.mjs'))) {
    fail('openclaw.mjs not found before asar pack.');
  }
  if (!fs.existsSync(path.join(runtimeRoot, 'dist', 'control-ui', 'index.html'))) {
    fail('dist/control-ui/index.html not found before asar pack.');
  }
  const hasEntry =
    fs.existsSync(path.join(runtimeRoot, 'dist', 'entry.js')) ||
    fs.existsSync(path.join(runtimeRoot, 'dist', 'entry.mjs'));
  if (!hasEntry) {
    fail('dist/entry.js or dist/entry.mjs not found before asar pack.');
  }
  if (!fs.existsSync(path.join(runtimeRoot, 'node_modules'))) {
    fail('node_modules not found before asar pack.');
  }

  try {
    fs.mkdirSync(stageRoot, { recursive: true });

    // Copy openclaw.mjs and dist/ into staging.
    for (const name of ['openclaw.mjs', 'dist']) {
      const src = path.join(runtimeRoot, name);
      fs.cpSync(src, path.join(stageRoot, name), { recursive: true, force: true });
    }

    // Pack asar (async API).
    fs.rmSync(gatewayAsarPath, { force: true });
    await asar.createPackageWithOptions(stageRoot, gatewayAsarPath, {});

    // Validate asar contents.
    const entries = new Set(asar.listPackage(gatewayAsarPath).map(e => e.replace(/\\/g, '/')));
    const hasOpenClawEntry = entries.has('/openclaw.mjs');
    const hasControlUiIndex = entries.has('/dist/control-ui/index.html');
    const hasGatewayEntry = entries.has('/dist/entry.js') || entries.has('/dist/entry.mjs');
    if (!hasOpenClawEntry || !hasControlUiIndex || !hasGatewayEntry) {
      fail(
        `gateway.asar validation failed (openclaw.mjs=${hasOpenClawEntry}, control-ui=${hasControlUiIndex}, entry=${hasGatewayEntry}).`,
      );
    }

    // Remove unpacked files (keep dist/control-ui/ bare for static serving).
    fs.rmSync(path.join(runtimeRoot, 'openclaw.mjs'), { force: true });
    const distDir = path.join(runtimeRoot, 'dist');
    if (fs.existsSync(distDir)) {
      for (const entry of fs.readdirSync(distDir)) {
        if (entry === 'control-ui') continue;
        fs.rmSync(path.join(distDir, entry), { recursive: true, force: true });
      }
    }
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

// ===========================================================================
// Verify runtime layout
// ===========================================================================

function verifyRuntimeLayout(runtimeDir) {
  if (!fs.existsSync(path.join(runtimeDir, 'gateway.asar'))) {
    fail('gateway.asar missing after build.');
  }
  if (!fs.existsSync(path.join(runtimeDir, 'node_modules'))) {
    fail('node_modules missing after build.');
  }
  if (fs.existsSync(path.join(runtimeDir, 'openclaw.mjs'))) {
    fail('openclaw.mjs should be packed into gateway.asar, but unpacked file still exists.');
  }
  if (
    fs.existsSync(path.join(runtimeDir, 'dist', 'entry.js')) ||
    fs.existsSync(path.join(runtimeDir, 'dist', 'entry.mjs'))
  ) {
    fail('dist/entry.* should be packed into gateway.asar, but unpacked files still exist.');
  }
  if (!fs.existsSync(path.join(runtimeDir, 'dist', 'control-ui', 'index.html'))) {
    fail('dist/control-ui/index.html missing after asar packing.');
  }
}
