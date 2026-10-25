'use strict';

const path = require('path');
const os = require('os');
const {
  createReadStream,
  existsSync,
  readdirSync,
  statSync,
  mkdirSync,
  readFileSync,
  rmSync,
  cpSync,
  lstatSync,
  realpathSync,
  writeFileSync,
} = require('fs');
const { spawnSync } = require('child_process');
const { createHash } = require('crypto');
const { pipeline } = require('stream/promises');
const { createZstdDecompress } = require('zlib');
const asar = require('@electron/asar');
const {
  OPENCLAW_CLI_ROOT_FILES,
  verifyPublicCliArchiveEntries,
} = require('../openclaw/openclaw-runtime-companions.cjs');
const yaml = require('js-yaml');
const ts = require('typescript');
const { prepareWindowsResources } = require('./prepare-windows-build.cjs');
const { verifyApplicationLicenseAssets } = require('./application-license-assets.cjs');
const { verifyNodeRuntime, targetContract } = require('../runtime/setup-node-runtime.cjs');
const {
  resolveRuntimeInstallTarget,
  syncOpenClawRuntimeResources,
  verifyAcpxTargetDependencies,
} = require('../openclaw/sync-openclaw-runtime-resources.cjs');
const { precompileOpenClawExtensions } = require('../openclaw/precompile-openclaw-extensions.cjs');
const { readBundledSkillConfig, syncBundledSkills } = require('../runtime/sync-bundled-skills.cjs');
const {
  PACKAGED_RUNTIME_EXCLUDES,
  compressTarArchive,
  packMultipleSources,
  verifyRuntimeKnowledgeEntries,
  verifyRuntimeWorkerEntries,
  verifyLegalMetadataEntries,
} = require('../openclaw/pack-openclaw-tar.cjs');
const { isLegalMetadataFile } = require('../openclaw/prune-openclaw-runtime.cjs');
const { readWindowsUpdateConfig } = require('./windows-update-config.cjs');

function readBuiltinModelDevelopmentAuthConfig(projectDir) {
  const configPath = path.join(projectDir, 'src', 'config', 'builtinModelAuth.ts');
  const sourceFile = ts.createSourceFile(
    configPath,
    readFileSync(configPath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let configObject;
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.name.text !== 'BUILTIN_MODEL_AUTH_CONFIG'
      )
        continue;
      let initializer = declaration.initializer;
      if (initializer && ts.isCallExpression(initializer) && initializer.arguments.length === 1) {
        initializer = initializer.arguments[0];
      }
      if (initializer && ts.isObjectLiteralExpression(initializer)) configObject = initializer;
    }
  }
  if (!configObject) {
    throw new Error(
      '[electron-builder-hooks] Cannot read the built-in model authentication config.',
    );
  }
  const readStringProperty = name => {
    const property = configObject.properties.find(
      candidate =>
        ts.isPropertyAssignment(candidate) &&
        ((ts.isIdentifier(candidate.name) && candidate.name.text === name) ||
          (ts.isStringLiteral(candidate.name) && candidate.name.text === name)),
    );
    if (
      !property ||
      !ts.isPropertyAssignment(property) ||
      (!ts.isStringLiteral(property.initializer) &&
        !ts.isNoSubstitutionTemplateLiteral(property.initializer))
    ) {
      throw new Error(`[electron-builder-hooks] ${name} must be a string literal.`);
    }
    return property.initializer.text;
  };
  return {
    developmentAuthMode: readStringProperty('developmentAuthMode'),
    developmentApiKey: readStringProperty('developmentApiKey'),
  };
}

function verifyPackagedBuiltinModelAuthConfig(projectDir) {
  const config = readBuiltinModelDevelopmentAuthConfig(projectDir);
  if (config.developmentAuthMode !== 'jwt' || config.developmentApiKey !== '') {
    throw new Error(
      '[electron-builder-hooks] Packaging requires developmentAuthMode "jwt" and an empty developmentApiKey.',
    );
  }
}
const {
  getRuntimeCompanionPathsReferencedByBundle: getRuntimeCompanionPathsFromContent,
} = require('../openclaw/openclaw-runtime-companions.cjs');
const { APP_UPDATE_CONFIG } = require('../../src/config/appUpdate.ts');
const releaseHistoryLimits = APP_UPDATE_CONFIG.releaseHistory;
const {
  prepareBrowserExtension,
  verifyBrowserExtension,
} = require('../../plugins/browser-extensions/browser-assistant/scripts/prepare.cjs');
const {
  compileBrowserExtensionNativeHost,
} = require('../browser/prepare-browser-extension-dev-host.cjs');
const {
  PATCH_MANIFEST_FILENAME,
  verifyOpenClawPatchManifest,
} = require('../openclaw/verify-openclaw-runtime-patches.cjs');
const { PATCH_DEPENDENCY_ARTIFACT_PATHS } = require('../openclaw/openclaw-patch-dependencies.cjs');
const { createAgentCliLauncher } = require('../external-agent/create-agent-cli-launcher.cjs');
const { getAgentCliCommandName } = require('../../src/shared/integrations/agentCli.ts');
const {
  verifyMxcNativeBinaries,
  verifyMxcSandboxPlugin,
} = require('../openclaw/patch-mxc-sandbox-plugin.cjs');

function isWindowsTarget(context) {
  return context?.electronPlatformName === 'win32';
}

function isMacTarget(context) {
  return context?.electronPlatformName === 'darwin';
}

function rebuildElectronNativeModules(context) {
  const rebuildScript = path.join(__dirname, '../electron/rebuild-electron-native.cjs');
  const targetArch = resolveTargetArch(context);
  const result = spawnSync(
    process.execPath,
    [
      rebuildScript,
      '--electron-version',
      context.packager.config.electronVersion,
      '--platform',
      context.electronPlatformName,
      '--arch',
      targetArch,
    ],
    { stdio: 'inherit', env: { ...process.env } },
  );

  if (result.status !== 0) {
    throw (
      result.error ||
      new Error(
        `[electron-builder-hooks] Native module rebuild failed for ${context.electronPlatformName}-${targetArch}.`,
      )
    );
  }
}

function resolveTargetArch(context) {
  if (context?.arch === 3) return 'arm64';
  if (context?.arch === 0) return 'ia32';
  if (context?.arch === 1) return 'x64';
  if (process.arch === 'arm64') return 'arm64';
  if (process.arch === 'ia32') return 'ia32';
  return 'x64';
}

function resolveOpenClawRuntimeTargetId(context) {
  const platform = context?.electronPlatformName;
  const arch = resolveTargetArch(context);

  if (platform === 'darwin') {
    return arch === 'x64' ? 'mac-x64' : 'mac-arm64';
  }
  if (platform === 'win32') {
    return arch === 'arm64' ? 'win-arm64' : 'win-x64';
  }
  if (platform === 'linux') {
    return arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  }

  return null;
}

function readRuntimeBuildInfo(runtimeRoot) {
  const buildInfoPath = path.join(runtimeRoot, 'runtime-build-info.json');
  if (!existsSync(buildInfoPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(buildInfoPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function getOpenClawRuntimeBuildHint(targetId) {
  if (!targetId) {
    return 'npm run openclaw:runtime:host';
  }
  return `npm run openclaw:runtime:${targetId}`;
}

function syncCurrentOpenClawRuntimeForTarget(context) {
  const runtimeBase = path.join(__dirname, '../..', 'vendor', 'openclaw-runtime');
  const currentRoot = path.join(runtimeBase, 'current');
  const targetId = resolveOpenClawRuntimeTargetId(context);

  if (!targetId) {
    return { runtimeRoot: currentRoot, targetId: null };
  }

  const targetRoot = path.join(runtimeBase, targetId);
  if (!existsSync(targetRoot)) {
    throw new Error(
      `[electron-builder-hooks] Missing OpenClaw runtime for packaging target ${targetId}: ${targetRoot}. ` +
        `Run \`${getOpenClawRuntimeBuildHint(targetId)}\` before packaging.`,
    );
  }

  const currentBuildInfo = readRuntimeBuildInfo(currentRoot);
  if (currentBuildInfo?.target !== targetId) {
    rmSync(currentRoot, { recursive: true, force: true });
    cpSync(targetRoot, currentRoot, { recursive: true, force: true, verbatimSymlinks: true });
    console.log(`[electron-builder-hooks] Synced OpenClaw runtime ${targetId} -> current`);
  }

  return { runtimeRoot: currentRoot, targetId };
}

function verifyPreinstalledPlugins(runtimeRoot, buildHint) {
  const pkgPath = path.join(__dirname, '../..', 'package.json');
  let plugins = [];
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    plugins = (pkg.openclaw && pkg.openclaw.plugins) || [];
  } catch {
    return; // Cannot read package.json — skip verification
  }

  if (!Array.isArray(plugins) || plugins.length === 0) {
    return;
  }

  const runtimeTarget = String(readRuntimeBuildInfo(runtimeRoot)?.target || '');
  const runtimePlatform = runtimeTarget.startsWith('win-')
    ? 'win32'
    : runtimeTarget.startsWith('mac-')
      ? 'darwin'
      : runtimeTarget.startsWith('linux-')
        ? 'linux'
        : process.platform;
  plugins = plugins.filter(
    plugin => !Array.isArray(plugin.platforms) || plugin.platforms.includes(runtimePlatform),
  );
  if (plugins.length === 0) return;

  const extensionsDir = path.join(runtimeRoot, 'dist', 'extensions');
  const missing = [];

  for (const plugin of plugins) {
    if (!plugin.id) continue;
    const pluginDir = path.join(extensionsDir, plugin.id);
    if (!existsSync(pluginDir)) {
      missing.push(plugin.id);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      '[electron-builder-hooks] Preinstalled OpenClaw plugins missing from runtime: ' +
        missing.join(', ') +
        `. Run \`${buildHint}\` (which includes openclaw:plugins) before packaging.`,
    );
  }

  if (plugins.some(plugin => plugin.id === 'mxc')) {
    verifyMxcSandboxPlugin(path.join(extensionsDir, 'mxc'));
    verifyMxcNativeBinaries(path.join(extensionsDir, 'mxc'), runtimeTarget);
  }

  console.log(
    `[electron-builder-hooks] Verified ${plugins.length} preinstalled OpenClaw plugin(s).`,
  );
}

function verifyBundledLocalExtensions(runtimeRoot, buildHint) {
  const repoExtensionsRoot = path.join(__dirname, '../..', 'plugins/extensions');
  if (!existsSync(repoExtensionsRoot)) return;

  const runtimeExtensionsRoot = path.join(runtimeRoot, 'dist', 'extensions');
  const extensionIds = readdirSync(repoExtensionsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .filter(
      entry =>
        existsSync(path.join(repoExtensionsRoot, entry.name, 'package.json')) &&
        existsSync(path.join(repoExtensionsRoot, entry.name, 'openclaw.plugin.json')),
    )
    .map(entry => entry.name);
  for (const extensionId of extensionIds) {
    verifyRequiredPathSet(
      path.join(runtimeExtensionsRoot, extensionId),
      ['package.json', 'openclaw.plugin.json', 'index.js'],
      `Bundled local extension ${extensionId}`,
      buildHint,
    );
  }
  const acpxRoot = path.join(runtimeExtensionsRoot, 'acpx');
  if (existsSync(acpxRoot)) {
    verifyRequiredPathSet(
      acpxRoot,
      ['.justdo-extension-assembly.json', 'THIRD_PARTY_NOTICES.md', 'node_modules'],
      'Bundled ACPX extension',
      buildHint,
    );
    verifyAcpxTargetDependencies(acpxRoot, resolveRuntimeInstallTarget(runtimeRoot));
  }
  console.log(
    `[electron-builder-hooks] Verified ${extensionIds.length} bundled local extension(s).`,
  );
}

function verifyAcpxArtifactEntryPaths(entryPaths, prefix, installTarget, buildHint) {
  const acpxPrefix = `${prefix}dist/extensions/acpx/`;
  const sourceManifest = JSON.parse(
    readFileSync(
      path.join(__dirname, '../..', 'plugins/extensions', 'acpx', 'package.json'),
      'utf8',
    ),
  );
  const dependencies = sourceManifest.dependencies || {};
  const includesClaudeAdapter = Boolean(dependencies['@agentclientprotocol/claude-agent-acp']);
  const includesCodexAdapter = Boolean(dependencies['@agentclientprotocol/codex-acp']);
  const requiredEntries = [
    'index.js',
    'package.json',
    'openclaw.plugin.json',
    '.justdo-extension-assembly.json',
    'THIRD_PARTY_NOTICES.md',
    ...(dependencies.acpx ? ['node_modules/acpx/dist/runtime.js'] : []),
    ...(includesClaudeAdapter
      ? ['node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js']
      : []),
    ...(includesCodexAdapter ? ['node_modules/@agentclientprotocol/codex-acp/dist/index.js'] : []),
  ].map(entry => `${acpxPrefix}${entry}`);
  const missing = requiredEntries.filter(entry => !entryPaths.has(entry));
  require('../../plugins/extensions/acpx/scripts/runtime-dependencies.cjs').verifyExternalAgentPackages(
    Array.from(entryPaths)
      .filter(entry => entry.startsWith(acpxPrefix + 'node_modules/'))
      .map(entry => entry.slice((acpxPrefix + 'node_modules/').length)),
  );
  if (missing.length > 0) {
    throw new Error(
      `[electron-builder-hooks] Packaged ACPX validation FAILED for ${buildHint}. Missing: ${missing.join(', ')}`,
    );
  }
}

function verifyMxcArtifactEntryPaths(entryPaths, prefix, installTarget, buildHint, runtimeRoot) {
  if (installTarget.os !== 'win32') return;
  const mxcPrefix = `${prefix}dist/extensions/mxc/`;
  const arch = installTarget.cpu === 'arm64' ? 'arm64' : 'x64';
  const sdkRoot = 'node_modules/@microsoft/mxc-sdk';
  const nestedPty = `${sdkRoot}/node_modules/node-pty`;
  const ptyRoot = entryPaths.has(`${mxcPrefix}${nestedPty}/package.json`)
    ? nestedPty : 'node_modules/node-pty';
  const requiredEntries = [
    'dist/index.js',
    'dist/mxc-spawn-launcher.mjs',
    'package.json',
    'openclaw.plugin.json',
    `node_modules/@microsoft/mxc-sdk/bin/${arch}/wxc-exec.exe`,
    `node_modules/@microsoft/mxc-sdk/bin/${arch}/wxc-host-prep.exe`,
    'node_modules/@microsoft/mxc-sdk/dist/index.js',
    'node_modules/@microsoft/mxc-sdk/LICENSE.md',
    `${sdkRoot}/package.json`,
    `${ptyRoot}/package.json`,
    `${ptyRoot}/prebuilds/win32-${arch}/conpty.node`,
  ].map(entry => `${mxcPrefix}${entry}`);
  const missing = requiredEntries.filter(entry => !entryPaths.has(entry));
  if (missing.length > 0) {
    throw new Error(
      `[electron-builder-hooks] Packaged MXC validation FAILED for ${buildHint}. Missing: ${missing.join(', ')}`,
    );
  }
  const pluginRoot = path.join(runtimeRoot, 'dist/extensions/mxc');
  const sdkPackage = JSON.parse(readFileSync(path.join(pluginRoot, sdkRoot, 'package.json'), 'utf8'));
  const ptyPackage = JSON.parse(readFileSync(path.join(pluginRoot, ptyRoot, 'package.json'), 'utf8'));
  const supported = require('../../src/shared/security/mxcNativeBinaries.json');
  if (sdkPackage.name !== '@microsoft/mxc-sdk' || sdkPackage.version !== supported.sdkVersion ||
      ptyPackage.name !== 'node-pty' || typeof sdkPackage.dependencies?.['node-pty'] !== 'string' ||
      !require('semver').satisfies(ptyPackage.version, sdkPackage.dependencies['node-pty'])) {
    throw new Error(`[electron-builder-hooks] Packaged MXC dependency identity mismatch for ${buildHint}.`);
  }
}

function verifyRequiredPathSet(rootDir, relativePaths, label, buildHint) {
  const missing = relativePaths.filter(
    relativePath => !existsSync(path.join(rootDir, relativePath)),
  );
  if (missing.length > 0) {
    throw new Error(
      `[electron-builder-hooks] ${label} is incomplete. Missing: ` +
        missing.join(', ') +
        `. Run \`${buildHint}\` before packaging.`,
    );
  }
}

function getRuntimeCompanionPathsReferencedByBundle(gatewayBundlePath) {
  if (!existsSync(gatewayBundlePath)) {
    return [];
  }

  const bundle = readFileSync(gatewayBundlePath, 'utf8');
  return getRuntimeCompanionPathsFromContent(bundle);
}

function verifyRuntimeCompanionFilesFromBundle(runtimeRoot, gatewayBundlePath, buildHint) {
  const companionPaths = getRuntimeCompanionPathsReferencedByBundle(gatewayBundlePath);
  if (companionPaths.length === 0) {
    console.log(
      '[electron-builder-hooks] No known OpenClaw runtime companion references found in bundle.',
    );
    return;
  }

  verifyRequiredPathSet(
    runtimeRoot,
    companionPaths,
    'Bundled OpenClaw runtime companions',
    buildHint,
  );
}

function verifyBundledOpenClawRuntimeFiles(runtimeRoot, buildHint) {
  require('../../plugins/extensions/widget-kit/scripts/prepare.cjs').verifyWidgetLibraryAssets(
    path.join(runtimeRoot, 'dist/extensions/widget-kit/assets'),
  );
  require('../../plugins/extensions/drawio/scripts/prepare.cjs').verifyDrawioAssets(
    path.join(runtimeRoot, 'dist/extensions/drawio/assets'),
  );
  verifyRequiredPathSet(
    runtimeRoot,
    [
      'package.json',
      'runtime-build-info.json',
      'gateway-bundle.mjs',
      'gateway-launcher.cjs',
      'windows-runtime-preload.cjs',
      'gateway.asar',
      ...OPENCLAW_CLI_ROOT_FILES,
      'docs/channels/index.md',
      'docs/gateway/config-channels.md',
      'docs/reference/templates/AGENTS.md',
      'docs/reference/templates/BOOT.md',
      'docs/reference/templates/USER.md',
    ],
    'Bundled OpenClaw runtime',
    buildHint,
  );

  verifyBareOpenClawCliRuntime(runtimeRoot, buildHint, 'Bundled OpenClaw CLI runtime');
}

function verifyBareOpenClawCliRuntime(runtimeRoot, buildHint, label) {
  verifyRequiredPathSet(
    runtimeRoot,
    ['package.json', ...OPENCLAW_CLI_ROOT_FILES],
    label,
    buildHint,
  );
  const hasEntry =
    existsSync(path.join(runtimeRoot, 'dist', 'entry.js')) ||
    existsSync(path.join(runtimeRoot, 'dist', 'entry.mjs'));
  if (!hasEntry) {
    throw new Error(
      `[electron-builder-hooks] ${label} is incomplete. Missing dist/entry.js or dist/entry.mjs. ` +
        `Run \`${buildHint}\` before packaging.`,
    );
  }
}

function verifyBundledSkillResources(buildHint) {
  const repoRoot = path.join(__dirname, '../..');
  const configPath = path.join(repoRoot, 'plugins', 'skills', 'builtin-skills.json');
  const skillsRoot = path.join(repoRoot, 'plugins', 'skills');
  if (!existsSync(configPath)) {
    throw new Error(
      '[electron-builder-hooks] Missing bundled skill manifest: plugins/skills/builtin-skills.json. ' +
        `Run \`${buildHint}\` before packaging.`,
    );
  }
  if (!existsSync(skillsRoot)) {
    throw new Error(
      '[electron-builder-hooks] Missing bundled skills directory: plugins/skills. ' +
        `. Run \`${buildHint}\` before packaging.`,
    );
  }

  console.log('[electron-builder-hooks] Verified bundled skill resources.');
}

async function ensureBundledOpenClawRuntime(context) {
  const { runtimeRoot, targetId } = syncCurrentOpenClawRuntimeForTarget(context);
  const buildHint = getOpenClawRuntimeBuildHint(targetId);

  syncOpenClawRuntimeResources(runtimeRoot, { label: 'electron-builder-hooks' });
  // Resource sync restores local TypeScript entries; package only their newly compiled output.
  await precompileOpenClawExtensions(runtimeRoot, { required: true });
  syncBundledSkills(path.join(__dirname, '../..'), runtimeRoot, 'electron-builder-hooks');
  verifyBundledOpenClawRuntimeFiles(runtimeRoot, buildHint);
  verifyBundledLocalExtensions(runtimeRoot, buildHint);
  verifyBundledSkillResources(buildHint);

  const requiredExternalPaths = [path.join(runtimeRoot, 'node_modules')];
  const missingExternal = requiredExternalPaths.filter(candidate => !existsSync(candidate));
  if (missingExternal.length > 0) {
    throw new Error(
      '[electron-builder-hooks] Bundled OpenClaw runtime is incomplete. Missing: ' +
        missingExternal.join(', ') +
        `. Run \`${buildHint}\` before packaging.`,
    );
  }

  // Verify preinstalled plugins are present in the runtime extensions directory
  verifyPreinstalledPlugins(runtimeRoot, buildHint);

  // Verify gateway-bundle.mjs exists and is reasonably sized.
  // Without it, Windows first-launch falls back to loading ~1100 ESM modules
  // individually, causing 80-100s startup delay.
  const gatewayBundlePath = path.join(runtimeRoot, 'gateway-bundle.mjs');
  if (!existsSync(gatewayBundlePath)) {
    throw new Error(
      '[electron-builder-hooks] gateway-bundle.mjs is missing from ' +
        runtimeRoot +
        '. Run `npm run openclaw:bundle` before packaging.',
    );
  }
  const gatewayBundleStat = statSync(gatewayBundlePath);
  if (gatewayBundleStat.size < 1_000_000) {
    throw new Error(
      '[electron-builder-hooks] gateway-bundle.mjs is suspiciously small (' +
        gatewayBundleStat.size +
        ' bytes, expected ~27MB). Rebuild with: `npm run openclaw:bundle`.',
    );
  }
  verifyRuntimeCompanionFilesFromBundle(runtimeRoot, gatewayBundlePath, buildHint);
  try {
    const manifest = verifyOpenClawPatchManifest(runtimeRoot, { expectedTarget: targetId });
    console.log(
      `[electron-builder-hooks] Verified all ${manifest.patches.length} OpenClaw runtime patches.`,
    );
  } catch (error) {
    throw new Error(
      '[electron-builder-hooks] OpenClaw runtime patches are not ready for packaging. ' +
        `${error instanceof Error ? error.message : String(error)} Run \`${buildHint}\`.`,
    );
  }

  const gatewayAsarPath = path.join(runtimeRoot, 'gateway.asar');
  if (existsSync(gatewayAsarPath)) {
    let entries;
    try {
      // Normalize paths: on Windows, asar.listPackage may return backslash paths
      entries = new Set(asar.listPackage(gatewayAsarPath).map(e => e.replace(/\\/g, '/')));
    } catch (error) {
      throw new Error(
        '[electron-builder-hooks] Failed to read OpenClaw gateway.asar: ' +
          `${gatewayAsarPath}. ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const hasOpenClawEntry = entries.has('/openclaw.mjs');
    verifyPublicCliArchiveEntries(entries);
    const hasNodeVersion = entries.has('/node-version.mjs');
    const hasPackageMetadata = entries.has('/package.json');
    const hasControlUiIndex = entries.has('/dist/control-ui/index.html');
    const hasGatewayEntry = entries.has('/dist/entry.js') || entries.has('/dist/entry.mjs');

    if (
      !hasOpenClawEntry ||
      !hasNodeVersion ||
      !hasPackageMetadata ||
      !hasControlUiIndex ||
      !hasGatewayEntry
    ) {
      throw new Error(
        '[electron-builder-hooks] OpenClaw gateway.asar is incomplete. ' +
          `openclaw.mjs=${hasOpenClawEntry}, node-version.mjs=${hasNodeVersion}, ` +
          `package.json=${hasPackageMetadata}, control-ui=${hasControlUiIndex}, entry=${hasGatewayEntry}.`,
      );
    }

    return;
  }

  const legacyRequiredPaths = [
    path.join(runtimeRoot, 'openclaw.mjs'),
    path.join(runtimeRoot, 'dist', 'control-ui', 'index.html'),
  ];

  const hasLegacyEntry =
    existsSync(path.join(runtimeRoot, 'dist', 'entry.js')) ||
    existsSync(path.join(runtimeRoot, 'dist', 'entry.mjs'));
  if (!hasLegacyEntry) {
    throw new Error(
      '[electron-builder-hooks] Missing OpenClaw runtime entry. ' +
        `Expected ${path.join(runtimeRoot, 'dist', 'entry.js')} or ${path.join(runtimeRoot, 'dist', 'entry.mjs')}, ` +
        `or ${path.join(runtimeRoot, 'gateway.asar')}.`,
    );
  }

  const missingLegacy = legacyRequiredPaths.filter(candidate => !existsSync(candidate));
  if (missingLegacy.length > 0) {
    throw new Error(
      '[electron-builder-hooks] Bundled OpenClaw legacy runtime is incomplete. Missing: ' +
        missingLegacy.join(', ') +
        `. Run \`${buildHint}\` before packaging.`,
    );
  }
}

function findPackagedPythonExecutable(appOutDir) {
  const candidates = [
    path.join(appOutDir, 'resources', 'python-win', 'python.exe'),
    path.join(appOutDir, 'resources', 'python-win', 'python3.exe'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function applyMacIconFix(appPath) {
  console.log(
    '[electron-builder-hooks] Applying macOS icon fix for Apple Silicon compatibility...',
  );

  const infoPlistPath = path.join(appPath, 'Contents', 'Info.plist');
  const resourcesPath = path.join(appPath, 'Contents', 'Resources');
  const iconPath = path.join(resourcesPath, 'icon.icns');

  if (!existsSync(infoPlistPath)) {
    console.warn(`[electron-builder-hooks] Info.plist not found at ${infoPlistPath}`);
    return;
  }

  if (!existsSync(iconPath)) {
    console.warn(`[electron-builder-hooks] icon.icns not found at ${iconPath}`);
    return;
  }

  // Check if CFBundleIconName already exists
  const checkResult = spawnSync('plutil', ['-extract', 'CFBundleIconName', 'raw', infoPlistPath], {
    encoding: 'utf-8',
  });

  if (checkResult.status !== 0) {
    // CFBundleIconName doesn't exist, add it
    console.log('[electron-builder-hooks] Adding CFBundleIconName to Info.plist...');
    const addResult = spawnSync(
      'plutil',
      ['-insert', 'CFBundleIconName', '-string', 'icon', infoPlistPath],
      { encoding: 'utf-8' },
    );

    if (addResult.status === 0) {
      console.log('[electron-builder-hooks] ✓ CFBundleIconName added successfully');
    } else {
      console.warn('[electron-builder-hooks] Failed to add CFBundleIconName:', addResult.stderr);
    }
  } else {
    console.log('[electron-builder-hooks] ✓ CFBundleIconName already present');
  }

  // Clear extended attributes
  spawnSync('xattr', ['-cr', appPath], { encoding: 'utf-8' });

  // Touch the app to update modification time
  spawnSync('touch', [appPath], { encoding: 'utf-8' });
  spawnSync('touch', [resourcesPath], { encoding: 'utf-8' });

  console.log('[electron-builder-hooks] ✓ macOS icon fix applied');
}

/**
 * Remove broken symlinks from a directory recursively.
 * This fixes macOS code signing failures caused by dangling symlinks in node_modules/.bin
 */
function removeBrokenSymlinks(dir) {
  if (!existsSync(dir)) return 0;

  let removedCount = 0;
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    try {
      if (entry.isSymbolicLink()) {
        // Check if symlink target exists
        try {
          statSync(fullPath); // follows symlink
        } catch {
          // Symlink is broken - remove it
          rmSync(fullPath, { force: true });
          removedCount++;
        }
      } else if (entry.isDirectory()) {
        removedCount += removeBrokenSymlinks(fullPath);
      }
    } catch (err) {
      // Skip entries we can't access
    }
  }

  return removedCount;
}

/**
 * Clean up broken symlinks in cfmind/dist/extensions to prevent macOS signing failures.
 */
function cleanupBrokenSymlinksInExtensions(appOutDir) {
  const extensionsDir = path.join(
    appOutDir,
    'Contents',
    'Resources',
    'cfmind',
    'dist',
    'extensions',
  );

  if (!existsSync(extensionsDir)) {
    return;
  }

  console.log('[electron-builder-hooks] Cleaning up broken symlinks in cfmind/dist/extensions...');

  let totalRemoved = 0;
  const extensionEntries = readdirSync(extensionsDir, { withFileTypes: true });

  for (const entry of extensionEntries) {
    if (!entry.isDirectory()) continue;

    const nodeModulesBin = path.join(extensionsDir, entry.name, 'node_modules', '.bin');
    if (existsSync(nodeModulesBin)) {
      const removed = removeBrokenSymlinks(nodeModulesBin);
      if (removed > 0) {
        console.log(
          `[electron-builder-hooks]   ${entry.name}: removed ${removed} broken symlink(s)`,
        );
        totalRemoved += removed;
      }
    }
  }

  if (totalRemoved > 0) {
    console.log(`[electron-builder-hooks] ✓ Removed ${totalRemoved} broken symlink(s) total`);
  } else {
    console.log('[electron-builder-hooks] ✓ No broken symlinks found');
  }
}

/**
 * Check if a command exists in the system PATH.
 */
function hasCommand(command) {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(checker, [command], { stdio: 'ignore' });
  return result.status === 0;
}

/**
 * Install dependencies for all skills in the plugins/skills directory.
 * This ensures bundled skills include node_modules for users without npm.
 */
function installSkillDependencies() {
  // Check if npm is available (should be available during build)
  if (!hasCommand('npm')) {
    console.warn(
      '[electron-builder-hooks] npm not found in PATH, skipping skill dependency installation',
    );
    console.warn(
      '[electron-builder-hooks]   (This is only a warning - skills will be installed at runtime if needed)',
    );
    return;
  }

  const skillsDir = path.join(__dirname, '../..', 'plugins', 'skills');
  if (!existsSync(skillsDir)) {
    console.log(
      '[electron-builder-hooks] plugins/skills directory not found, skipping skill dependency installation',
    );
    return;
  }

  console.log('[electron-builder-hooks] Installing skill dependencies...');

  const entries = readdirSync(skillsDir);
  let installedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const entry of entries) {
    const skillPath = path.join(skillsDir, entry);
    const stat = statSync(skillPath);
    if (!stat.isDirectory()) continue;

    const packageJsonPath = path.join(skillPath, 'package.json');
    const nodeModulesPath = path.join(skillPath, 'node_modules');

    if (!existsSync(packageJsonPath)) {
      continue; // No package.json, skip
    }

    if (existsSync(nodeModulesPath)) {
      console.log(`[electron-builder-hooks]   ${entry}: node_modules exists, skipping`);
      skippedCount++;
      continue;
    }

    console.log(`[electron-builder-hooks]   ${entry}: installing dependencies...`);
    const isWin = process.platform === 'win32';
    // On Windows use cmd.exe /c to avoid DEP0190 warning from shell:true + args
    const result = isWin
      ? spawnSync('cmd.exe', ['/c', 'npm', 'install'], {
          cwd: skillPath,
          encoding: 'utf-8',
          stdio: 'pipe',
          timeout: 5 * 60 * 1000, // 5 minute timeout
        })
      : spawnSync('npm', ['install'], {
          cwd: skillPath,
          encoding: 'utf-8',
          stdio: 'pipe',
          timeout: 5 * 60 * 1000,
        });

    if (result.status === 0) {
      console.log(`[electron-builder-hooks]   ${entry}: ✓ installed`);
      installedCount++;
    } else {
      console.error(`[electron-builder-hooks]   ${entry}: ✗ failed`);
      if (result.error) {
        console.error(`[electron-builder-hooks]     Error: ${result.error.message}`);
      }
      if (result.stderr) {
        console.error(`[electron-builder-hooks]     ${result.stderr.substring(0, 200)}`);
      }
      failedCount++;
    }
  }

  console.log(
    `[electron-builder-hooks] Skill dependencies: ${installedCount} installed, ${skippedCount} skipped, ${failedCount} failed`,
  );
}

async function beforePack(context) {
  await verifyApplicationLicenseAssets({ repoRoot: context.appDir || path.join(__dirname, '../..') });
  require('../../plugins/extensions/widget-kit/scripts/prepare.cjs').verifyWidgetLibraryAssets();
  require('../../plugins/extensions/drawio/scripts/prepare.cjs').verifyDrawioAssets();
  verifyPackagedBuiltinModelAuthConfig(context.appDir || path.join(__dirname, '../..'));
  prepareBrowserExtension();
  if (isWindowsTarget(context)) compileBrowserExtensionNativeHost();
  rebuildElectronNativeModules(context);
  // Install skill dependencies first (for all platforms)
  installSkillDependencies();
  // Copy the fully prepared custom skills after dependencies are installed so
  // every packaging entry point receives the exact enabled skill set.
  await ensureBundledOpenClawRuntime(context);

  if (isWindowsTarget(context)) {
    // Keep a deterministic single-stream filter for the application archive.
    // The custom installer now decodes with the bundled 7za CLI and records
    // actual extraction errors rather than relying on Nsis7z.
    process.env.ELECTRON_BUILDER_7Z_FILTER = 'BCJ';
    console.log('[electron-builder-hooks] Forced NSIS-compatible 7z filter: BCJ');

    // ── Prepare runtime resources BEFORE tar packing ──
    // These must be ready before we build the combined tar, otherwise the
    // directories will be empty and the installed app will lack Python/Git.

    await prepareWindowsResources();
    const pythonRoot = path.join(__dirname, '../..', 'build', 'runtimes', 'python-win');
    const mingitRoot = path.join(__dirname, '../..', 'build', 'runtimes', 'mingit');
    const localTtsRoot = path.join(__dirname, '../..', 'build', 'runtimes', 'local-tts');

    // ── Build combined tar for NSIS ──
    // Pack all large resource directories into one pre-compressed tarball.
    // NSIS only writes that single file; the installer then streams it through
    // Windows' native tar implementation instead of creating thousands of files
    // through NSIS or JavaScript.
    const buildTarDir = path.join(__dirname, '../..', 'build', 'tar');
    mkdirSync(buildTarDir, { recursive: true });

    const outputTar = path.join(buildTarDir, 'win-resources.tar');
    const outputArchive = path.join(buildTarDir, 'win-resources.tar.zst');
    const outputMetadata = path.join(buildTarDir, 'win-resources-metadata.json');
    const sources = [
      {
        label: 'OpenClaw runtime',
        dir: path.join(__dirname, '../..', 'vendor', 'openclaw-runtime', 'current'),
        prefix: 'cfmind',
        // gateway-bundle.mjs is the Windows gateway entry and the bare dist/
        // tree serves CLI/client fallbacks. gateway.asar duplicates that tree.
        exclude: PACKAGED_RUNTIME_EXCLUDES,
      },
      {
        label: 'Python runtime',
        dir: pythonRoot,
        prefix: 'python-win',
        preservePythonLicenses: true,
      },
      {
        label: 'MinGit',
        dir: mingitRoot,
        prefix: 'mingit',
      },
      {
        label: 'Local speech runtime',
        dir: localTtsRoot,
        prefix: 'local-tts',
        preservePythonLicenses: true,
        exclude: [
          'win-x64/kokoro-int8-multi-lang-v1_1',
          'win-x64/sherpa-onnx-whisper-tiny',
          'win-x64/sherpa-onnx-whisper-base',
          'win-x64/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09',
          'win-x64/vits-icefall-zh-aishell3',
          'win-x64/vits-piper-en_US-lessac-medium-int8',
          'win-x64/KOKORO-LICENSE.txt',
          'win-x64/WHISPER-LICENSE.txt',
          'win-x64/.justdo-local-tts-version',
        ],
      },
    ];

    console.log(`[electron-builder-hooks] Packing combined Windows tar: ${outputTar}`);

    // Remove old outputs if they exist.
    if (existsSync(outputTar)) rmSync(outputTar);
    if (existsSync(outputArchive)) rmSync(outputArchive);
    if (existsSync(outputMetadata)) rmSync(outputMetadata);

    const t0 = Date.now();
    const { totalFiles, skipped } = packMultipleSources(sources, outputTar);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const sizeMB = (statSync(outputTar).size / (1024 * 1024)).toFixed(1);
    console.log(
      `[electron-builder-hooks] Combined tar packed in ${elapsed}s: ` +
        `${totalFiles} files, ${skipped} skipped, ${sizeMB} MB`,
    );

    // ── Validate the combined tar ──
    // Verify that each expected prefix actually has content in the archive.
    // This catches build misconfigurations early instead of at install time.
    const requiredPrefixes = ['cfmind/', 'python-win/', 'mingit/', 'local-tts/'];
    const tarEntries = [];
    const tarModule = require(path.join(__dirname, '../..', 'node_modules', 'tar'));
    const normalizedTarPath = outputTar.replace(/\\/g, '/');

    tarModule.list({
      file: normalizedTarPath,
      sync: true,
      onReadEntry: entry => {
        tarEntries.push(entry);
      },
    });

    const tarPrefixes = [...new Set(tarEntries.map(e => e.path.split('/')[0] + '/'))];

    const missingRequired = requiredPrefixes.filter(p => !tarPrefixes.includes(p));
    if (missingRequired.length > 0) {
      throw new Error(
        '[electron-builder-hooks] Combined tar validation FAILED. ' +
          `Missing required prefixes: ${missingRequired.join(', ')}. ` +
          `Found: ${tarPrefixes.join(', ') || '(none)'}`,
      );
    }

    const tarEntryPaths = new Set(tarEntries.map(e => e.path.replace(/\\/g, '/')));
    const knowledgeCount = verifyRuntimeKnowledgeEntries(
      tarEntryPaths,
      'cfmind/',
      path.join(__dirname, '../..', 'vendor', 'openclaw-runtime', 'current'),
    );
    console.log(
      `[electron-builder-hooks] Verified all ${knowledgeCount} runtime knowledge files in the archive.`,
    );
    const workerCount = verifyRuntimeWorkerEntries(
      tarEntryPaths,
      'cfmind/',
      path.join(__dirname, '../..', 'vendor', 'openclaw-runtime', 'current'),
    );
    console.log(
      `[electron-builder-hooks] Verified ${workerCount} local Workers; deployment archives omitted.`,
    );
    const legalCount = sources.reduce(
      (count, source) =>
        count +
        verifyLegalMetadataEntries(tarEntryPaths, `${source.prefix}/`, source.dir, source.exclude),
      0,
    );
    console.log(
      `[electron-builder-hooks] Verified all ${legalCount} legal metadata files in the archive.`,
    );
    const runtimeCompanionTarEntries = getRuntimeCompanionPathsReferencedByBundle(
      path.join(__dirname, '../..', 'vendor', 'openclaw-runtime', 'current', 'gateway-bundle.mjs'),
    ).map(entry => `cfmind/${entry}`);
    const { runtimeSkillPaths } = readBundledSkillConfig(path.join(__dirname, '../..'));
    const widgetAssets =
      require('../../plugins/extensions/widget-kit/scripts/prepare.cjs').verifyWidgetLibraryAssets(
        path.join(sources[0].dir, 'dist/extensions/widget-kit/assets'),
        false,
      );
    const requiredTarEntries = [
      ...['integrity.json', ...Object.keys(widgetAssets.files)].map(
        file => `cfmind/dist/extensions/widget-kit/assets/${file}`,
      ),
      'cfmind/package.json',
      'cfmind/runtime-build-info.json',
      `cfmind/${PATCH_MANIFEST_FILENAME}`,
      'cfmind/gateway-bundle.mjs',
      'cfmind/gateway-launcher.cjs',
      'cfmind/windows-runtime-preload.cjs',
      ...OPENCLAW_CLI_ROOT_FILES.map(name => `cfmind/${name}`),
      'cfmind/docs/channels/index.md',
      'cfmind/docs/gateway/config-channels.md',
      'cfmind/docs/reference/templates/AGENTS.md',
      ...runtimeSkillPaths.map(skillPath => `cfmind/${skillPath}/SKILL.md`),
      'python-win/python.exe',
      'python-win/python3.exe',
      'python-win/python312._pth',
      'python-win/Lib/site-packages/sitecustomize.py',
      'python-win/Lib/site-packages/pip/__main__.py',
      'local-tts/win-x64/runtime/bin/sherpa-onnx-offline-tts.exe',
      'local-tts/win-x64/SHERPA-ONNX-LICENSE.txt',
      'local-tts/win-x64/.justdo-local-speech-runtime-version',
      'local-tts/win-x64/runtime/bin/sherpa-onnx-offline.exe',
      ...['requests', 'yaml', 'openpyxl', 'pypdf', 'bs4'].map(
        importName => `python-win/Lib/bundled-site-packages/${importName}/__init__.py`,
      ),
      ...runtimeCompanionTarEntries,
    ];
    const missingTarEntries = requiredTarEntries.filter(entry => !tarEntryPaths.has(entry));
    const hasBareOpenClawEntry =
      tarEntryPaths.has('cfmind/dist/entry.js') || tarEntryPaths.has('cfmind/dist/entry.mjs');
    verifyAcpxArtifactEntryPaths(
      tarEntryPaths,
      'cfmind/',
      resolveRuntimeInstallTarget(
        path.join(__dirname, '../..', 'vendor', 'openclaw-runtime', 'current'),
      ),
      'Windows runtime tar',
    );
    verifyMxcArtifactEntryPaths(
      tarEntryPaths,
      'cfmind/',
      resolveRuntimeInstallTarget(
        path.join(__dirname, '../..', 'vendor', 'openclaw-runtime', 'current'),
      ),
      'Windows runtime tar',
      path.join(__dirname, '../..', 'vendor', 'openclaw-runtime', 'current'),
    );
    const hasMinGit =
      tarEntryPaths.has('mingit/bin/git.exe') || tarEntryPaths.has('mingit/cmd/git.exe');
    const hasPythonPipCommand = [
      'python-win/Scripts/pip.exe',
      'python-win/Scripts/pip3.exe',
      'python-win/Scripts/pip.cmd',
      'python-win/Scripts/pip3.cmd',
      'python-win/Scripts/pip',
      'python-win/Scripts/pip3',
    ].some(entry => tarEntryPaths.has(entry));

    if (
      missingTarEntries.length > 0 ||
      !hasBareOpenClawEntry ||
      !hasMinGit ||
      !hasPythonPipCommand
    ) {
      throw new Error(
        '[electron-builder-hooks] Combined tar validation FAILED. Missing critical entries: ' +
          [
            ...missingTarEntries,
            ...(!hasBareOpenClawEntry ? ['cfmind/dist/entry.js or cfmind/dist/entry.mjs'] : []),
            ...(!hasMinGit ? ['mingit/bin/git.exe or mingit/cmd/git.exe'] : []),
            ...(!hasPythonPipCommand ? ['python-win/Scripts/pip command'] : []),
          ].join(', '),
      );
    }

    console.log(
      `[electron-builder-hooks] Tar validation passed. Prefixes: ${tarPrefixes.join(', ')}`,
    );

    writeFileSync(
      outputMetadata,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          totalEntries: tarEntries.length,
          totalFiles,
          uncompressedBytes: statSync(outputTar).size,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const compressionStartedAt = Date.now();
    await compressTarArchive(outputTar, outputArchive);
    rmSync(outputTar);
    const compressedSizeMB = (statSync(outputArchive).size / (1024 * 1024)).toFixed(1);
    console.log(
      `[electron-builder-hooks] Compressed Windows runtime archive in ${(
        (Date.now() - compressionStartedAt) /
        1000
      ).toFixed(1)}s: ${compressedSizeMB} MB`,
    );
  }
}

async function afterPack(context) {
  verifyPackagedNodeRuntime(context);
  await verifyPackagedOpenClawRuntime(context);
  const diagramResourcesRoot = isMacTarget(context)
    ? path.join(
        context.appOutDir,
        `${context.packager.appInfo.productFilename}.app`,
        'Contents',
        'Resources',
      )
    : path.join(context.appOutDir, 'resources');
  await verifyPackagedApplicationLegalMetadata(path.join(diagramResourcesRoot, 'app.asar'));
  await verifyApplicationLicenseAssets({
    repoRoot: path.join(__dirname, '../..'),
    packagedRoot: path.join(diagramResourcesRoot, 'licenses/application-dependencies'),
  });
  await require('../../plugins/extensions/drawio/scripts/verify-packaged.cjs').verifyPackagedDrawioAssets(
    diagramResourcesRoot,
    isWindowsTarget(context),
  );
  verifyPackagedBrowserExtension(context);

  if (isWindowsTarget(context)) {
    verifyPackagedWindowsNativeModules(context);
    const productName = context.packager.appInfo.productName;
    createAgentCliLauncher(
      path.join(context.appOutDir, `${getAgentCliCommandName(productName)}.exe`),
      { productName, version: context.packager.appInfo.version },
    );
    const resourcesRoot = path.join(context.appOutDir, 'resources');
    const updateConfigPath = path.join(resourcesRoot, 'app-update.yml');
    const configuredMarkerPath = path.join(resourcesRoot, '.justdo-auto-update-configured');
    const updateConfig = readWindowsUpdateConfig();

    if (updateConfig) {
      writeFileSync(configuredMarkerPath, `${updateConfig.feedUrl}\n`, 'utf8');
    } else {
      rmSync(updateConfigPath, { force: true });
      rmSync(configuredMarkerPath, { force: true });
      console.log('[electron-builder-hooks] Local Windows validation build: auto-update disabled.');
    }
  }

  if (isMacTarget(context)) {
    const appName = context.packager.appInfo.productFilename;
    const appPath = path.join(context.appOutDir, `${appName}.app`);

    if (existsSync(appPath)) {
      // Clean up broken symlinks before signing to prevent ENOENT errors
      cleanupBrokenSymlinksInExtensions(appPath);
      applyMacIconFix(appPath);
    } else {
      console.warn(`[electron-builder-hooks] App not found at ${appPath}, skipping icon fix`);
    }
  }
}

async function verifyPackagedApplicationLegalMetadata(
  appAsarPath,
  repoRoot = path.join(__dirname, '../..'),
) {
  const entries = new Set(
    asar.listPackage(appAsarPath).map(entry => entry.replaceAll('\\', '/').replace(/^\//, '')),
  );
  const packageRoots = [
    '',
    ...[...entries]
      .filter(entry => /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(entry))
      .map(entry => entry.slice(0, -'package.json'.length)),
  ];
  const lockPath = path.join(repoRoot, 'package-lock.json');
  const sourcePackages = existsSync(lockPath)
    ? Object.keys(JSON.parse(readFileSync(lockPath, 'utf8')).packages || {})
    : [];
  let installedSources;
  const findInstalledSources = name => {
    if (!installedSources) {
      installedSources = new Map();
      const visited = new Set();
      const visitPackage = directory => {
        if (!existsSync(directory) || !statSync(directory).isDirectory()) return;
        const realDirectory = realpathSync(directory);
        if (visited.has(realDirectory)) return;
        visited.add(realDirectory);
        const manifestPath = path.join(directory, 'package.json');
        if (existsSync(manifestPath)) {
          const packageName = JSON.parse(readFileSync(manifestPath, 'utf8')).name;
          if (packageName) {
            const sources = installedSources.get(packageName) || [];
            sources.push(directory);
            installedSources.set(packageName, sources);
          }
        }
        visitModules(path.join(directory, 'node_modules'));
      };
      const visitModules = directory => {
        if (!existsSync(directory)) return;
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (entry.name === '.bin') continue;
          const target = path.join(directory, entry.name);
          if (entry.name.startsWith('@') && entry.isDirectory()) {
            for (const scoped of readdirSync(target)) visitPackage(path.join(target, scoped));
          } else {
            visitPackage(target);
          }
        }
      };
      visitModules(path.join(repoRoot, 'node_modules'));
    }
    return installedSources.get(name) || [];
  };
  const transformPackage = require('app-builder-lib/out/fileTransformer').createTransformer(
    repoRoot,
    require('../../electron-builder.json'),
    undefined,
  );
  const resolveSourceRoot = async prefix => {
    if (!prefix) return repoRoot;
    const manifest = asar.extractFile(
      appAsarPath,
      path.join(...`${prefix}package.json`.split('/')),
    );
    const name = JSON.parse(manifest).name;
    // electron-builder hoists npm's nested production dependencies. Bind each
    // staged package to its installed metadata using the builder's actual
    // metadata transform, rather than assuming its original filesystem path.
    const candidates = [
      prefix,
      ...sourcePackages.filter(relative => relative.split('node_modules/').at(-1) === name),
    ].map(relative => path.join(repoRoot, relative));
    // Linked packages can resolve dependencies from an installed tree that is
    // absent from the root lockfile. Inspect those physical package boundaries
    // too, with real-path cycle protection, and keep the exact metadata check.
    candidates.push(...findInstalledSources(name));
    for (const directory of new Set(candidates)) {
      const file = path.join(directory, 'package.json');
      if (!existsSync(file)) continue;
      const transformed = await transformPackage(file);
      const expected = transformed == null ? readFileSync(file) : Buffer.from(transformed);
      if (expected.equals(manifest)) return directory;
    }
    throw new Error(
      `[electron-builder-hooks] Cannot identify packaged dependency source: ${prefix}`,
    );
  };
  let count = 0;
  const verifyFile = (relative, source) => {
    if (
      !entries.has(relative) ||
      !asar.extractFile(appAsarPath, path.join(...relative.split('/'))).equals(readFileSync(source))
    ) {
      throw new Error(
        `[electron-builder-hooks] Packaged application legal metadata is missing or changed: ${relative}`,
      );
    }
    count++;
  };
  const visitLegalDirectory = (relative, source) => {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const target = `${relative}/${entry.name}`;
      const sourceFile = path.join(source, entry.name);
      if (entry.isDirectory()) visitLegalDirectory(target, sourceFile);
      else if (entry.isFile()) verifyFile(target, sourceFile);
    }
  };
  for (const prefix of packageRoots) {
    const sourceRoot = await resolveSourceRoot(prefix);
    for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
      if (!isLegalMetadataFile(entry.name)) continue;
      const relative = prefix + entry.name;
      const sourceFile = path.join(sourceRoot, entry.name);
      if (entry.isDirectory()) visitLegalDirectory(relative, sourceFile);
      else if (entry.isFile()) verifyFile(relative, sourceFile);
    }
  }
  console.log(`[electron-builder-hooks] Verified ${count} application legal metadata files.`);
  return count;
}

function verifyPackagedBrowserExtension(context) {
  const resourcesRoot = isMacTarget(context)
    ? path.join(
        context.appOutDir,
        `${context.packager.appInfo.productFilename}.app`,
        'Contents',
        'Resources',
      )
    : path.join(context.appOutDir, 'resources');
  const extensionDir = path.join(resourcesRoot, 'browser-extension', 'chrome-extension');
  const result = verifyBrowserExtension(extensionDir);
  if (
    isWindowsTarget(context) &&
    !existsSync(
      path.join(
        resourcesRoot,
        'browser-extension',
        'native-host',
        'justdo-browser-extension-native-host-v2.exe',
      ),
    )
  ) {
    throw new Error('Packaged browser extension native host is missing.');
  }
  console.log(
    `[electron-builder-hooks] Verified packaged OpenClaw browser extension ${result.manifest.version}.`,
  );
}

function verifyPackagedNodeRuntime(context) {
  const resourcesRoot = isMacTarget(context)
    ? path.join(
        context.appOutDir,
        `${context.packager.appInfo.productFilename}.app`,
        'Contents',
        'Resources',
      )
    : path.join(context.appOutDir, 'resources');
  // Windows payloads are still in the resource archive at afterPack. The
  // archive verifier separately validates their exact manifest and all bytes.
  const target = resolveOpenClawRuntimeTargetId(context);
  const runtimeRoot = isWindowsTarget(context)
    ? path.join(__dirname, '../..', 'vendor/openclaw-runtime/current/node-runtime')
    : path.join(resourcesRoot, 'cfmind/node-runtime');
  verifyNodeRuntime(runtimeRoot, target);
  const contract = targetContract(target);
  const nodeExecutable = path.join(runtimeRoot, contract.executable);
  const npmBin = path.join(runtimeRoot, contract.npmBin);
  const hostPlatform = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform];
  if (target !== `${hostPlatform}-${process.arch}`) return;
  const commands = [
    { name: 'node', args: ['--version'] },
    {
      name: 'npm',
      args: [path.join(npmBin, 'npm-cli.js'), '--version'],
    },
    {
      name: 'npx',
      args: [path.join(npmBin, 'npx-cli.js'), '--version'],
    },
  ];

  for (const command of commands) {
    const result = spawnSync(nodeExecutable, command.args, {
      encoding: 'utf8',
      env: { ...process.env },
      windowsHide: true,
    });
    const output = String(result.stdout || '').trim();
    if (result.status !== 0 || !/^v?\d+\.\d+\.\d+$/.test(output)) {
      const detail = String(result.stderr || result.stdout || result.error || '').trim();
      throw new Error(
        `[electron-builder-hooks] Packaged ${command.name} runtime verification failed` +
          (detail ? `: ${detail}` : '.'),
      );
    }
    console.log(`[electron-builder-hooks] Verified packaged ${command.name} ${output}.`);
  }
}

function verifyPackagedWindowsNativeModules(context) {
  const targetArch = resolveTargetArch(context);
  if (process.platform !== 'win32' || targetArch !== process.arch) {
    console.log(
      `[electron-builder-hooks] Skipping packaged native runtime verification for win32-${targetArch}; ` +
        `the host is ${process.platform}-${process.arch}.`,
    );
    return;
  }

  // Do not launch the appOut executable here. Windows can retain an image-file
  // handle briefly after it exits, racing electron-builder's subsequent
  // resource editing/signing step. The dependency Electron executable is the
  // exact runtime used for this package and can validate the packaged binary
  // without locking the artifact under construction.
  const electronExecutable = require('electron');
  const bindingPath = path.join(
    context.appOutDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'better-sqlite3',
    'build',
    'Release',
    'better_sqlite3.node',
  );
  const verificationScript = [
    `require(${JSON.stringify(bindingPath)});`,
    "process.stdout.write(process.versions.modules || 'unknown');",
  ].join('');
  const result = spawnSync(electronExecutable, ['-e', verificationScript], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });

  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error || '').trim();
    throw new Error(
      '[electron-builder-hooks] Packaged better-sqlite3 failed Electron ABI verification' +
        (detail ? `: ${detail}` : '.'),
    );
  }

  console.log(
    `[electron-builder-hooks] Verified packaged better-sqlite3 with Electron ABI ${result.stdout.trim()}.`,
  );

  // PTYs are owned by the Gateway's bundled Node and MXC runtimes. Their
  // prebuilds are validated in that resource archive, outside Electron's ABI.
}

function normalizeUpdateVersion(packageVersion) {
  const normalized = String(packageVersion || '')
    .trim()
    .replace(/^v/i, '');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(normalized)) {
    throw new Error(
      `[electron-builder-hooks] Invalid application version for updates: ${packageVersion}`,
    );
  }
  return normalized;
}

function readReleaseNotes(releaseNotesPath) {
  if (!existsSync(releaseNotesPath)) {
    throw new Error(
      `[electron-builder-hooks] Missing release notes file: ${releaseNotesPath}. ` +
        'Add the versioned Markdown file before packaging.',
    );
  }
  return readFileSync(releaseNotesPath, 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
}

function sha512File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('base64')));
  });
}

function findSingleWindowsInstaller(artifactPaths) {
  const installerPaths = artifactPaths.filter(
    artifactPath => artifactPath.toLowerCase().endsWith('.exe') && existsSync(artifactPath),
  );
  if (installerPaths.length !== 1) {
    throw new Error(
      `[electron-builder-hooks] Expected exactly one Windows EXE artifact, found ${installerPaths.length}.`,
    );
  }
  return installerPaths[0];
}

function verifyWindowsInstallerArchiveListing(listing, productFilename) {
  if (!/^Type = 7z$/m.test(listing)) {
    throw new Error(
      '[electron-builder-hooks] Windows installer does not contain a readable embedded 7z application archive.',
    );
  }

  // Inspect package completeness here; the bundled CLI performs real decoding.
  const methods = listing
    .split(/\r?\n/)
    .filter(line => line.startsWith('Method = '))
    .map(line => line.slice('Method = '.length).trim())
    .filter(Boolean);
  if (methods.length === 0) {
    throw new Error(
      '[electron-builder-hooks] Windows installer archive listing contains no compression methods.',
    );
  }
  const archivedPaths = new Set(
    listing
      .split(/\r?\n/)
      .filter(line => line.startsWith('Path = '))
      .map(line => line.slice('Path = '.length).trim().replace(/\\/g, '/').toLowerCase()),
  );
  const requiredPaths = [
    `${productFilename}.exe`,
    'chrome_100_percent.pak',
    'icudtl.dat',
    'libEGL.dll',
    'libGLESv2.dll',
    'locales/en-US.pak',
    'locales/zh-CN.pak',
    'resources.pak',
    'resources/app.asar',
    'resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
    'resources/unpack-cfmind.cjs',
    'resources/win-resources-metadata.json',
  ];
  const missingPaths = requiredPaths.filter(entry => !archivedPaths.has(entry.toLowerCase()));
  if (missingPaths.length > 0) {
    throw new Error(
      `[electron-builder-hooks] Windows installer application archive is missing: ${missingPaths.join(', ')}.`,
    );
  }
}

function verifyWindowsInstallerArchive(installerPath, productFilename, options = {}) {
  const sevenZipExecutable = options.sevenZipExecutable || require('7zip-bin').path7za;
  const run = options.spawnSync || spawnSync;
  const listingResult = run(sevenZipExecutable, ['l', '-slt', installerPath], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (listingResult.status !== 0) {
    const detail = String(
      listingResult.stderr || listingResult.stdout || listingResult.error || '',
    ).trim();
    throw new Error(
      '[electron-builder-hooks] Could not inspect the final Windows installer archive' +
        (detail ? `: ${detail}` : '.'),
    );
  }
  verifyWindowsInstallerArchiveListing(String(listingResult.stdout || ''), productFilename);

  // Listing only reads archive headers. Test every compressed stream and CRC so
  // a truncated/corrupt data block cannot pass solely because paths survived.
  const testResult = run(sevenZipExecutable, ['t', installerPath], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (testResult.status !== 0) {
    const detail = String(testResult.stderr || testResult.stdout || testResult.error || '').trim();
    throw new Error(
      '[electron-builder-hooks] Could not decompress and CRC-test the final Windows installer archive' +
        (detail ? `: ${detail}` : '.'),
    );
  }
  console.log(
    `[electron-builder-hooks] Verified install-time-decodable, CRC-valid application archive in ${installerPath}.`,
  );
}

function artifactBuildCompleted(context) {
  const targetName = String(context?.target?.name || '').toLowerCase();
  const platformName = context?.packager?.platform?.nodeName;
  if (
    platformName !== 'win32' ||
    !targetName.startsWith('nsis') ||
    !String(context?.file || '')
      .toLowerCase()
      .endsWith('.exe')
  ) {
    return;
  }

  // This hook runs after signing but before artifactCreated schedules publish.
  // Reject an unreadable installer before any publisher can observe the EXE.
  verifyWindowsInstallerArchive(context.file, context.packager.appInfo.productFilename);
}

async function buildWindowsUpdateManifest({
  artifactPaths,
  outDir,
  packageVersion,
  releaseNotesPath,
  releaseDate = new Date().toISOString(),
}) {
  const installerPath = findSingleWindowsInstaller(artifactPaths);
  const installerName = path.basename(installerPath);
  const version = normalizeUpdateVersion(packageVersion);
  const releaseNotes = readReleaseNotes(releaseNotesPath);
  const size = statSync(installerPath).size;
  const sha512 = await sha512File(installerPath);
  const manifestPath = path.join(outDir, 'latest.yml');
  const manifest = {
    version,
    files: [{ url: installerName, sha512, size }],
    path: installerName,
    sha512,
    releaseDate,
    releaseNotes,
  };

  writeFileSync(
    manifestPath,
    yaml.dump(manifest, { lineWidth: -1, noRefs: true, sortKeys: false }),
    'utf8',
  );
  console.log(`[electron-builder-hooks] Generated Generic update manifest: ${manifestPath}`);
  return manifestPath;
}

function releaseDateFromVersion(version) {
  const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/.exec(version);
  if (!match) {
    throw new Error(
      `[electron-builder-hooks] Release history requires a date-based version: ${version}`,
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`[electron-builder-hooks] Invalid date-based release version: ${version}`);
  }
  return date.toISOString();
}

function buildReleaseHistory({
  releaseNotesDir,
  outDir,
  packageVersion,
  releaseDate = new Date().toISOString(),
}) {
  const latestVersion = normalizeUpdateVersion(packageVersion);
  const releases = readdirSync(releaseNotesDir)
    .filter(fileName => /^v?\d+\.\d+\.\d+\.md$/i.test(fileName))
    .map(fileName => {
      const version = normalizeUpdateVersion(fileName.replace(/\.md$/i, ''));
      return {
        version,
        releaseDate: version === latestVersion ? releaseDate : releaseDateFromVersion(version),
        releaseNotes: readReleaseNotes(path.join(releaseNotesDir, fileName)),
      };
    })
    .sort((left, right) => Date.parse(right.releaseDate) - Date.parse(left.releaseDate));

  if (releases.length > releaseHistoryLimits.maxEntries) {
    throw new Error(
      `[electron-builder-hooks] Release history contains ${releases.length} entries; ` +
        `the maximum is ${releaseHistoryLimits.maxEntries}.`,
    );
  }
  const oversizedRelease = releases.find(
    release => release.releaseNotes.length > releaseHistoryLimits.maxReleaseNotesLength,
  );
  if (oversizedRelease) {
    throw new Error(
      `[electron-builder-hooks] Release notes for ${oversizedRelease.version} exceed ` +
        `${releaseHistoryLimits.maxReleaseNotesLength} characters.`,
    );
  }
  if (releases.length === 0 || releases[0].version !== latestVersion) {
    throw new Error(
      `[electron-builder-hooks] Release history is missing the latest version: ${latestVersion}`,
    );
  }

  const historyPath = path.join(outDir, 'release-history.json');
  const historyContent = `${JSON.stringify({ schemaVersion: 1, latestVersion, releases }, null, 2)}\n`;
  const historyBytes = Buffer.byteLength(historyContent, 'utf8');
  if (historyBytes > releaseHistoryLimits.maxBytes) {
    throw new Error(
      `[electron-builder-hooks] Release history is ${historyBytes} bytes; ` +
        `the maximum is ${releaseHistoryLimits.maxBytes}.`,
    );
  }
  writeFileSync(historyPath, historyContent, 'utf8');
  console.log(`[electron-builder-hooks] Generated release history: ${historyPath}`);
  return historyPath;
}

function hasWindowsInstallerTarget(platformToTargets) {
  for (const [platform, targets] of platformToTargets?.entries?.() || []) {
    if (platform?.nodeName !== 'win32') continue;
    for (const targetName of targets?.keys?.() || []) {
      if (String(targetName).toLowerCase().startsWith('nsis')) return true;
    }
  }
  return false;
}

async function afterAllArtifactBuild(context) {
  // `electron-builder --dir` reports a Windows target but intentionally creates
  // no installer artifact. Update manifests belong only to NSIS builds; actual
  // NSIS builds still fail closed in findSingleWindowsInstaller when the EXE is
  // missing or ambiguous.
  if (!hasWindowsInstallerTarget(context?.platformToTargets)) return [];
  if (!readWindowsUpdateConfig()) {
    rmSync(path.join(context.outDir, 'latest.yml'), { force: true });
    rmSync(path.join(context.outDir, 'release-history.json'), { force: true });
    return [];
  }

  const repoRoot = path.join(__dirname, '../..');
  const packageMetadata = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const releaseNotesDir = path.join(repoRoot, 'docs', 'releases');
  const releaseNotesPath = path.join(releaseNotesDir, `${packageMetadata.version}.md`);
  const releaseDate = new Date().toISOString();
  const manifestPath = await buildWindowsUpdateManifest({
    artifactPaths: context.artifactPaths,
    outDir: context.outDir,
    packageVersion: packageMetadata.version,
    releaseNotesPath,
    releaseDate,
  });
  const historyPath = buildReleaseHistory({
    releaseNotesDir,
    outDir: context.outDir,
    packageVersion: packageMetadata.version,
    releaseDate,
  });
  return [manifestPath, historyPath];
}

async function verifyPackagedOpenClawRuntime(context, options = {}) {
  // Internal test injection preserves the same verifier without using a mutable real runtime.
  const repoRoot = options.repoRoot || path.join(__dirname, '../..');
  const packageVersion = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).openclaw.version;
  const nativeContract = require('../openclaw/native-database-contract.cjs').readNativeDatabaseContract(repoRoot, packageVersion);
  const resourcesRoot = isMacTarget(context)
    ? path.join(
        context.appOutDir,
        `${context.packager.appInfo.productFilename}.app`,
        'Contents',
        'Resources',
      )
    : path.join(context.appOutDir, 'resources');

  if (isWindowsTarget(context)) {
    const tarPath = path.join(resourcesRoot, 'win-resources.tar.zst');
    const metadataPath = path.join(resourcesRoot, 'win-resources-metadata.json');
    if (!existsSync(tarPath)) {
      throw new Error(
        `[electron-builder-hooks] Packaged Windows runtime archive is missing: ${tarPath}`,
      );
    }
    if (!existsSync(metadataPath)) {
      throw new Error(
        `[electron-builder-hooks] Packaged Windows runtime metadata is missing: ${metadataPath}`,
      );
    }

    const temporaryRoot = require('fs').mkdtempSync(
      path.join(os.tmpdir(), 'justdo-openclaw-patch-verification-'),
    );
    try {
      const requiredEntries = new Set([
        `cfmind/${PATCH_MANIFEST_FILENAME}`,
        'cfmind/runtime-build-info.json',
        'cfmind/gateway-bundle.mjs',
        'cfmind/package.json',
        ...OPENCLAW_CLI_ROOT_FILES.map(name => `cfmind/${name}`),
        'cfmind/dist/entry.js',
        'cfmind/dist/entry.mjs',
        'cfmind/npm-shrinkwrap.json',
        ...Object.values(nativeContract.modules).map(owner => `cfmind/${owner.path}`),
        ...PATCH_DEPENDENCY_ARTIFACT_PATHS.map(name => `cfmind/${name}`),
        'cfmind/dist/extensions/mxc/node_modules/@microsoft/mxc-sdk/package.json',
        'cfmind/dist/extensions/mxc/node_modules/@microsoft/mxc-sdk/node_modules/node-pty/package.json',
        'cfmind/dist/extensions/mxc/node_modules/node-pty/package.json',
      ]);
      const archiveEntryPaths = new Set();
      const tarModule = require(path.join(__dirname, '../..', 'node_modules', 'tar'));
      await pipeline(
        createReadStream(tarPath),
        createZstdDecompress(),
        tarModule.extract({
          cwd: temporaryRoot,
          filter: entryPath => {
            const normalized = entryPath.replace(/^\.\//, '').replace(/\\/g, '/');
            archiveEntryPaths.add(normalized);
            return (
              requiredEntries.has(normalized) ||
              normalized.startsWith('cfmind/node-runtime/') ||
              normalized.startsWith('cfmind/dist/extensions/widget-kit/assets/')
            );
          },
        }),
      );
      // Discover companions from the actual archived bundle, then extract those
      // exact files before the normal filesystem verifier checks their presence.
      // The subsequent manifest check still authenticates the bundle itself.
      const companionEntries = new Set(
        getRuntimeCompanionPathsReferencedByBundle(
          path.join(temporaryRoot, 'cfmind', 'gateway-bundle.mjs'),
        ).map(entry => `cfmind/${entry}`),
      );
      if (companionEntries.size > 0) {
        await pipeline(
          createReadStream(tarPath),
          createZstdDecompress(),
          tarModule.extract({
            cwd: temporaryRoot,
            filter: entryPath =>
              companionEntries.has(entryPath.replace(/^\.\//, '').replace(/\\/g, '/')),
          }),
        );
      }
      verifyOpenClawPatchManifest(path.join(temporaryRoot, 'cfmind'), {
        repoRoot,
        expectedTarget: resolveOpenClawRuntimeTargetId(context),
        allowOmittedGatewayAsar: true,
      });
      verifyBareOpenClawCliRuntime(
        path.join(temporaryRoot, 'cfmind'),
        getOpenClawRuntimeBuildHint(resolveOpenClawRuntimeTargetId(context)),
        'Packaged Windows OpenClaw CLI runtime',
      );
      // The archived build proof owns this target. A mutable local "current"
      // runtime can point to another architecture or be absent during verification.
      const packagedInstallTarget = resolveRuntimeInstallTarget(path.join(temporaryRoot, 'cfmind'));
      verifyAcpxArtifactEntryPaths(
        archiveEntryPaths,
        'cfmind/',
        packagedInstallTarget,
        'packaged Windows archive',
      );
      verifyMxcArtifactEntryPaths(
        archiveEntryPaths,
        'cfmind/',
        packagedInstallTarget,
        'packaged Windows archive',
        path.join(temporaryRoot, 'cfmind'),
      );
      verifyRuntimeWorkerEntries(
        archiveEntryPaths,
        'cfmind/',
        path.join(repoRoot, 'vendor', 'openclaw-runtime', 'current'),
      );
      require('../../plugins/extensions/widget-kit/scripts/prepare.cjs').verifyWidgetLibraryAssets(
        path.join(temporaryRoot, 'cfmind/dist/extensions/widget-kit/assets'),
        false,
      );
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  } else {
    const packagedRuntimeRoot = path.join(resourcesRoot, 'cfmind');
    verifyOpenClawPatchManifest(packagedRuntimeRoot, {
      repoRoot,
      expectedTarget: resolveOpenClawRuntimeTargetId(context),
      allowOmittedGatewayAsar: true,
    });
    verifyBareOpenClawCliRuntime(
      packagedRuntimeRoot,
      getOpenClawRuntimeBuildHint(resolveOpenClawRuntimeTargetId(context)),
      'Packaged OpenClaw CLI runtime',
    );
    verifyBundledLocalExtensions(path.join(resourcesRoot, 'cfmind'), 'packaged application');
    require('../../plugins/extensions/widget-kit/scripts/prepare.cjs').verifyWidgetLibraryAssets(
      path.join(packagedRuntimeRoot, 'dist/extensions/widget-kit/assets'),
      false,
    );
  }

  console.log('[electron-builder-hooks] Verified patches in packaged OpenClaw runtime.');
}

module.exports = {
  verifyPackagedApplicationLegalMetadata,
  beforePack,
  readBuiltinModelDevelopmentAuthConfig,
  verifyPackagedBuiltinModelAuthConfig,
  afterPack,
  artifactBuildCompleted,
  afterAllArtifactBuild,
  buildReleaseHistory,
  buildWindowsUpdateManifest,
  findSingleWindowsInstaller,
  hasWindowsInstallerTarget,
  normalizeUpdateVersion,
  readReleaseNotes,
  verifyWindowsInstallerArchive,
  verifyWindowsInstallerArchiveListing,
  verifyPackagedNodeRuntime,
  verifyPackagedWindowsNativeModules,
  verifyPackagedOpenClawRuntime,
  verifyAcpxArtifactEntryPaths,
  verifyMxcArtifactEntryPaths,
  verifyPackagedBrowserExtension,
};
