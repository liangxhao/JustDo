'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  pruneExtensionDependencies,
  pruneRuntimeExtensions,
} = require('./prune-openclaw-runtime.cjs');

function resolveRepoRoot() {
  return path.resolve(__dirname, '../..');
}

function syncDocTemplates(repoRoot, runtimeRoot, label) {
  const sourceDir = path.join(repoRoot, 'resources', 'docs', 'reference', 'templates');
  const targetDir = path.join(runtimeRoot, 'docs', 'reference', 'templates');

  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Template source not found: ${sourceDir}`);
  }

  fs.mkdirSync(targetDir, { recursive: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true, force: true });

  const copiedFiles = fs
    .readdirSync(targetDir, { withFileTypes: true })
    .filter(entry => entry.isFile()).length;

  console.log(
    `[${label}] Synced OpenClaw doc templates: ` +
      `${path.relative(repoRoot, sourceDir)} -> ${path.relative(repoRoot, targetDir)} ` +
      `(${copiedFiles} files)`,
  );

  return { sourceDir, targetDir, copiedFiles };
}

function syncDocChannels(repoRoot, runtimeRoot, label) {
  const sourceDir = path.join(repoRoot, 'resources', 'docs', 'channels');
  const targetDir = path.join(runtimeRoot, 'docs', 'channels');

  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Channel source not found: ${sourceDir}`);
  }

  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true, force: true });

  const copiedFiles = fs
    .readdirSync(targetDir, { withFileTypes: true, recursive: true })
    .filter(entry => entry.isFile()).length;

  console.log(
    `[${label}] Replaced OpenClaw doc channels: ` +
      `${path.relative(repoRoot, sourceDir)} -> ${path.relative(repoRoot, targetDir)} ` +
      `(${copiedFiles} files)`,
  );

  return { sourceDir, targetDir, copiedFiles };
}

function syncGatewayConfigChannels(repoRoot, runtimeRoot, label) {
  const sourceFile = path.join(repoRoot, 'resources', 'docs', 'gateway', 'config-channels.md');
  const targetFile = path.join(runtimeRoot, 'docs', 'gateway', 'config-channels.md');

  if (!fs.existsSync(sourceFile)) {
    throw new Error(`Gateway channel config source not found: ${sourceFile}`);
  }

  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.copyFileSync(sourceFile, targetFile);

  console.log(
    `[${label}] Replaced OpenClaw gateway channel config: ` +
      `${path.relative(repoRoot, sourceFile)} -> ${path.relative(repoRoot, targetFile)}`,
  );

  return { sourceFile, targetFile };
}

function hasProductionDependencies(extensionDir) {
  const packagePath = path.join(extensionDir, 'package.json');
  if (!fs.existsSync(packagePath)) {
    return false;
  }

  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  return Boolean(packageJson.dependencies && Object.keys(packageJson.dependencies).length > 0);
}

const EXTENSION_ASSEMBLY_MANIFEST = '.justdo-extension-assembly.json';
const EXTENSION_ASSEMBLY_VERSION = 2;
const DEFAULT_EXTENSION_NPM_CI_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_EXTENSION_NPM_CI_TIMEOUT_MS = 60 * 60 * 1000;
const EXTENSION_RENAME_MAX_RETRIES = 5;
const EXTENSION_RENAME_RETRY_DELAY_MS = 200;
const RETRYABLE_RENAME_ERROR_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);

function sleepSync(delayMs) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

function renameExtensionIntoPlace(sourceDir, targetDir, options = {}) {
  const rename = options.rename || fs.renameSync;
  const sleep = options.sleep || sleepSync;
  const maxRetries = options.maxRetries ?? EXTENSION_RENAME_MAX_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? EXTENSION_RENAME_RETRY_DELAY_MS;

  for (let attempt = 0; ; attempt += 1) {
    try {
      rename(sourceDir, targetDir);
      return;
    } catch (error) {
      const isRetryable = RETRYABLE_RENAME_ERROR_CODES.has(error?.code);
      if (!isRetryable) {
        throw error;
      }
      if (attempt >= maxRetries) {
        // Windows scanners can deny renaming a freshly copied directory while
        // still allowing its files to be read. Claim an absent destination;
        // never merge with an existing extension or suppress copy failures.
        try {
          fs.mkdirSync(targetDir);
        } catch {
          throw error;
        }
        try {
          fs.cpSync(sourceDir, targetDir, {
            recursive: true,
            force: false,
            errorOnExist: true,
            verbatimSymlinks: true,
          });
        } catch (copyError) {
          throw new Error(
            `Extension rename and copy fallback failed: ${sourceDir} -> ${targetDir}. ` +
              `Rename: ${error.message}. Copy: ${copyError.message}`,
            { cause: copyError },
          );
        }
        return;
      }
      sleep(retryDelayMs);
    }
  }
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function resolveRuntimeInstallTarget(runtimeRoot) {
  const buildInfo = readJsonFile(path.join(runtimeRoot, 'runtime-build-info.json'));
  const targetId = typeof buildInfo?.target === 'string' ? buildInfo.target : null;
  const targets = {
    'win-x64': { targetId: 'win-x64', os: 'win32', cpu: 'x64' },
    'win-arm64': { targetId: 'win-arm64', os: 'win32', cpu: 'arm64' },
    'mac-x64': { targetId: 'mac-x64', os: 'darwin', cpu: 'x64' },
    'mac-arm64': { targetId: 'mac-arm64', os: 'darwin', cpu: 'arm64' },
    'linux-x64': { targetId: 'linux-x64', os: 'linux', cpu: 'x64', libc: 'glibc' },
    'linux-arm64': { targetId: 'linux-arm64', os: 'linux', cpu: 'arm64', libc: 'glibc' },
  };
  const target = targetId ? targets[targetId] : null;
  if (!target) {
    throw new Error(
      `Unsupported or missing OpenClaw runtime target in ${path.join(runtimeRoot, 'runtime-build-info.json')}`,
    );
  }
  return target;
}

function dependencyFingerprint(extensionDir, installTarget) {
  const packagePath = path.join(extensionDir, 'package.json');
  const lockPath = path.join(extensionDir, 'package-lock.json');
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(packagePath))
    .update(fs.readFileSync(lockPath))
    .update(JSON.stringify(installTarget))
    .digest('hex');
}

function resolveExtensionInstallTimeoutMs(env = process.env) {
  const configured = env.JUSTDO_EXTENSION_NPM_CI_TIMEOUT_MS;
  if (configured === undefined || configured.trim() === '') {
    return DEFAULT_EXTENSION_NPM_CI_TIMEOUT_MS;
  }
  const timeoutMs = Number(configured);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 60_000 ||
    timeoutMs > MAX_EXTENSION_NPM_CI_TIMEOUT_MS
  ) {
    throw new Error('JUSTDO_EXTENSION_NPM_CI_TIMEOUT_MS must be an integer from 60000 to 3600000');
  }
  return timeoutMs;
}

function installProductionDependencies(extensionDir, installTarget) {
  const lockPath = path.join(extensionDir, 'package-lock.json');
  if (!fs.existsSync(lockPath)) {
    throw new Error(
      `Local extension with production dependencies must include package-lock.json: ${extensionDir}`,
    );
  }

  const isWindows = process.platform === 'win32';
  const npmCommand = isWindows ? process.env.ComSpec || 'cmd.exe' : 'npm';
  const npmArgs = [
    'ci',
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--os',
    installTarget.os,
    '--cpu',
    installTarget.cpu,
    ...(installTarget.libc ? ['--libc', installTarget.libc] : []),
  ];
  const result = spawnSync(
    npmCommand,
    isWindows ? ['/d', '/s', '/c', 'npm', ...npmArgs] : npmArgs,
    {
      cwd: extensionDir,
      env: process.env,
      stdio: 'inherit',
      timeout: resolveExtensionInstallTimeoutMs(),
      windowsHide: true,
    },
  );
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      throw new Error(
        `Timed out installing production dependencies for ${extensionDir} ` +
          `target ${installTarget.targetId} after ${resolveExtensionInstallTimeoutMs()}ms`,
      );
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Failed to install production dependencies for ${extensionDir} (exit ${result.status})`,
    );
  }
}

function verifyDeclaredDependencies(extensionDir) {
  const manifest = readJsonFile(path.join(extensionDir, 'package.json'));
  const dependencies = Object.keys(manifest?.dependencies || {});
  const missing = dependencies.filter(packageName => {
    const packageDir = path.join(extensionDir, 'node_modules', ...packageName.split('/'));
    return !readJsonFile(path.join(packageDir, 'package.json'));
  });
  if (missing.length > 0) {
    throw new Error(`Extension dependencies are incomplete. Missing: ${missing.join(', ')}`);
  }
}

function verifyAcpxTargetDependencies(extensionDir, installTarget) {
  const manifest = readJsonFile(path.join(extensionDir, 'package.json'));
  if (manifest?.name !== 'acpx-runtime') return;
  const dependencies = manifest.dependencies || {};
  const includesClaudeAdapter = Boolean(dependencies['@agentclientprotocol/claude-agent-acp']);
  const includesCodexAdapter = Boolean(dependencies['@agentclientprotocol/codex-acp']);

  const modulesDir = path.join(extensionDir, 'node_modules');
  const entries = [];
  for (const scope of ['@openai', '@anthropic-ai']) {
    const scopeDir = path.join(modulesDir, scope);
    if (fs.existsSync(scopeDir)) {
      entries.push(...fs.readdirSync(scopeDir).map(name => scope + '/' + name));
    }
  }
  require('../../openclaw-extensions/acpx/scripts/runtime-dependencies.cjs')
    .verifyExternalAgentPackages(entries);

  const requiredEntries = [
    ...(dependencies.acpx
      ? [
          [
            'acpx/dist/runtime.js',
            path.join(extensionDir, 'node_modules', 'acpx', 'dist', 'runtime.js'),
          ],
        ]
      : []),
    ...(includesClaudeAdapter
      ? [
          [
            'claude-agent-acp/dist/index.js',
            path.join(
              extensionDir,
              'node_modules',
              '@agentclientprotocol',
              'claude-agent-acp',
              'dist',
              'index.js',
            ),
          ],
        ]
      : []),
    ...(includesCodexAdapter
      ? [
          [
            'codex-acp/dist/index.js',
            path.join(
              extensionDir,
              'node_modules',
              '@agentclientprotocol',
              'codex-acp',
              'dist',
              'index.js',
            ),
          ],
        ]
      : []),
  ];
  const missingEntries = requiredEntries
    .filter(([, entryPath]) => !fs.existsSync(entryPath))
    .map(([label]) => label);
  if (missingEntries.length > 0) {
    throw new Error(`ACPX dependency payload is incomplete. Missing: ${missingEntries.join(', ')}`);
  }
}

function replaceExtensionSources(sourceDir, targetDir) {
  for (const entry of fs.readdirSync(targetDir)) {
    if (entry === 'node_modules' || entry === EXTENSION_ASSEMBLY_MANIFEST) continue;
    fs.rmSync(path.join(targetDir, entry), { recursive: true, force: true });
  }
  for (const entry of fs.readdirSync(sourceDir)) {
    if (entry === 'node_modules') continue;
    fs.cpSync(path.join(sourceDir, entry), path.join(targetDir, entry), {
      recursive: true,
      force: true,
      verbatimSymlinks: true,
    });
  }
}

function cleanInterruptedExtensionStaging(targetDir) {
  if (!fs.existsSync(targetDir)) return;
  for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('.justdo-extension-')) {
      fs.rmSync(path.join(targetDir, entry.name), { recursive: true, force: true });
    }
  }
}

// App extensions may import pure product contracts. Bundle from the repository
// before staging so packaged plugins never resolve ../../src against OpenClaw.
function bundleProductExtension(sourceDir, targetDir) {
  const pkg = readJsonFile(path.join(sourceDir, 'package.json'));
  if (pkg?.justdo?.bundle !== true) return;
  const entries = pkg.openclaw?.extensions;
  if (!Array.isArray(entries) || entries.length !== 1)
    throw new Error('Bundled product extension must have one entry');
  require('esbuild').buildSync({
    entryPoints: [path.resolve(sourceDir, entries[0])],
    outfile: path.join(targetDir, 'index.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    packages: 'external',
  });
  fs.writeFileSync(
    path.join(targetDir, 'package.json'),
    `${JSON.stringify({ ...pkg, openclaw: { ...pkg.openclaw, extensions: ['./index.js'] } }, null, 2)}\n`,
  );
  const stagedEntry = path.resolve(targetDir, entries[0]);
  if (path.relative(targetDir, stagedEntry).startsWith('..') || !stagedEntry.endsWith('.ts'))
    throw new Error('Invalid product extension source entry');
  if (fs.existsSync(stagedEntry)) fs.unlinkSync(stagedEntry);
}

function syncLocalExtensions(repoRoot, runtimeRoot, label, options = {}) {
  if (fs.existsSync(path.join(repoRoot, 'openclaw-extensions/drawio'))) {
    require('../../openclaw-extensions/drawio/scripts/prepare.cjs').verifyDrawioAssets(path.join(repoRoot, 'openclaw-extensions/drawio/assets'));
  }
  const sourceDir = path.join(repoRoot, 'openclaw-extensions');
  const targetDir = path.join(runtimeRoot, 'dist', 'extensions');
  const copied = [];
  const installDependencies =
    options.installProductionDependencies || installProductionDependencies;
  let installTarget = options.installTarget;

  if (!fs.existsSync(sourceDir)) {
    return { sourceDir, targetDir, copied };
  }

  fs.mkdirSync(targetDir, { recursive: true });
  cleanInterruptedExtensionStaging(targetDir);
  // agent-team replaces the former always-on collaboration extension.
  // Remove only this exact app-owned artifact; leave third-party extensions intact.
  const retiredCollaboration = path.join(targetDir, 'collaboration');
  if (
    readJsonFile(path.join(retiredCollaboration, 'package.json'))?.name === 'openclaw-collaboration'
  ) {
    fs.rmSync(retiredCollaboration, { recursive: true, force: true });
  }
  // Widget Kit replaces this exact app-owned bundle. Keeping both would claim
  // the same native content kind; matching both identities protects other packages.
  const retiredWidgetBundle = path.join(targetDir, 'interactive-ui');
  if (
    readJsonFile(path.join(sourceDir, 'widget-kit', 'openclaw.plugin.json'))?.id === 'widget-kit' &&
    readJsonFile(path.join(retiredWidgetBundle, 'package.json'))?.name === 'openclaw-interactive-ui' &&
    readJsonFile(path.join(retiredWidgetBundle, 'openclaw.plugin.json'))?.id === 'interactive-ui'
  ) {
    fs.rmSync(retiredWidgetBundle, { recursive: true, force: true });
  }

  const entries = fs
    .readdirSync(sourceDir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const extensionSourceDir = path.join(sourceDir, entry.name);
    const extensionTargetDir = path.join(targetDir, entry.name);
    const sourcePackage = readJsonFile(path.join(extensionSourceDir, 'package.json'));
    if (sourcePackage?.openclaw?.runtimeBundled === true) {
      const baseline = readJsonFile(path.join(extensionSourceDir, 'upstream-source.json'));
      const runtimePackage = readJsonFile(path.join(runtimeRoot, 'package.json'));
      const manifest = readJsonFile(path.join(extensionSourceDir, 'openclaw.plugin.json'));
      if (
        !baseline ||
        baseline.version !== runtimePackage?.version ||
        sourcePackage.version !== baseline.version ||
        manifest?.id !== entry.name ||
        baseline.id !== entry.name
      ) {
        throw new Error(
          'Runtime source replacement requires review against the locked OpenClaw version: ' +
            entry.name,
        );
      }
    }
    const usesProductionDependencies = hasProductionDependencies(extensionSourceDir);
    if (usesProductionDependencies && !installTarget) {
      installTarget = resolveRuntimeInstallTarget(runtimeRoot);
    }
    const fingerprint = usesProductionDependencies
      ? dependencyFingerprint(extensionSourceDir, installTarget)
      : null;
    const existingAssembly = readJsonFile(
      path.join(extensionTargetDir, EXTENSION_ASSEMBLY_MANIFEST),
    );
    let canReuseDependencies = Boolean(
      fingerprint &&
      existingAssembly?.version === EXTENSION_ASSEMBLY_VERSION &&
      existingAssembly?.dependencyFingerprint === fingerprint &&
      existingAssembly?.target === installTarget.targetId &&
      fs.existsSync(path.join(extensionTargetDir, 'node_modules')),
    );
    if (canReuseDependencies) {
      try {
        if (sourcePackage?.name === 'acpx-runtime') {
          require('../../openclaw-extensions/acpx/scripts/runtime-dependencies.cjs')
            .removeExternalAgentPackages(extensionTargetDir);
        }
        verifyDeclaredDependencies(extensionTargetDir);
        verifyAcpxTargetDependencies(extensionTargetDir, installTarget);
      } catch (error) {
        canReuseDependencies = false;
        console.warn(
          `[${label}] Rebuilding incomplete extension dependencies for ${entry.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (canReuseDependencies) {
      replaceExtensionSources(extensionSourceDir, extensionTargetDir);
      bundleProductExtension(extensionSourceDir, extensionTargetDir);
      pruneExtensionDependencies(extensionTargetDir, {
        preserveLegalFiles: ['acpx', 'openai', 'stt-local-cli', 'typesafe'].includes(entry.name),
      });
      console.log(`[${label}] Reused locked production dependencies: ${entry.name}`);
      copied.push(entry.name);
      continue;
    }

    const stagingRoot = fs.mkdtempSync(path.join(targetDir, `.justdo-extension-${entry.name}-`));
    const stagingDir = path.join(stagingRoot, entry.name);
    try {
      fs.cpSync(extensionSourceDir, stagingDir, {
        recursive: true,
        force: true,
        verbatimSymlinks: true,
      });
      bundleProductExtension(extensionSourceDir, stagingDir);
      if (usesProductionDependencies) {
        console.log(`[${label}] Installing production dependencies: ${entry.name}`);
        installDependencies(stagingDir, installTarget);
        if (sourcePackage?.name === 'acpx-runtime') {
          require('../../openclaw-extensions/acpx/scripts/runtime-dependencies.cjs')
            .removeExternalAgentPackages(stagingDir);
        }
        verifyDeclaredDependencies(stagingDir);
        verifyAcpxTargetDependencies(stagingDir, installTarget);
        pruneExtensionDependencies(stagingDir, {
          preserveLegalFiles: ['acpx', 'openai', 'stt-local-cli', 'typesafe'].includes(entry.name),
        });
        fs.writeFileSync(
          path.join(stagingDir, EXTENSION_ASSEMBLY_MANIFEST),
          `${JSON.stringify({ version: EXTENSION_ASSEMBLY_VERSION, target: installTarget.targetId, dependencyFingerprint: fingerprint }, null, 2)}\n`,
          'utf8',
        );
      }
      fs.rmSync(extensionTargetDir, { recursive: true, force: true });
      renameExtensionIntoPlace(stagingDir, extensionTargetDir);
      copied.push(entry.name);
    } finally {
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    }
  }

  console.log(
    `[${label}] Synced local extensions: ${copied.length > 0 ? copied.join(', ') : 'none'}`,
  );

  return { sourceDir, targetDir, copied };
}

function syncOpenClawRuntimeResources(runtimeRoot, options = {}) {
  const repoRoot = options.repoRoot || resolveRepoRoot();
  const label = options.label || 'sync-openclaw-runtime-resources';
  const resolvedRuntimeRoot = runtimeRoot
    ? path.resolve(runtimeRoot)
    : path.join(repoRoot, 'vendor', 'openclaw-runtime', 'current');

  if (!fs.existsSync(resolvedRuntimeRoot)) {
    throw new Error(`Runtime not found: ${resolvedRuntimeRoot}`);
  }

  const docs = syncDocTemplates(repoRoot, resolvedRuntimeRoot, label);
  const channels = syncDocChannels(repoRoot, resolvedRuntimeRoot, label);
  const gatewayConfigChannels = syncGatewayConfigChannels(repoRoot, resolvedRuntimeRoot, label);
  const extensions = syncLocalExtensions(repoRoot, resolvedRuntimeRoot, label);
  const pruneStats = {
    extensionDirsRemoved: 0,
    bytesFreed: 0,
  };
  const pruning = pruneRuntimeExtensions(resolvedRuntimeRoot, pruneStats, {
    repoRoot,
    label,
  });

  console.log(
    `[${label}] Runtime resources ready: ${docs.copiedFiles} doc templates, ` +
      `${channels.copiedFiles} doc channels, ` +
      `${extensions.copied.length} local extensions, ` +
      `${pruneStats.extensionDirsRemoved} bundled extensions removed.`,
  );

  return {
    runtimeRoot: resolvedRuntimeRoot,
    docs,
    channels,
    gatewayConfigChannels,
    extensions,
    pruning,
  };
}

function main() {
  try {
    syncOpenClawRuntimeResources(process.argv[2]);
  } catch (error) {
    console.error(
      `[sync-openclaw-runtime-resources] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  bundleProductExtension,
  installProductionDependencies,
  renameExtensionIntoPlace,
  resolveExtensionInstallTimeoutMs,
  resolveRuntimeInstallTarget,
  syncDocChannels,
  syncGatewayConfigChannels,
  syncLocalExtensions,
  syncOpenClawRuntimeResources,
  verifyAcpxTargetDependencies,
};
