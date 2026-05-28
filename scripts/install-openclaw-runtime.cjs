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
const fs = require('fs');
const os = require('os');
const path = require('path');
const { patchOpenClawThinkingStream } = require('./patch-openclaw-thinking-stream.cjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(message) {
  console.error(`[install-openclaw-runtime] ${message}`);
  process.exit(1);
}

function runNpm(args, opts = {}) {
  const isWin = process.platform === 'win32';
  const npmBin = isWin ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmBin, args, {
    encoding: 'utf-8',
    stdio: opts.stdio || ['ignore', 'pipe', 'pipe'],
    cwd: opts.cwd,
    shell: isWin,
    timeout: opts.timeout || 10 * 60 * 1000,
    windowsVerbatimArguments: isWin,
  });

  if (result.error) {
    throw new Error(`npm ${args.join(' ')} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    throw new Error(
      `npm ${args.join(' ')} exited with code ${result.status}` +
        (stderr ? `\n${stderr}` : ''),
    );
  }

  return (result.stdout || '').trim();
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
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

console.log(`[install-openclaw-runtime] Target: ${targetId} (npm platform=${npmTargetPlatform}, arch=${targetArch})`);
console.log(`[install-openclaw-runtime] Package: ${npmSpec}`);

// ---------------------------------------------------------------------------
// 2. Build cache check
// ---------------------------------------------------------------------------

if (process.env.OPENCLAW_FORCE_BUILD !== '1') {
  const buildInfo = readJsonFile(path.join(outDir, 'runtime-build-info.json'));
  if (buildInfo && buildInfo.openclawVersion === openclawVersion) {
    console.log(`[install-openclaw-runtime] Already installed ${openclawVersion} (target=${targetId}), skipping.`);
    console.log(`[install-openclaw-runtime] Use OPENCLAW_FORCE_BUILD=1 to force reinstall.`);
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// 3. Download npm tarball
// ---------------------------------------------------------------------------

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-install-'));
const packDir = path.join(tmpDir, 'pack');
const extractDir = path.join(tmpDir, 'extract');
fs.mkdirSync(packDir, { recursive: true });
fs.mkdirSync(extractDir, { recursive: true });

(async () => {
  try {
    console.log(`[install-openclaw-runtime] [1/7] Downloading ${npmSpec} from npm...`);
    runNpm(['pack', npmSpec, '--pack-destination', packDir]);

    const tarball = fs.readdirSync(packDir).find(f => f.endsWith('.tgz'));
    if (!tarball) {
      fail('npm pack did not produce a tarball.');
    }
    const tarballPath = path.join(packDir, tarball);
    console.log(`[install-openclaw-runtime] Downloaded: ${tarball}`);

    // ---------------------------------------------------------------------------
    // 4. Extract tarball
    // ---------------------------------------------------------------------------
    console.log(`[install-openclaw-runtime] [2/7] Extracting tarball...`);
    const tar = require('tar');
    tar.x({ file: tarballPath, cwd: extractDir, sync: true });

    const pkgDir = path.join(extractDir, 'package');
    if (!fs.existsSync(pkgDir)) {
      fail('Extracted package directory not found.');
    }

    // ---------------------------------------------------------------------------
    // 5. Copy to output directory
    // ---------------------------------------------------------------------------
    console.log(`[install-openclaw-runtime] [3/7] Copying to ${outDir}...`);
    if (fs.existsSync(outDir)) {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
    fs.mkdirSync(path.dirname(outDir), { recursive: true });
    fs.cpSync(pkgDir, outDir, { recursive: true, force: true });

    // ---------------------------------------------------------------------------
    // 6. Patch facade-runtime JS dist (critical for esbuild bundling)
    // ---------------------------------------------------------------------------
    console.log(`[install-openclaw-runtime] [4/7] Patching facade-runtime for esbuild bundling...`);
    patchFacadeRuntime(outDir);

    // ---------------------------------------------------------------------------
    // 7. Patch compiled OpenClaw dist for GucciAI integration
    // ---------------------------------------------------------------------------
    console.log(`[install-openclaw-runtime] [5/8] Patching thinking stream support...`);
    patchOpenClawThinkingStream(outDir, { label: 'install-openclaw-runtime' });

    // ---------------------------------------------------------------------------
    // 8. Process skills
    // ---------------------------------------------------------------------------
    console.log(`[install-openclaw-runtime] [6/8] Processing skills...`);
    processSkills(rootDir, outDir);

    // ---------------------------------------------------------------------------
    // 9. Install production dependencies
    // ---------------------------------------------------------------------------
    console.log(`[install-openclaw-runtime] [7/8] Installing production dependencies...`);
    installProdDeps(outDir, npmTargetPlatform, targetArch);

    // ---------------------------------------------------------------------------
    // 10. Pack gateway.asar
    // ---------------------------------------------------------------------------
    console.log(`[install-openclaw-runtime] [8/8] Packing gateway.asar...`);
    await packGatewayAsar(rootDir, outDir);

    // ---------------------------------------------------------------------------
    // 11. Sanity checks
    // ---------------------------------------------------------------------------
    verifyRuntimeLayout(outDir);

    // ---------------------------------------------------------------------------
    // 12. Save runtime-build-info.json
    // ---------------------------------------------------------------------------
    const buildMeta = {
      builtAt: new Date().toISOString(),
      target: targetId,
      openclawVersion,
      installMethod: 'npm-package',
      npmPackageVersion: npmVersion,
    };
    fs.writeFileSync(
      path.join(outDir, 'runtime-build-info.json'),
      JSON.stringify(buildMeta, null, 2) + '\n',
    );

    console.log(`[install-openclaw-runtime] Done. Runtime: ${outDir}`);
  } finally {
    // ---------------------------------------------------------------------------
    // 13. Cleanup
    // ---------------------------------------------------------------------------
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
})().catch((error) => {
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
  if (facadeFiles.length === 0) {
    fail('facade-runtime-*.js not found in dist/. The npm package structure may have changed.');
  }
  if (facadeFiles.length > 1) {
    console.warn(`[install-openclaw-runtime] Warning: Multiple facade-runtime files found: ${facadeFiles.join(', ')}`);
  }

  const facadePath = path.join(distDir, facadeFiles[0]);
  let content = fs.readFileSync(facadePath, 'utf8');

  // Verify the dynamic pattern exists (not already patched).
  if (!content.includes('createRequire(import.meta.url)')) {
    console.log(`[install-openclaw-runtime] facade-runtime already patched or pattern changed, skipping.`);
    return;
  }
  if (!content.includes('FACADE_ACTIVATION_CHECK_RUNTIME_CANDIDATES')) {
    console.warn(`[install-openclaw-runtime] Warning: FACADE_ACTIVATION_CHECK_RUNTIME_CANDIDATES not found. Pattern may have changed.`);
    return;
  }

  // 1. Remove unused imports.
  content = content.replace(
    /import\s*\{\s*createRequire\s*\}\s*from\s*"node:module";\s*\n?/g,
    '',
  );
  content = content.replace(
    /import\s*\{\s*r\s+as\s+getCachedPluginSourceModuleLoader\s*\}\s*from\s*"[^"]*plugin-module-loader-cache[^"]*";\s*\n?/g,
    '',
  );

  // 2. Add static import after the last existing import statement.
  const lastImportIdx = findLastImportEnd(content);
  const staticImport = 'import * as _facadeActivationCheckStatic from "./facade-activation-check.runtime.js";\n';
  content = content.slice(0, lastImportIdx) + staticImport + content.slice(lastImportIdx);

  // 3. Remove dead code: variable declarations and helper functions.
  // Remove: const nodeRequire = createRequire(import.meta.url);
  content = content.replace(
    /const\s+nodeRequire\s*=\s*createRequire\(import\.meta\.url\);\s*\n?/g,
    '',
  );

  // Remove: const FACADE_ACTIVATION_CHECK_RUNTIME_CANDIDATES = [...];
  content = content.replace(
    /const\s+FACADE_ACTIVATION_CHECK_RUNTIME_CANDIDATES\s*=\s*\[[\s\S]*?\];\s*\n?/g,
    '',
  );

  // Remove: let facadeActivationCheckRuntimeModule;
  content = content.replace(
    /let\s+facadeActivationCheckRuntimeModule;\s*\n?/g,
    '',
  );

  // Remove: const facadeActivationCheckRuntimeLoaders = /* @__PURE__ */ new Map();
  content = content.replace(
    /const\s+facadeActivationCheckRuntimeLoaders\s*=\s*\/\*\s*@__PURE__\s*\*\/\s*new\s+Map\(\);\s*\n?/g,
    '',
  );

  // Remove: getFacadeActivationCheckRuntimeSourceLoader function
  content = content.replace(
    /function\s+getFacadeActivationCheckRuntimeSourceLoader\([\s\S]*?\n\}\n/g,
    '',
  );

  // Remove: loadFacadeActivationCheckRuntimeFromCandidates function
  content = content.replace(
    /function\s+loadFacadeActivationCheckRuntimeFromCandidates\([\s\S]*?\n\}\n/g,
    '',
  );

  // 4. Replace loadFacadeActivationCheckRuntime function body.
  content = content.replace(
    /function\s+loadFacadeActivationCheckRuntime\(\)\s*\{[\s\S]*?\n\}/,
    'function loadFacadeActivationCheckRuntime() {\n\treturn _facadeActivationCheckStatic;\n}',
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
    console.warn(`[install-openclaw-runtime] [skills] Failed to load builtin-skills.json: ${error.message}`);
  }

  const runtimeSkillsDir = path.join(runtimeRoot, 'skills');
  const gucciAiSkillsDir = path.join(electronRoot, 'resources', 'skills');

  if (!fs.existsSync(runtimeSkillsDir)) {
    fs.mkdirSync(runtimeSkillsDir, { recursive: true });
  }

  if (config.disableOpenClawDefaults) {
    console.log('[install-openclaw-runtime] [skills] Deleting OpenClaw default skills...');
    const existingSkills = fs.readdirSync(runtimeSkillsDir, { withFileTypes: true })
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
    const sourceDir = path.join(gucciAiSkillsDir, skillConfig.id);
    if (!fs.existsSync(sourceDir)) {
      console.warn(`[install-openclaw-runtime] [skills] Skill "${skillConfig.id}" not found in GucciAI skills directory`);
      continue;
    }
    fs.cpSync(sourceDir, path.join(runtimeSkillsDir, skillConfig.id), { recursive: true, force: true });
    console.log(`[install-openclaw-runtime] [skills] Copied: ${skillConfig.id}`);
  }
}

// ===========================================================================
// Install production dependencies
// ===========================================================================

function installProdDeps(runtimeDir, npmPlatform, npmArch) {
  // Remove existing node_modules and lockfile.
  const nmDir = path.join(runtimeDir, 'node_modules');
  const lockFile = path.join(runtimeDir, 'package-lock.json');
  if (fs.existsSync(nmDir)) fs.rmSync(nmDir, { recursive: true, force: true });
  if (fs.existsSync(lockFile)) fs.rmSync(lockFile, { force: true });

  // Remove devDependencies from package.json.
  const pkgPath = path.join(runtimeDir, 'package.json');
  const runtimePkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  delete runtimePkg.devDependencies;
  fs.writeFileSync(pkgPath, JSON.stringify(runtimePkg, null, 2) + '\n');

  // Install production dependencies for the target platform.
  runNpm(['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: runtimeDir,
    stdio: 'inherit',
    timeout: 10 * 60 * 1000,
  });
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
