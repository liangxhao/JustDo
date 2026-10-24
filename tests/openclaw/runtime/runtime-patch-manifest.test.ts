import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import cliRuntimeFiles from '../../../src/shared/openclaw/cliRuntimeFiles.json';

const {
  PATCH_MANIFEST_FILENAME,
  buildOpenClawBuildRecipeFingerprint,
  buildOpenClawPatchSetFingerprint,
  normalizeOpenClawVersion,
  readOpenClawSourceLock,
  verifyFrozenOpenClawRuntime,
  listBuildRecipeFiles,
  verifyOpenClawPatchManifest,
  writeOpenClawPatchManifest,
} = require('../../../scripts/openclaw/verify-openclaw-runtime-patches.cjs') as {
  PATCH_MANIFEST_FILENAME: string;
  listBuildRecipeFiles: (repoRoot: string) => string[];
  buildOpenClawBuildRecipeFingerprint: (repoRoot: string, version: string) => string;
  buildOpenClawPatchSetFingerprint: (repoRoot: string, version: string) => string;
  normalizeOpenClawVersion: (version: string) => string;
  readOpenClawSourceLock: (
    repoRoot: string,
    version: string,
  ) => { version: string; integrity: string; tarballSha256: string };
  verifyFrozenOpenClawRuntime: (
    runtimeRoot: string,
    options?: { expectedTarget?: string; expectedVersion?: string; requireBundle?: boolean },
  ) => { buildInfo: Record<string, unknown> };
  verifyOpenClawPatchManifest: (
    runtimeRoot: string,
    options: {
      repoRoot: string;
      expectedTarget?: string;
      allowOmittedGatewayAsar?: boolean;
    },
  ) => { patches: Array<{ file: string; sha256: string }> };
  writeOpenClawPatchManifest: (
    runtimeRoot: string,
    options: { repoRoot: string },
  ) => { manifestPath: string };
};
const { verifyPackagedOpenClawRuntime } =
  require('../../../scripts/packaging/electron-builder-hooks.cjs') as {
    verifyPackagedOpenClawRuntime: (context: {
      appOutDir: string;
      electronPlatformName: string;
    }, options?: { repoRoot: string }) => Promise<void>;
  };
const { compressTarArchive } = require('../../../scripts/openclaw/pack-openclaw-tar.cjs') as {
  compressTarArchive: (sourceTar: string, outputArchive: string) => Promise<void>;
};
const { ensureOpenClawRuntimePatches, patchOpenClawRuntime } =
  require('../../../scripts/openclaw/patch-openclaw-runtime.cjs') as {
    ensureOpenClawRuntimePatches: (
      runtimeRoot: string,
      options: { repoRoot: string },
    ) => { cached: boolean };
    patchOpenClawRuntime: (
      runtimeRoot: string,
      options: { repoRoot: string; pristineInstallPass?: boolean; freshBundlePass?: boolean },
    ) => Array<{ file: string }>;
  };

const temporaryRoots: string[] = [];
const fixtureIntegrity = `sha512-${Buffer.alloc(64, 7).toString('base64')}`;
const {
  PROVIDER_PACKAGE_PATH,
  PROVIDER_PARTITIONER_PATH,
  PROVIDER_TRANSPORT_PATH,
  FS_SAFE_PACKAGE_PATH,
  FS_SAFE_MOVE_PATH,
  FS_SAFE_GUARDED_MUTATION_PATH,
  PLUGIN_PUBLICATION_SUPPORT_PATH,
} = require('../../../scripts/openclaw/openclaw-patch-dependencies.cjs') as {
  PROVIDER_PACKAGE_PATH: string;
  PROVIDER_PARTITIONER_PATH: string;
  PROVIDER_TRANSPORT_PATH: string;
  FS_SAFE_PACKAGE_PATH: string;
  FS_SAFE_MOVE_PATH: string;
  FS_SAFE_GUARDED_MUTATION_PATH: string;
  PLUGIN_PUBLICATION_SUPPORT_PATH: string;
};

function writeProviderFixture(runtimeRoot: string): void {
  addLockedAiDependency(runtimeRoot);
  fs.mkdirSync(path.dirname(path.join(runtimeRoot, FS_SAFE_MOVE_PATH)), { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, FS_SAFE_PACKAGE_PATH), JSON.stringify({ name: '@openclaw/fs-safe', version: '0.25.0' }));
  fs.writeFileSync(path.join(runtimeRoot, FS_SAFE_MOVE_PATH), 'const ownedMove = true;\n');
  fs.writeFileSync(path.join(runtimeRoot, FS_SAFE_GUARDED_MUTATION_PATH), 'const ownedRename = true;\n');
  fs.mkdirSync(path.dirname(path.join(runtimeRoot, PLUGIN_PUBLICATION_SUPPORT_PATH)), { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, PLUGIN_PUBLICATION_SUPPORT_PATH), 'const publicationRecovery = true;\n');
  const target = path.join(runtimeRoot, PROVIDER_TRANSPORT_PATH);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'const providerTransport = true;\n');
  fs.writeFileSync(
    path.join(runtimeRoot, PROVIDER_PARTITIONER_PATH),
    'const providerPartitioner = true;\n',
  );
}

function writeNodeFixture(runtimeRoot: string): string {
  const root = path.join(runtimeRoot, 'node-runtime');
  const sourceLock = require('../../../src/shared/openclaw/nodeRuntime.json');
  const contract = sourceLock.targets['win-x64'];
  const { __testing: { inventory } } = require('../../../scripts/runtime/setup-node-runtime.cjs');
  for (const file of [contract.executable, 'LICENSE', contract.npmBin + '/npm-cli.js', contract.npmBin + '/npx-cli.js']) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'fixture ' + file);
  }
  const manifest = path.join(root, 'node-runtime-manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({
    version: sourceLock.version, target: 'win-x64', archive: contract.archive,
    archiveSha256: contract.sha256, executable: contract.executable, files: inventory(root),
  }));
  return crypto.createHash('sha256').update(fs.readFileSync(manifest)).digest('hex');
}

function writeFixtureBuildInfo(
  repoRoot: string,
  runtimeRoot: string,
  overrides: Record<string, unknown> = {},
) {
  const version = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
    .openclaw.version;
  fs.writeFileSync(
    path.join(runtimeRoot, 'runtime-build-info.json'),
    JSON.stringify({
      openclawVersion: version,
      installMethod: 'npm-package',
      target: 'win-x64',
      nodeRuntimeManifestSha256: writeNodeFixture(runtimeRoot),
      npmPackageVersion: version.slice(1),
      npmIntegrity: fixtureIntegrity,
      npmTarballSha256: 'a'.repeat(64),
      patchSetSha256: buildOpenClawPatchSetFingerprint(repoRoot, version),
      buildRecipeSha256: buildOpenClawBuildRecipeFingerprint(repoRoot, version),
      gatewayAsarSha256: crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(runtimeRoot, 'gateway.asar')))
        .digest('hex'),
      runtimePackageSha256: crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(runtimeRoot, 'package.json')))
        .digest('hex'),
      runtimePackageLockPath: 'npm-shrinkwrap.json',
      runtimePackageLockSha256: crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(runtimeRoot, 'npm-shrinkwrap.json')))
        .digest('hex'),
      ...overrides,
    }),
  );
}

function writeNativeOwnerArchive(runtimeRoot: string, modules: Record<string, { path: string }>): void {
  const { Pickle } = require('@electron/asar/lib/pickle');
  const files: Record<string, { size: number; offset: string }> = {};
  const bodies: Buffer[] = [];
  let offset = 0;
  for (const owner of Object.values(modules)) {
    const bytes = fs.readFileSync(path.join(runtimeRoot, owner.path));
    files[path.basename(owner.path)] = { size: bytes.length, offset: String(offset) };
    bodies.push(bytes);
    offset += bytes.length;
  }
  const header = Pickle.createEmpty();
  header.writeString(JSON.stringify({ files: { dist: { files } } }));
  const size = Pickle.createEmpty();
  size.writeUInt32(header.toBuffer().length);
  fs.writeFileSync(path.join(runtimeRoot, 'gateway.asar'), Buffer.concat([size.toBuffer(), header.toBuffer(), ...bodies]));
  require('@electron/asar').uncache(path.join(runtimeRoot, 'gateway.asar'));
}

function writeNativeDatabaseFixture(repoRoot: string, runtimeRoot: string, version: string): void {
  const contract = JSON.parse(fs.readFileSync(path.resolve('src/main/startup/upgrade/nativeDatabaseContract.json'), 'utf8'));
  contract.openclawVersion = version;
  for (const owner of Object.values(contract.modules) as { path: string; sha256: string; exports: Record<string, string> }[]) {
    const content = Object.keys(owner.exports).map(symbol => `function ${symbol}() {}`).join('\n') +
      '\nexport { ' + Object.entries(owner.exports).map(([symbol, alias]) => `${symbol} as ${alias}`).join(', ') + ' };\n';
    const file = path.join(runtimeRoot, owner.path);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    owner.sha256 = crypto.createHash('sha256').update(content).digest('hex');
  }
  fs.writeFileSync(path.join(repoRoot, 'src/main/startup/upgrade/nativeDatabaseContract.json'), JSON.stringify(contract));
  fs.writeFileSync(path.join(runtimeRoot, 'package.json'), JSON.stringify({ name: 'openclaw', version: version.slice(1), openclaw: { schemaVersions: contract.schemaVersions } }));
  writeNativeOwnerArchive(runtimeRoot, contract.modules);
}

/** Inert closed payload for the real archive verifier; no downloaded library bytes are needed. */
function writeWidgetLibraryArchiveFixture(runtimeRoot: string): void {
  const { libraries } = JSON.parse(fs.readFileSync(path.resolve('plugins/extensions/widget-kit/libraries/upstreams.json'), 'utf8'));
  const assets = path.join(runtimeRoot, 'dist/extensions/widget-kit/assets');
  const files: Record<string, string> = {};
  const resources: Record<string, { file: string; sha256: string; bytes: number }> = {};
  const write = (name: string, content: string) => {
    const file = path.join(assets, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    files[name] = crypto.createHash('sha256').update(content).digest('hex');
  };
  for (const library of libraries) {
    const file = `libraries/${library.id}-${library.version}.js`;
    const content = `globalThis.${library.global} = {};\n`;
    write(file, content);
    resources[library.resourcePath] = { file, sha256: files[file], bytes: Buffer.byteLength(content) };
    write(`licenses/${library.id}-${library.version}/LICENSE`, 'Synthetic archive fixture license.\n');
  }
  write('THIRD_PARTY_NOTICES.json', '[]\n');
  fs.writeFileSync(path.join(assets, 'integrity.json'), JSON.stringify({
    schemaVersion: 1, sourceHash: '0'.repeat(64), upstreams: libraries, resources, files,
  }));
}

function createFixture(version = 'v2026.6.11') {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-patch-manifest-test-'));
  temporaryRoots.push(repoRoot);
  const runtimeRoot = path.join(repoRoot, 'runtime');
  const patchRoot = path.join(repoRoot, 'scripts', 'patches', version);
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.mkdirSync(patchRoot, { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, 'package.json'),
    JSON.stringify({ openclaw: { version } }),
  );
  fs.writeFileSync(path.join(repoRoot, '.nvmrc'), '24.15.0\n');
  fs.writeFileSync(path.join(repoRoot, 'package-lock.json'), '{}\n');
  fs.writeFileSync(path.join(repoRoot, 'electron-builder.json'), '{}\n');
  fs.writeFileSync(path.join(repoRoot, 'electron-builder.config.cjs'), '// fixture\n');
  for (const scriptName of [
    'electron-builder-hooks.cjs',
    'electron-builder-product-metadata.cjs',
    'install-openclaw-runtime.cjs',
    'openclaw-facade-runtime-patch.cjs',
    'openclaw-runtime-companions.cjs',
    'openclaw-runtime-dev-lease.cjs',
    'openclaw-runtime-freeze.cjs',
    'openclaw-runtime-staging.cjs',
    'patch-openclaw-runtime.cjs',
    'verify-openclaw-pristine-contracts.cjs',
    'verify-openclaw-runtime-patches.cjs',
    'sync-openclaw-runtime-current.cjs',
    'bundle-openclaw-gateway.cjs',
    'openclaw-shared-sdk-modules.cjs',
    'ensure-openclaw-plugins.cjs',
    'patch-mxc-sandbox-plugin.cjs',
    'sync-openclaw-runtime-resources.cjs',
    'precompile-openclaw-extensions.cjs',
    'prune-openclaw-runtime.cjs',
    'pack-openclaw-tar.cjs',
  ]) {
    const scriptDir = path.join(
      repoRoot,
      'scripts',
      scriptName.startsWith('electron-builder-') ? 'packaging' : 'openclaw',
    );
    fs.mkdirSync(scriptDir, { recursive: true });
    fs.writeFileSync(path.join(scriptDir, scriptName), `// ${scriptName}\n`);
  }
  fs.mkdirSync(path.join(repoRoot, 'src', 'main', 'openclaw', 'runtime'), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, 'src', 'main', 'openclaw', 'runtime', 'openclawGatewayBundleLauncher.cjs'),
    '// fixture\n',
  );
  fs.writeFileSync(
    path.join(repoRoot, 'src', 'main', 'openclaw', 'runtime', 'windowsRecursiveRemove.cjs'),
    '// fixture\n',
  );
  fs.mkdirSync(path.join(repoRoot, 'src', 'shared', 'security'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'src', 'shared', 'openclaw'), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, 'src', 'shared', 'openclaw', 'cliRuntimeFiles.json'),
    JSON.stringify(cliRuntimeFiles),
  );
  fs.writeFileSync(
    path.join(repoRoot, 'src', 'shared', 'security', 'mxcNativeBinaries.json'),
    '{}\n',
  );
  fs.mkdirSync(path.join(repoRoot, 'scripts', 'runtime'), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, 'scripts', 'runtime', 'sync-bundled-skills.cjs'),
    '// fixture\n',
  );
  fs.mkdirSync(path.join(repoRoot, 'plugins', 'extensions'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'plugins', 'extensions', 'prune-policy.json'), '{}\n');
  fs.mkdirSync(path.join(repoRoot, 'plugins', 'skills'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'plugins', 'skills', 'builtin-skills.json'), '{}\n');
  for (const file of listBuildRecipeFiles(repoRoot)) {
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '// fixture recipe input\n');
    }
  }
  fs.writeFileSync(path.join(runtimeRoot, 'gateway-bundle.mjs'), 'const patched = true;\n');
  writeNativeDatabaseFixture(repoRoot, runtimeRoot, version);
  fs.writeFileSync(path.join(runtimeRoot, 'npm-shrinkwrap.json'), '{}\n');
  const verifiedPatch = `
const fs = require('fs');
const path = require('path');
function applyPatch(runtimeRoot) {
  const bundlePath = path.join(runtimeRoot, 'gateway-bundle.mjs');
  const content = fs.readFileSync(bundlePath, 'utf8');
  if (!content.includes('const verified = true;')) {
    fs.appendFileSync(bundlePath, 'const verified = true;\\n');
  }
}

function verifyPatch(runtimeRoot) {
  const content = fs.readFileSync(path.join(runtimeRoot, 'gateway-bundle.mjs'), 'utf8');
  if (!content.includes('const verified = true;')) throw new Error('patch verification failed');
}
module.exports = { applyPatch, verifyPatch };
`;
  fs.writeFileSync(path.join(patchRoot, '001-example.cjs'), verifiedPatch);
  fs.writeFileSync(path.join(patchRoot, '002-example.cjs'), verifiedPatch);
  fs.writeFileSync(
    path.join(patchRoot, 'source-lock.json'),
    JSON.stringify({
      name: 'openclaw',
      version: version.slice(1),
      integrity: fixtureIntegrity,
      tarballSha256: 'a'.repeat(64),
    }),
  );
  if (version === 'v2026.10.6') writeProviderFixture(runtimeRoot);
  writeFixtureBuildInfo(repoRoot, runtimeRoot);
  return { patchRoot, repoRoot, runtimeRoot };
}

function addLockedAiDependency(runtimeRoot: string) {
  const root = path.join(runtimeRoot, 'node_modules', '@openclaw', 'ai');
  const transport = 'openai-completions-transport-BRjxCG1C.mjs';
  const provider = 'openai-completions-BkRt2Iy4.mjs';
  const target = path.join(root, 'dist', transport);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: '@openclaw/ai', version: '2026.10.6',
    exports: {
      './transports': { import: './dist/transports.mjs' },
      './providers': { import: './dist/providers.mjs' },
    },
  }));
  fs.writeFileSync(path.join(root, 'dist', 'transports.mjs'), `import { t as createOpenAICompletionsTransportStreamFn } from "./${transport}";`);
  fs.writeFileSync(path.join(root, 'dist', 'providers.mjs'), `createLazyRegistration("openai-completions", () => import("./${provider}").then((n) => n.t));`);
  fs.writeFileSync(path.join(root, 'dist', provider),
    `import { n as streamOpenAICompletionsRequest } from "./${transport}";\n` +
    'const streamOpenAICompletions = (model, context, options) => streamOpenAICompletionsRequest(model, context, options, "direct");');
  fs.writeFileSync(target, 'export const dependencyProducer = true;\n');
  return target;
}

afterEach(() => {
  for (const temporaryRoot of temporaryRoots.splice(0)) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

describe('OpenClaw runtime patch manifest', () => {
  test.each(['.openclaw-lifecycle-pending', 'dist/openclaw-install-guard', '.openclaw-lifecycle-lock'])(
    'rejects incomplete or unsettled lifecycle before trusting build proof: %s', marker => {
      const { repoRoot, runtimeRoot } = createFixture('v2026.10.6');
      writeOpenClawPatchManifest(runtimeRoot, { repoRoot });
      fs.mkdirSync(path.dirname(path.join(runtimeRoot, marker)), { recursive: true });
      fs.writeFileSync(path.join(runtimeRoot, marker), 'pending');
      expect(() => writeOpenClawPatchManifest(runtimeRoot, { repoRoot })).toThrow(/lifecycle is incomplete or unsettled/);
      expect(() => verifyOpenClawPatchManifest(runtimeRoot, { repoRoot })).toThrow(/lifecycle is incomplete or unsettled/);
      expect(() => verifyFrozenOpenClawRuntime(runtimeRoot, { requireBundle: true })).toThrow(/lifecycle is incomplete or unsettled/);
    },
  );
  test.each(['producer', 'managed importer', 'provider registry', 'direct provider', 'metadata'] as const)(
    'freezes the exact dependency %s independently of the Gateway bundle',
    artifact => {
      const { repoRoot, runtimeRoot } = createFixture('v2026.10.6');
      const target = path.join(runtimeRoot, PROVIDER_TRANSPORT_PATH);
      writeOpenClawPatchManifest(runtimeRoot, { repoRoot });
      const manifest = JSON.parse(fs.readFileSync(path.join(runtimeRoot, PATCH_MANIFEST_FILENAME), 'utf8'));
      expect(manifest.patchDependencyArtifacts.map((entry: { path: string }) => entry.path)).toEqual([
        PROVIDER_PACKAGE_PATH, FS_SAFE_PACKAGE_PATH, PROVIDER_TRANSPORT_PATH, PROVIDER_PARTITIONER_PATH,
        FS_SAFE_MOVE_PATH, FS_SAFE_GUARDED_MUTATION_PATH,
        'node_modules/@openclaw/ai/dist/transports.mjs',
        'node_modules/@openclaw/ai/dist/providers.mjs',
        'node_modules/@openclaw/ai/dist/openai-completions-BkRt2Iy4.mjs',
        PLUGIN_PUBLICATION_SUPPORT_PATH,
      ]);
      expect(() => verifyOpenClawPatchManifest(runtimeRoot, { repoRoot })).not.toThrow();
      expect(() => verifyFrozenOpenClawRuntime(runtimeRoot, { requireBundle: true })).not.toThrow();
      const proofTarget = artifact === 'producer' ? target : path.join(path.dirname(target), {
        'managed importer': 'transports.mjs',
        'provider registry': 'providers.mjs',
        'direct provider': 'openai-completions-BkRt2Iy4.mjs',
        metadata: '../package.json',
      }[artifact]);
      fs.appendFileSync(proofTarget, artifact === 'metadata' ? '\n ' : '\n// stale artifact\n');
      expect(() => verifyOpenClawPatchManifest(runtimeRoot, { repoRoot })).toThrow('dependencies');
      expect(() => verifyFrozenOpenClawRuntime(runtimeRoot, { requireBundle: true })).toThrow('dependencies');
    },
  );

  test('snapshots and indexes the explicit dependency and rolls it back on failure', () => {
    const { patchRoot, repoRoot, runtimeRoot } = createFixture();
    const target = addLockedAiDependency(runtimeRoot);
    const original = fs.readFileSync(target);
    const patchUtils = path.resolve(__dirname, '../../../scripts/patches/v2026.10.6/_patch-utils.js');
    const pristineContracts = path.resolve(__dirname, '../../../scripts/openclaw/verify-openclaw-pristine-contracts.cjs');
    fs.writeFileSync(path.join(patchRoot, '_patch-utils.js'), `module.exports = require(${JSON.stringify(patchUtils)});`);
    fs.writeFileSync(path.join(patchRoot, '001-example.cjs'), `
      const fs = require('fs');
      const { findFilesContaining, writeIfChanged } = require('./_patch-utils.js');
      const { resolveNativeProviderTransportArtifact } = require(${JSON.stringify(pristineContracts)});
      module.exports = {
        applyPatch(root) {
          if (findFilesContaining(root, 'dependencyProducer').length !== 1) throw new Error('audited dependency missing from index');
          const { file } = resolveNativeProviderTransportArtifact(root, { required: true });
          const source = fs.readFileSync(file, 'utf8');
          writeIfChanged(file, source, source + 'export const indexedDependency = true;');
          if (!fs.readFileSync(file, 'utf8').includes('indexedDependency')) throw new Error('SDK write missing');
          if (findFilesContaining(root, 'indexedDependency').length !== 1) throw new Error('SDK index stale');
        }, verifyPatch() {}
      };`);
    fs.writeFileSync(path.join(patchRoot, '002-example.cjs'), "module.exports = { applyPatch() { throw new Error('fixture failure'); }, verifyPatch() {} };");
    writeFixtureBuildInfo(repoRoot, runtimeRoot);
    expect(() => patchOpenClawRuntime(runtimeRoot, { repoRoot, freshBundlePass: true })).toThrow('fixture failure');
    expect(fs.readFileSync(target)).toEqual(original);
    expect(fs.existsSync(path.join(runtimeRoot, PATCH_MANIFEST_FILENAME))).toBe(false);
  });

  test('rejects invalid direct SDK syntax and restores the original producer bytes', () => {
    const { patchRoot, repoRoot, runtimeRoot } = createFixture();
    const target = addLockedAiDependency(runtimeRoot);
    const original = fs.readFileSync(target);
    fs.writeFileSync(path.join(patchRoot, '001-example.cjs'), `
      const fs = require('fs');
      module.exports = {
        applyPatch() { fs.appendFileSync(${JSON.stringify(target)}, 'export const broken = ;'); },
        verifyPatch() {}
      };`);
    writeFixtureBuildInfo(repoRoot, runtimeRoot);
    expect(() => patchOpenClawRuntime(runtimeRoot, { repoRoot, freshBundlePass: true })).toThrow(/Command failed|Unexpected token/u);
    expect(fs.readFileSync(target)).toEqual(original);
    expect(fs.existsSync(path.join(runtimeRoot, PATCH_MANIFEST_FILENAME))).toBe(false);
  });
  test('packaging relies on the target-version manifest instead of legacy patch strings', () => {
    const hookSource = fs.readFileSync(
      path.resolve(__dirname, '../../..', 'scripts', 'packaging', 'electron-builder-hooks.cjs'),
      'utf8',
    );

    expect(hookSource).toContain('verifyOpenClawPatchManifest(runtimeRoot');
    expect(hookSource).not.toContain('verifyOpenClawReasoningStreamPatches');
    expect(hookSource).not.toContain('strict streaming for content reasoning tags');
  });

  test('an mtime-fresh bundle is skipped only when its patch proof is current', () => {
    const bundleSource = fs.readFileSync(
      path.resolve(__dirname, '../../..', 'scripts', 'openclaw', 'bundle-openclaw-gateway.cjs'),
      'utf8',
    );
    const freshnessCheck = bundleSource.indexOf('bundleStat.mtimeMs >');
    const proofCheck = bundleSource.indexOf(
      'const manifest = verifyOpenClawPatchManifest(runtimeDir',
      freshnessCheck,
    );
    const skipExit = bundleSource.indexOf('process.exit(0);', proofCheck);
    const staleRebuild = bundleSource.indexOf('Bundle proof is stale or missing', skipExit);
    const bundleStart = bundleSource.indexOf('Bundling:', staleRebuild);

    expect(freshnessCheck).toBeGreaterThan(-1);
    expect(proofCheck).toBeGreaterThan(freshnessCheck);
    expect(skipExit).toBeGreaterThan(proofCheck);
    expect(staleRebuild).toBeGreaterThan(skipExit);
    expect(bundleStart).toBeGreaterThan(staleRebuild);
    expect(bundleSource).not.toContain('ensureOpenClawRuntimePatches');
  });

  test('accepts dated npm revisions and rejects malformed OpenClaw versions', () => {
    expect(normalizeOpenClawVersion('2026.7.1-2')).toBe('v2026.7.1-2');
    expect(normalizeOpenClawVersion('v2026.7.1-2')).toBe('v2026.7.1-2');
    expect(() => normalizeOpenClawVersion('v2026.7')).toThrow('Invalid OpenClaw version');
    expect(() => normalizeOpenClawVersion('latest')).toThrow('Invalid OpenClaw version');
  });

  test('writes the proof only after the complete patch pass succeeds', () => {
    const { repoRoot, runtimeRoot } = createFixture();

    const results = patchOpenClawRuntime(runtimeRoot, { repoRoot, freshBundlePass: true });

    expect(results).toHaveLength(2);
    expect(fs.existsSync(path.join(runtimeRoot, PATCH_MANIFEST_FILENAME))).toBe(true);
    expect(() => verifyOpenClawPatchManifest(runtimeRoot, { repoRoot })).not.toThrow();
  });

  test('reuses a complete frozen runtime when only current build inputs changed', () => {
    const { repoRoot, runtimeRoot } = createFixture();
    patchOpenClawRuntime(runtimeRoot, { repoRoot, freshBundlePass: true });
    fs.appendFileSync(
      path.join(repoRoot, 'scripts', 'openclaw', 'bundle-openclaw-gateway.cjs'),
      '// changed\n',
    );

    expect(() =>
      verifyFrozenOpenClawRuntime(runtimeRoot, {
        expectedTarget: 'win-x64',
        requireBundle: true,
      }),
    ).not.toThrow();
    expect(() => verifyOpenClawPatchManifest(runtimeRoot, { repoRoot })).toThrow(
      /source proof is missing, incomplete, or stale/,
    );
  });

  test('rejects a complete frozen runtime from a different OpenClaw version', () => {
    const { repoRoot, runtimeRoot } = createFixture();
    patchOpenClawRuntime(runtimeRoot, { repoRoot, freshBundlePass: true });

    expect(() =>
      verifyFrozenOpenClawRuntime(runtimeRoot, {
        expectedTarget: 'win-x64',
        expectedVersion: 'v2026.10.6',
      }),
    ).toThrow(/OpenClaw version is v2026\.6\.11, expected v2026\.10\.6/);
  });

  test('rejects missing native workers in an otherwise valid frozen bundle', () => {
    const { repoRoot, runtimeRoot } = createFixture();
    fs.appendFileSync(
      path.join(runtimeRoot, 'gateway-bundle.mjs'),
      'function runtimeProcessEntrypoint(name) { return name; }\n' +
        'runtimeProcessEntrypoint("config/sessions/session-transcript.worker");\n' +
        'runtimeProcessEntrypoint("cron/store/read-only.worker");\n',
    );
    patchOpenClawRuntime(runtimeRoot, { repoRoot, freshBundlePass: true });

    expect(() => verifyFrozenOpenClawRuntime(runtimeRoot, { requireBundle: true })).toThrow(
      /companion files.*session-transcript\.worker\.js.*read-only\.worker\.js/,
    );
    expect(() => verifyOpenClawPatchManifest(runtimeRoot, { repoRoot })).toThrow(
      /companion files.*session-transcript\.worker\.js.*read-only\.worker\.js/,
    );

    for (const name of [
      'config/sessions/session-transcript.worker',
      'cron/store/read-only.worker',
    ]) {
      const filePath = path.join(runtimeRoot, 'dist', name + '.js');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, '// frozen worker');
    }
    expect(() => verifyFrozenOpenClawRuntime(runtimeRoot, { requireBundle: true })).not.toThrow();
    expect(() => verifyOpenClawPatchManifest(runtimeRoot, { repoRoot })).not.toThrow();
  });

  test('rejects a frozen runtime with a missing patch proof or tampered bundle', () => {
    const { repoRoot, runtimeRoot } = createFixture();

    expect(() => verifyFrozenOpenClawRuntime(runtimeRoot, { requireBundle: true })).toThrow(
      /patch manifest is missing or invalid/,
    );

    patchOpenClawRuntime(runtimeRoot, { repoRoot, freshBundlePass: true });
    fs.appendFileSync(path.join(runtimeRoot, 'gateway-bundle.mjs'), '// tampered\n');

    expect(() => verifyFrozenOpenClawRuntime(runtimeRoot, { requireBundle: true })).toThrow(
      /does not match the frozen patch manifest/,
    );
  });

  test('rejects damaged frozen source artifacts instead of silently rebuilding them', () => {
    const { runtimeRoot } = createFixture();
    fs.appendFileSync(path.join(runtimeRoot, 'gateway.asar'), 'tampered\n');

    expect(() => verifyFrozenOpenClawRuntime(runtimeRoot, { expectedTarget: 'win-x64' })).toThrow(
      /gateway\.asar does not match runtime-build-info\.json/,
    );
  });

  test('rejects incomplete frozen metadata and mismatched source identity', () => {
    const { repoRoot, runtimeRoot } = createFixture();
    patchOpenClawRuntime(runtimeRoot, { repoRoot, freshBundlePass: true });
    const buildInfoPath = path.join(runtimeRoot, 'runtime-build-info.json');
    const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, 'utf8')) as Record<string, unknown>;
    delete buildInfo.patchSetSha256;
    fs.writeFileSync(buildInfoPath, JSON.stringify(buildInfo));

    expect(() => verifyFrozenOpenClawRuntime(runtimeRoot, { requireBundle: true })).toThrow(
      /patchSetSha256 is not a SHA-256 digest/,
    );

    writeFixtureBuildInfo(repoRoot, runtimeRoot);
    const manifestPath = path.join(runtimeRoot, PATCH_MANIFEST_FILENAME);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.sourcePackage = { npmVersion: 'invalid' };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));

    expect(() => verifyFrozenOpenClawRuntime(runtimeRoot, { requireBundle: true })).toThrow(
      /source package does not match runtime-build-info\.json/,
    );
  });

  test('shares the target-version snapshot index across apply and final verification', () => {
    const { patchRoot, repoRoot, runtimeRoot } = createFixture();
    const patchUtilsPath = path.resolve(
      __dirname,
      '../../..',
      'scripts',
      'patches',
      'v2026.10.6',
      '_patch-utils.js',
    );
    fs.writeFileSync(
      path.join(patchRoot, '_patch-utils.js'),
      `module.exports = require(${JSON.stringify(patchUtilsPath)});\n`,
    );
    fs.writeFileSync(
      path.join(patchRoot, '001-example.cjs'),
      `const path = require('path');
      const { findFilesContaining, writeIfChanged } = require('./_patch-utils.js');
      module.exports = {
        applyPatch(root) {
          const [file] = findFilesContaining(root, 'const patched = true;');
          const original = require('fs').readFileSync(file, 'utf8');
          writeIfChanged(file, original, original + 'const firstIndexed = true;\\n');
        },
        verifyPatch(root) {
          if (findFilesContaining(root, 'const firstIndexed = true;').length !== 1) {
            throw new Error('first indexed patch missing');
          }
        },
      };\n`,
    );
    fs.writeFileSync(
      path.join(patchRoot, '002-example.cjs'),
      `const { findFilesContaining } = require('./_patch-utils.js');
      module.exports = {
        applyPatch(root) {
          if (findFilesContaining(root, 'const firstIndexed = true;').length !== 1) {
            throw new Error('updated index was not visible');
          }
          return [];
        },
        verifyPatch(root) {
          if (findFilesContaining(root, 'const firstIndexed = true;').length !== 1) {
            throw new Error('updated index was not preserved');
          }
        },
      };\n`,
    );
    writeFixtureBuildInfo(repoRoot, runtimeRoot);

    expect(() =>
      patchOpenClawRuntime(runtimeRoot, { repoRoot, freshBundlePass: true }),
    ).not.toThrow();
    expect(fs.readFileSync(path.join(runtimeRoot, 'gateway-bundle.mjs'), 'utf8')).toContain(
      'const firstIndexed = true;',
    );
  });

  test.each(
    [PROVIDER_TRANSPORT_PATH, PROVIDER_PARTITIONER_PATH].flatMap(target =>
      ['none', 'apply', 'verify'].map(failure => ({ target, failure })),
    ),
  )(
    'indexes the exact provider module $target and restores its bytes after $failure failure',
    ({ target, failure }) => {
      const { patchRoot, repoRoot, runtimeRoot } = createFixture('v2026.10.6');
      const provider = path.join(runtimeRoot, target);
      const foreign = path.join(path.dirname(provider), 'unowned-provider.mjs');
      const original = fs.readFileSync(provider);
      const marker = original.toString('utf8').trim();
      fs.writeFileSync(foreign, original);
      const bundle = fs.readFileSync(path.join(runtimeRoot, 'gateway-bundle.mjs'));
      fs.writeFileSync(
        path.join(patchRoot, '_patch-utils.js'),
        `module.exports = require(${JSON.stringify(path.resolve('scripts/patches/v2026.10.6/_patch-utils.js'))});\n`,
      );
      fs.writeFileSync(
        path.join(patchRoot, '001-example.cjs'),
        `const fs = require('fs');
        const { findFilesContaining, writeIfChanged } = require('./_patch-utils.js');
        module.exports = {
          applyPatch(root) {
            const matches = findFilesContaining(root, ${JSON.stringify(marker)});
            if (matches.length !== 1) throw new Error('provider inventory widened');
            const source = fs.readFileSync(matches[0], 'utf8');
            writeIfChanged(matches[0], source, source + 'const indexedProvider = true;\\n');
          },
          verifyPatch(root) {
            if (findFilesContaining(root, 'const indexedProvider = true;').length !== 1)
              throw new Error('provider index stale');
          },
        };`,
      );
      fs.writeFileSync(
        path.join(patchRoot, '002-example.cjs'),
        `const { findFilesContaining } = require('./_patch-utils.js');
        module.exports = {
          applyPatch(root) {
            if (findFilesContaining(root, 'const indexedProvider = true;').length !== 1)
              throw new Error('provider index stale');
            ${failure === 'apply' ? "throw new Error('provider apply failed');" : ''}
          },
          verifyPatch() { ${failure === 'verify' ? "throw new Error('provider verify failed');" : ''} },
        };`,
      );
      writeFixtureBuildInfo(repoRoot, runtimeRoot);

      const apply = () => patchOpenClawRuntime(runtimeRoot, { repoRoot, freshBundlePass: true });
      if (failure === 'none') {
        expect(apply).not.toThrow();
        expect(fs.readFileSync(provider, 'utf8')).toContain('const indexedProvider = true;');
      } else {
        expect(apply).toThrow(`provider ${failure} failed`);
        expect(fs.readFileSync(provider)).toEqual(original);
        expect(fs.readFileSync(path.join(runtimeRoot, 'gateway-bundle.mjs'))).toEqual(bundle);
        expect(fs.existsSync(path.join(runtimeRoot, PATCH_MANIFEST_FILENAME))).toBe(false);
      }
      expect(fs.readFileSync(foreign)).toEqual(original);
    },
  );

  test.each(['transport', 'partitioner', 'metadata', 'missing-transport', 'missing-partitioner'])(
    'rejects a changed provider %s in both current and frozen runtime proofs',
    change => {
      const { repoRoot, runtimeRoot } = createFixture('v2026.10.6');
      patchOpenClawRuntime(runtimeRoot, { repoRoot, freshBundlePass: true });
      const manifest = JSON.parse(
        fs.readFileSync(path.join(runtimeRoot, PATCH_MANIFEST_FILENAME), 'utf8'),
      );
      expect(manifest.patchDependencyArtifacts.map((entry: { path: string }) => entry.path)).toEqual([
        PROVIDER_PACKAGE_PATH,
        FS_SAFE_PACKAGE_PATH,
        PROVIDER_TRANSPORT_PATH,
        PROVIDER_PARTITIONER_PATH,
        FS_SAFE_MOVE_PATH,
        FS_SAFE_GUARDED_MUTATION_PATH,
        'node_modules/@openclaw/ai/dist/transports.mjs',
        'node_modules/@openclaw/ai/dist/providers.mjs',
        'node_modules/@openclaw/ai/dist/openai-completions-BkRt2Iy4.mjs',
        PLUGIN_PUBLICATION_SUPPORT_PATH,
      ]);
      const target = path.join(
        runtimeRoot,
        change === 'metadata'
          ? PROVIDER_PACKAGE_PATH
          : change.endsWith('partitioner')
            ? PROVIDER_PARTITIONER_PATH
            : PROVIDER_TRANSPORT_PATH,
      );
      if (change.startsWith('missing')) fs.unlinkSync(target);
      else fs.appendFileSync(target, change === 'metadata' ? '\n ' : '// changed\n');

      expect(() => verifyOpenClawPatchManifest(runtimeRoot, { repoRoot })).toThrow(
        /dependencies|ENOENT/,
      );
      expect(() => verifyFrozenOpenClawRuntime(runtimeRoot, { requireBundle: true })).toThrow(
        /dependencies/,
      );
    },
  );

  test('rejects provider package identity mismatches before creating proof', () => {
    const { repoRoot, runtimeRoot } = createFixture('v2026.10.6');
    fs.writeFileSync(
      path.join(runtimeRoot, PROVIDER_PACKAGE_PATH),
      JSON.stringify({ name: '@openclaw/ai', version: '2026.10.3' }),
    );
    expect(() => writeOpenClawPatchManifest(runtimeRoot, { repoRoot })).toThrow(
      'Runtime patch dependency must be @openclaw/ai@2026.10.6',
    );
  });

  test.each([FS_SAFE_MOVE_PATH, FS_SAFE_GUARDED_MUTATION_PATH, FS_SAFE_PACKAGE_PATH, PLUGIN_PUBLICATION_SUPPORT_PATH])(
    'rejects changed filesystem publication dependency %s', artifact => {
      const { repoRoot, runtimeRoot } = createFixture('v2026.10.6');
      writeOpenClawPatchManifest(runtimeRoot, { repoRoot });
      fs.appendFileSync(path.join(runtimeRoot, artifact), '\n ');
      expect(() => verifyOpenClawPatchManifest(runtimeRoot, { repoRoot })).toThrow(/dependencies/);
      expect(() => verifyFrozenOpenClawRuntime(runtimeRoot, { requireBundle: true })).toThrow(/dependencies/);
    },
  );

  test('rejects an unproven filesystem package version', () => {
    const { repoRoot, runtimeRoot } = createFixture('v2026.10.6');
    fs.writeFileSync(path.join(runtimeRoot, FS_SAFE_PACKAGE_PATH), JSON.stringify({ name: '@openclaw/fs-safe', version: '0.24.1' }));
    expect(() => writeOpenClawPatchManifest(runtimeRoot, { repoRoot })).toThrow('@openclaw/fs-safe@0.25.0');
  });

  test('skips the patch pass when the recorded patch set and bundle are unchanged', () => {
    const { patchRoot, repoRoot, runtimeRoot } = createFixture();
    const counterPath = path.join(runtimeRoot, 'apply-count.txt').replace(/\\/g, '\\\\');
    const countingPatch = `
const fs = require('fs');
const path = require('path');
function applyPatch(runtimeRoot) {
  const counterPath = '${counterPath}';
  const count = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) : 0;
  fs.writeFileSync(counterPath, String(count + 1));
  const bundlePath = path.join(runtimeRoot, 'gateway-bundle.mjs');
  const content = fs.readFileSync(bundlePath, 'utf8');
  if (!content.includes('const verified = true;')) {
    fs.appendFileSync(bundlePath, 'const verified = true;\\n');
  }
}
function verifyPatch(runtimeRoot) {
  const content = fs.readFileSync(path.join(runtimeRoot, 'gateway-bundle.mjs'), 'utf8');
  if (!content.includes('const verified = true;')) throw new Error('patch verification failed');
}
module.exports = { applyPatch, verifyPatch };
`;
    fs.writeFileSync(path.join(patchRoot, '001-example.cjs'), countingPatch);
    fs.writeFileSync(path.join(patchRoot, '002-example.cjs'), countingPatch);
    writeFixtureBuildInfo(repoRoot, runtimeRoot);
    patchOpenClawRuntime(runtimeRoot, { repoRoot, freshBundlePass: true });

    const result = ensureOpenClawRuntimePatches(runtimeRoot, { repoRoot });

    expect(result.cached).toBe(true);
    expect(fs.readFileSync(path.join(runtimeRoot, 'apply-count.txt'), 'utf8')).toBe('2');
  });

  test('does not write proof when any patch fails', () => {
    const { patchRoot, repoRoot, runtimeRoot } = createFixture();
    const bundlePath = path.join(runtimeRoot, 'gateway-bundle.mjs');
    const originalBundle = fs.readFileSync(bundlePath);
    fs.writeFileSync(
      path.join(patchRoot, '002-example.cjs'),
      "module.exports = { applyPatch() { throw new Error('patch failed'); }, verifyPatch() {} };\n",
    );
    writeFixtureBuildInfo(repoRoot, runtimeRoot);

    expect(() => patchOpenClawRuntime(runtimeRoot, { repoRoot, freshBundlePass: true })).toThrow(
      'patch failed',
    );
    expect(fs.existsSync(path.join(runtimeRoot, PATCH_MANIFEST_FILENAME))).toBe(false);
    expect(fs.readFileSync(bundlePath)).toEqual(originalBundle);
  });

  test.each([
    'gateway-bundle.mjs',
    'dist/worker/worker.mjs',
    'dist/worker/sqlite-store.worker.mjs',
    PROVIDER_TRANSPORT_PATH,
    PROVIDER_PARTITIONER_PATH,
  ])('rolls back invalid JavaScript in %s before writing proof', target => {
    const { patchRoot, repoRoot, runtimeRoot } = createFixture();
    const targetPath = path.join(runtimeRoot, target);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    if (!fs.existsSync(targetPath)) fs.writeFileSync(targetPath, 'const original = true;\n');
    const original = fs.readFileSync(targetPath);
    fs.writeFileSync(
      path.join(patchRoot, '002-example.cjs'),
      `
        const fs = require('fs'); const path = require('path');
        module.exports = {
          applyPatch(root) { fs.appendFileSync(path.join(root, '${target}'), '\\nconst duplicate = 1; const duplicate = 2;'); },
          verifyPatch() {},
        };
      `,
    );
    writeFixtureBuildInfo(repoRoot, runtimeRoot);
    expect(() => patchOpenClawRuntime(runtimeRoot, { repoRoot, freshBundlePass: true })).toThrow();
    expect(fs.readFileSync(targetPath)).toEqual(original);
    expect(fs.existsSync(path.join(runtimeRoot, PATCH_MANIFEST_FILENAME))).toBe(false);
  });

  test('rejects a silent no-op patch without applied-state evidence', () => {
    const { patchRoot, repoRoot, runtimeRoot } = createFixture();
    const bundlePath = path.join(runtimeRoot, 'gateway-bundle.mjs');
    const originalBundle = fs.readFileSync(bundlePath);
    fs.writeFileSync(
      path.join(patchRoot, '002-example.cjs'),
      `module.exports = {
        applyPatch() { return []; },
        verifyPatch() { throw new Error('patch was not applied'); },
      };\n`,
    );
    writeFixtureBuildInfo(repoRoot, runtimeRoot);

    expect(() => patchOpenClawRuntime(runtimeRoot, { repoRoot, freshBundlePass: true })).toThrow(
      'patch was not applied',
    );
    expect(fs.existsSync(path.join(runtimeRoot, PATCH_MANIFEST_FILENAME))).toBe(false);
    expect(fs.readFileSync(bundlePath)).toEqual(originalBundle);
  });

  test('defers verification until the gateway bundle has been generated', () => {
    const { patchRoot, repoRoot, runtimeRoot } = createFixture();
    fs.rmSync(path.join(runtimeRoot, 'gateway-bundle.mjs'));
    fs.writeFileSync(
      path.join(patchRoot, '001-example.cjs'),
      `module.exports = {
        applyPatch() { return []; },
        verifyPatch() { throw new Error('must be deferred'); },
      };\n`,
    );
    fs.writeFileSync(
      path.join(patchRoot, '002-example.cjs'),
      `module.exports = {
        applyPatch() { return []; },
        verifyPatch() { throw new Error('must be deferred'); },
      };\n`,
    );

    expect(() =>
      patchOpenClawRuntime(runtimeRoot, { repoRoot, pristineInstallPass: true }),
    ).not.toThrow();
    expect(fs.existsSync(path.join(runtimeRoot, PATCH_MANIFEST_FILENAME))).toBe(false);
  });

  test('verifies every patch against the final bundle after all patches run', () => {
    const { patchRoot, repoRoot, runtimeRoot } = createFixture();
    fs.writeFileSync(
      path.join(patchRoot, '001-example.cjs'),
      `const fs = require('fs'); const path = require('path');
      module.exports = {
        applyPatch(root) { fs.appendFileSync(path.join(root, 'gateway-bundle.mjs'), 'first-marker\\n'); },
        verifyPatch(root) {
          if (!fs.readFileSync(path.join(root, 'gateway-bundle.mjs'), 'utf8').includes('first-marker')) {
            throw new Error('first patch was overwritten');
          }
        },
      };\n`,
    );
    fs.writeFileSync(
      path.join(patchRoot, '002-example.cjs'),
      `const fs = require('fs'); const path = require('path');
      module.exports = {
        applyPatch(root) {
          const file = path.join(root, 'gateway-bundle.mjs');
          fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('first-marker', 'second-marker'));
        },
        verifyPatch(root) {
          if (!fs.readFileSync(path.join(root, 'gateway-bundle.mjs'), 'utf8').includes('second-marker')) {
            throw new Error('second patch missing');
          }
        },
      };\n`,
    );
    writeFixtureBuildInfo(repoRoot, runtimeRoot);

    expect(() => patchOpenClawRuntime(runtimeRoot, { repoRoot, freshBundlePass: true })).toThrow(
      'first patch was overwritten',
    );
    expect(fs.existsSync(path.join(runtimeRoot, PATCH_MANIFEST_FILENAME))).toBe(false);
  });

  test('verifies the exact patch set and packaged gateway bundle bytes', () => {
    const { repoRoot, runtimeRoot } = createFixture();

    const { manifestPath } = writeOpenClawPatchManifest(runtimeRoot, { repoRoot });
    const verified = verifyOpenClawPatchManifest(runtimeRoot, { repoRoot });

    expect(manifestPath).toBe(path.join(runtimeRoot, PATCH_MANIFEST_FILENAME));
    expect(verified.patches.map(patch => patch.file)).toEqual([
      'scripts/patches/v2026.6.11/001-example.cjs',
      'scripts/patches/v2026.6.11/002-example.cjs',
    ]);
  });

  test('freezes selected native database owners separately from complete runtime source proof', () => {
    const { repoRoot, runtimeRoot } = createFixture('v2026.10.6');
    const { manifestPath } = writeOpenClawPatchManifest(runtimeRoot, { repoRoot });
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const contract = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src/main/startup/upgrade/nativeDatabaseContract.json'), 'utf8'));
    const { canonicalJson } = require('../../../scripts/openclaw/native-database-contract.cjs');
    expect(manifest.nativeDatabaseOwners.contractSha256).toBe(crypto.createHash('sha256').update(canonicalJson(contract)).digest('hex'));
    expect(manifest.nativeDatabaseOwners.modules).toHaveLength(Object.keys(contract.modules).length);
    expect(manifest.sourceArtifacts.gatewayAsarSha256).toBeDefined();
    manifest.nativeDatabaseOwners.modules[0].exports.extraProof = 'x';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => verifyOpenClawPatchManifest(runtimeRoot, { repoRoot })).toThrow(/selected-owner proof/);
  });

  test('locks both canonical preparation owners into the eighteen-owner producer proof', () => {
    const target = JSON.parse(fs.readFileSync(path.resolve('src/main/startup/upgrade/nativeDatabaseContract.json'), 'utf8'));
    expect(Object.keys(target.modules)).toHaveLength(18);
    expect(target.modules.canonicalValidation).toEqual({
      path: 'dist/session-canonical-validation-readiness-C_kdXYHx.mjs',
      sha256: '75e3258db0b6487a83b43bd6bfb5ec691ffc49447c19338d812699c75a29299e',
      exports: { certifySessionCanonicalValidationPending: 'certifySessionCanonicalValidationPending' },
    });
    expect(target.modules.canonicalWorker).toEqual({
      path: 'dist/session-accessor.sqlite-reclamation-worker-Ds8kYWwv.mjs',
      sha256: '2c21c16da227cb99f7fcf43861d9cd4dbc69a38cba77229b4277f7df9f4070b3',
      exports: { withSqliteCanonicalValidationWorker: 't' },
    });
    const { repoRoot, runtimeRoot } = createFixture('v2026.10.6');
    const { manifestPath } = writeOpenClawPatchManifest(runtimeRoot, { repoRoot });
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(manifest.nativeDatabaseOwners.modules).toHaveLength(18);
    for (const role of ['canonicalValidation', 'canonicalWorker']) {
      expect(manifest.nativeDatabaseOwners.modules.find((owner: { role: string }) => owner.role === role))
        .toMatchObject({ role, path: target.modules[role].path, exports: target.modules[role].exports });
    }
    expect(() => verifyOpenClawPatchManifest(runtimeRoot, { repoRoot })).not.toThrow();
  });

  test.each(
    ['canonicalValidation', 'canonicalWorker'].flatMap(role =>
      ['source-bytes', 'archive-bytes', 'export-alias', 'imported-facade'].map(damage => ({ role, damage }))),
  )('rejects damaged canonical owner $role: $damage', ({ role, damage }) => {
    const { repoRoot, runtimeRoot } = createFixture('v2026.10.6');
    const contractPath = path.join(repoRoot, 'src/main/startup/upgrade/nativeDatabaseContract.json');
    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
    const owner = contract.modules[role];
    const file = path.join(runtimeRoot, owner.path);
    const { verifyNativeDatabaseContract } = require('../../../scripts/openclaw/native-database-contract.cjs');
    const options = { repoRoot, version: 'v2026.10.6' };
    expect(() => verifyNativeDatabaseContract(runtimeRoot, options)).not.toThrow();
    if (damage === 'source-bytes') fs.appendFileSync(file, '// damaged canonical source\n');
    if (damage === 'archive-bytes') {
      const original = fs.readFileSync(file);
      fs.appendFileSync(file, '// damaged canonical archive member\n');
      writeNativeOwnerArchive(runtimeRoot, contract.modules);
      fs.writeFileSync(file, original);
    }
    if (damage === 'export-alias' || damage === 'imported-facade') {
      const [symbol, alias] = Object.entries(owner.exports)[0];
      const source = damage === 'export-alias'
        ? `function ${symbol}() {}\nexport { ${symbol} as wrong };\n`
        : `import { ${symbol} } from './not-the-native-owner.mjs';\nexport { ${symbol} as ${alias} };\n`;
      fs.writeFileSync(file, source);
      owner.sha256 = crypto.createHash('sha256').update(source).digest('hex');
      writeNativeOwnerArchive(runtimeRoot, contract.modules);
    }
    fs.writeFileSync(contractPath, JSON.stringify(contract));
    expect(() => verifyNativeDatabaseContract(runtimeRoot, options)).toThrow(/Native database/);
  });

  test.each(['owner-bytes', 'archive-bytes', 'export-alias', 'imported-facade', 'escaped-path', 'schema-generation'])(
    'rejects a damaged selected native database contract: %s', damage => {
      const { repoRoot, runtimeRoot } = createFixture('v2026.10.6');
      const contractPath = path.join(repoRoot, 'src/main/startup/upgrade/nativeDatabaseContract.json');
      const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
      const owner = contract.modules.preflight;
      const ownerPath = path.join(runtimeRoot, owner.path);
      const { verifyNativeDatabaseContract } = require('../../../scripts/openclaw/native-database-contract.cjs');
      const options = { repoRoot, version: 'v2026.10.6' };
      expect(() => verifyNativeDatabaseContract(runtimeRoot, options)).not.toThrow();
      if (damage === 'owner-bytes') fs.appendFileSync(ownerPath, '// changed\n');
      if (damage === 'archive-bytes') {
        fs.appendFileSync(ownerPath, '// different archive copy\n');
        writeNativeOwnerArchive(runtimeRoot, contract.modules);
        fs.writeFileSync(ownerPath, fs.readFileSync(ownerPath, 'utf8').replace('// different archive copy\n', ''));
      }
      if (damage === 'export-alias' || damage === 'imported-facade') {
        const content = damage === 'export-alias' ?
          'function prepareDoctorDatabasePreflight() {}\nexport { prepareDoctorDatabasePreflight as wrong };\n' :
          'import { prepareDoctorDatabasePreflight } from "./elsewhere.mjs";\nexport { prepareDoctorDatabasePreflight as t };\n';
        fs.writeFileSync(ownerPath, content);
        owner.sha256 = crypto.createHash('sha256').update(content).digest('hex');
        writeNativeOwnerArchive(runtimeRoot, contract.modules);
      }
      if (damage === 'escaped-path') owner.path = '../outside.mjs';
      if (damage === 'schema-generation') contract.schemaVersions.agent = 26;
      fs.writeFileSync(contractPath, JSON.stringify(contract));
      expect(() => verifyNativeDatabaseContract(runtimeRoot, options)).toThrow(/Native database/);
    },
  );

  test('selected database owners remain verified when macOS omits the source ASAR', () => {
    const { repoRoot, runtimeRoot } = createFixture();
    const { verifyNativeDatabaseContract } = require('../../../scripts/openclaw/native-database-contract.cjs');
    fs.unlinkSync(path.join(runtimeRoot, 'gateway.asar'));
    expect(() => verifyNativeDatabaseContract(runtimeRoot, { repoRoot, version: 'v2026.6.11' })).toThrow(/archive is missing/);
    expect(() => verifyNativeDatabaseContract(runtimeRoot, { repoRoot, version: 'v2026.6.11', allowOmittedGatewayAsar: true })).not.toThrow();
    const contract = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src/main/startup/upgrade/nativeDatabaseContract.json'), 'utf8'));
    fs.appendFileSync(path.join(runtimeRoot, contract.modules.preflight.path), '// wrong\n');
    expect(() => verifyNativeDatabaseContract(runtimeRoot, { repoRoot, version: 'v2026.6.11', allowOmittedGatewayAsar: true })).toThrow(/owner bytes changed/);
  });

  test('rejects a gateway bundle changed after patches were applied', () => {
    const { repoRoot, runtimeRoot } = createFixture();
    writeOpenClawPatchManifest(runtimeRoot, { repoRoot });

    fs.appendFileSync(path.join(runtimeRoot, 'gateway-bundle.mjs'), 'const stale = true;\n');

    expect(() => verifyOpenClawPatchManifest(runtimeRoot, { repoRoot })).toThrow(
      /gateway-bundle\.mjs does not match/,
    );
  });

  test('rejects patch scripts changed after the runtime was built', () => {
    const { patchRoot, repoRoot, runtimeRoot } = createFixture();
    writeOpenClawPatchManifest(runtimeRoot, { repoRoot });

    fs.appendFileSync(path.join(patchRoot, '002-example.cjs'), '// changed\n');

    expect(() => verifyOpenClawPatchManifest(runtimeRoot, { repoRoot })).toThrow(
      /source proof is missing, incomplete, or stale/,
    );
  });

  test.each([
    'scripts/openclaw/bundle-openclaw-gateway.cjs',
    'src/main/openclaw/config/models/providerProjection.ts',
    'src/main/openclaw/config/speech/nativeTtsConfig.ts',
    'src/main/openclaw/config/speech/localTtsConfig.ts',
    'src/main/openclaw/config/speech/localSpeechExtensionConfig.ts',
    'scripts/openclaw/native-database-contract.cjs',
    'src/main/startup/upgrade/nativeDatabaseContract.json',
    'src/main/startup/upgrade/nativeDatabaseEnvironment.ts',
    'src/main/startup/upgrade/nativeDatabaseIdentity.ts',
    'src/main/startup/upgrade/nativeDatabaseUpgradeSource.ts',
    'src/main/startup/upgrade/nativeDatabaseUpgradeRuntime.ts',
    'src/shared/app/startup/versionPolicy.ts',
    'plugins/extensions/runtime-services/index.ts',
    'plugins/extensions/runtime-services/openclaw.plugin.json',
    'plugins/extensions/runtime-services/package.json',
    'plugins/extensions/runtime-services/contracts/external-mcp.ts',
    'plugins/extensions/runtime-services/external-mcp/index.ts',
    'plugins/extensions/runtime-services/external-mcp/registry.ts',
    'plugins/extensions/runtime-services/external-mcp/transport.ts',
    'plugins/extensions/runtime-services/external-mcp/validation.ts',
  ])('rejects a build recipe source changed after the runtime was built: %s', source => {
    const { repoRoot, runtimeRoot } = createFixture();
    writeOpenClawPatchManifest(runtimeRoot, { repoRoot });

    const sourceFile = path.join(repoRoot, source);
    expect(listBuildRecipeFiles(repoRoot)).toContain(sourceFile);
    fs.appendFileSync(sourceFile, '// changed\n');

    expect(() => verifyOpenClawPatchManifest(runtimeRoot, { repoRoot })).toThrow(
      /source proof is missing, incomplete, or stale/,
    );
  });

  test('rejects a trusted Node CA preload producer changed after the runtime was built', () => {
    const { repoRoot, runtimeRoot } = createFixture();
    const certificateSource = path.join(repoRoot, 'src/main/core/network/trustedCertificates.ts');
    expect(listBuildRecipeFiles(repoRoot)).toContain(certificateSource);
    writeOpenClawPatchManifest(runtimeRoot, { repoRoot });
    fs.appendFileSync(certificateSource, '// changed\n');
    expect(() => verifyOpenClawPatchManifest(runtimeRoot, { repoRoot })).toThrow(
      /source proof is missing, incomplete, or stale/,
    );
  });

  test('rejects a native tool-validation loop support change after the runtime was built', () => {
    const { repoRoot, runtimeRoot } = createFixture();
    const loopSource = path.join(repoRoot, 'plugins/extensions/runtime-services/tool-call-recovery/loop.mjs');
    expect(listBuildRecipeFiles(repoRoot)).toContain(loopSource);
    writeOpenClawPatchManifest(runtimeRoot, { repoRoot });
    fs.appendFileSync(loopSource, '// changed native loop\n');
    expect(() => verifyOpenClawPatchManifest(runtimeRoot, { repoRoot })).toThrow(
      /source proof is missing, incomplete, or stale/,
    );
  });

  test('rejects changed native Goal continuation admission support after the runtime was built', () => {
    const { repoRoot, runtimeRoot } = createFixture();
    const supportSource = path.join(repoRoot, 'src/main/openclaw/runtime/native-support/goal-continuation.mjs');
    expect(listBuildRecipeFiles(repoRoot)).toContain(supportSource);
    writeOpenClawPatchManifest(runtimeRoot, { repoRoot });
    fs.appendFileSync(supportSource, '// changed Goal admission\n');
    expect(() => verifyOpenClawPatchManifest(runtimeRoot, { repoRoot })).toThrow(
      /source proof is missing, incomplete, or stale/,
    );
  });

  test('rejects an MXC plugin patch recipe changed after the runtime was built', () => {
    const { repoRoot, runtimeRoot } = createFixture();
    writeOpenClawPatchManifest(runtimeRoot, { repoRoot });

    fs.appendFileSync(
      path.join(repoRoot, 'scripts', 'openclaw', 'patch-mxc-sandbox-plugin.cjs'),
      '// changed\n',
    );

    expect(() => verifyOpenClawPatchManifest(runtimeRoot, { repoRoot })).toThrow(
      /source proof is missing, incomplete, or stale/,
    );
  });

  test('rejects a patch helper changed after the runtime was built', () => {
    const { patchRoot, repoRoot, runtimeRoot } = createFixture();
    const helperPath = path.join(patchRoot, '_patch-utils.js');
    fs.writeFileSync(helperPath, 'module.exports = {};\n');
    writeFixtureBuildInfo(repoRoot, runtimeRoot);
    writeOpenClawPatchManifest(runtimeRoot, { repoRoot });

    fs.appendFileSync(helperPath, '// changed\n');

    expect(() => verifyOpenClawPatchManifest(runtimeRoot, { repoRoot })).toThrow(
      /source proof is missing, incomplete, or stale/,
    );
  });

  test('refuses to relabel a stale runtime with the current patch set', () => {
    const { patchRoot, repoRoot, runtimeRoot } = createFixture();
    patchOpenClawRuntime(runtimeRoot, { repoRoot, freshBundlePass: true });
    fs.appendFileSync(path.join(patchRoot, '002-example.cjs'), '// changed\n');

    expect(() => patchOpenClawRuntime(runtimeRoot, { repoRoot })).toThrow(
      /Refusing to patch an unknown or stale OpenClaw runtime/,
    );
  });

  test('refuses to patch a bundle whose existing proof no longer matches its bytes', () => {
    const { repoRoot, runtimeRoot } = createFixture();
    patchOpenClawRuntime(runtimeRoot, { repoRoot, freshBundlePass: true });
    fs.appendFileSync(path.join(runtimeRoot, 'gateway-bundle.mjs'), 'tampered\n');

    expect(() => patchOpenClawRuntime(runtimeRoot, { repoRoot })).toThrow(
      /Refusing to patch an unproven OpenClaw bundle/,
    );
  });

  test('requires build-info source identity to match the audited source lock', () => {
    const { repoRoot, runtimeRoot } = createFixture();
    writeFixtureBuildInfo(repoRoot, runtimeRoot, {
      npmIntegrity: `sha512-${Buffer.alloc(64, 8).toString('base64')}`,
    });

    expect(() => writeOpenClawPatchManifest(runtimeRoot, { repoRoot })).toThrow(
      /source proof is missing, incomplete, or stale/,
    );
  });

  test('rejects the wrong packaging target even when the manifest is self-consistent', () => {
    const { repoRoot, runtimeRoot } = createFixture();
    writeOpenClawPatchManifest(runtimeRoot, { repoRoot });

    expect(() =>
      verifyOpenClawPatchManifest(runtimeRoot, { repoRoot, expectedTarget: 'linux-x64' }),
    ).toThrow(/expected packaging target linux-x64/);
  });

  test('rejects immutable runtime artifacts changed after installation', () => {
    const { repoRoot, runtimeRoot } = createFixture();
    writeOpenClawPatchManifest(runtimeRoot, { repoRoot });
    fs.appendFileSync(path.join(runtimeRoot, 'gateway.asar'), 'tampered\n');

    expect(() => verifyOpenClawPatchManifest(runtimeRoot, { repoRoot })).toThrow(
      /source proof is missing, incomplete, or stale/,
    );
  });

  test('rejects a production dependency lock changed after installation', () => {
    const { repoRoot, runtimeRoot } = createFixture();
    writeOpenClawPatchManifest(runtimeRoot, { repoRoot });
    fs.appendFileSync(path.join(runtimeRoot, 'npm-shrinkwrap.json'), 'tampered\n');

    expect(() => verifyOpenClawPatchManifest(runtimeRoot, { repoRoot })).toThrow(
      /source proof is missing, incomplete, or stale/,
    );
  });

  test('binds the manifest to npm source identity and target', () => {
    const { repoRoot, runtimeRoot } = createFixture();
    writeFixtureBuildInfo(repoRoot, runtimeRoot);
    writeOpenClawPatchManifest(runtimeRoot, { repoRoot });

    writeFixtureBuildInfo(repoRoot, runtimeRoot, { target: 'linux-x64' });

    expect(() => verifyOpenClawPatchManifest(runtimeRoot, { repoRoot })).toThrow(/runtime target/);
  });

  test('rejects a runtime without proof that all patches completed', () => {
    const { repoRoot, runtimeRoot } = createFixture();

    expect(() => verifyOpenClawPatchManifest(runtimeRoot, { repoRoot })).toThrow(
      /patch manifest is missing/,
    );
  });

  test('accepts omitted archives only when all bare CLI helpers remain', () => {
    const { repoRoot, runtimeRoot } = createFixture();
    writeOpenClawPatchManifest(runtimeRoot, { repoRoot });
    fs.rmSync(path.join(runtimeRoot, 'gateway.asar'));
    for (const name of cliRuntimeFiles) {
      fs.writeFileSync(path.join(runtimeRoot, name), 'export {};');
    }

    expect(() =>
      verifyOpenClawPatchManifest(runtimeRoot, { repoRoot, allowOmittedGatewayAsar: true }),
    ).not.toThrow();
    fs.rmSync(path.join(runtimeRoot, 'cli-root-options.mjs'));
    expect(() =>
      verifyOpenClawPatchManifest(runtimeRoot, { repoRoot, allowOmittedGatewayAsar: true }),
    ).toThrow('cli-root-options.mjs');
  });

  test.each([
    { includeCompanion: true, providerChange: 'none', nativeChange: 'none' },
    { includeCompanion: false, providerChange: 'none', nativeChange: 'none' },
    { includeCompanion: true, providerChange: 'missing', nativeChange: 'none' },
    { includeCompanion: true, providerChange: 'changed', nativeChange: 'none' },
    { includeCompanion: true, providerChange: 'partitioner-missing', nativeChange: 'none' },
    { includeCompanion: true, providerChange: 'partitioner-changed', nativeChange: 'none' },
    { includeCompanion: true, providerChange: 'none', nativeChange: 'missing-proof' },
    { includeCompanion: true, providerChange: 'none', nativeChange: 'wrong-contract' },
    { includeCompanion: true, providerChange: 'none', nativeChange: 'owner-bytes' },
  ])('checks archived proof: companion=$includeCompanion provider=$providerChange native=$nativeChange', async ({ includeCompanion, providerChange, nativeChange }) => {
    const { repoRoot: repositoryRoot } = createFixture('v2026.10.6');
    const sourceLock = readOpenClawSourceLock(repositoryRoot, 'v2026.10.6');
    const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-packaged-patch-test-'));
    temporaryRoots.push(appOutDir);
    const archiveRoot = path.join(appOutDir, 'archive-source');
    const runtimeRoot = path.join(archiveRoot, 'cfmind');
    const resourcesRoot = path.join(appOutDir, 'resources');
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.mkdirSync(resourcesRoot, { recursive: true });
    fs.writeFileSync(
      path.join(runtimeRoot, 'gateway-bundle.mjs'),
      'const identity = "build-info.json"; runtimeProcessEntrypoint("agents/archive-proof.worker");\n',
    );
    fs.writeFileSync(path.join(runtimeRoot, 'build-info.json'), '{}\n');
    const workerPath = path.join(runtimeRoot, 'dist', 'agents', 'archive-proof.worker.js');
    fs.mkdirSync(path.dirname(workerPath), { recursive: true });
    fs.writeFileSync(workerPath, 'export {};\n');
    writeNativeDatabaseFixture(repositoryRoot, runtimeRoot, 'v2026.10.6');
    fs.writeFileSync(path.join(runtimeRoot, 'npm-shrinkwrap.json'), '{}\n');
    writeProviderFixture(runtimeRoot);
    for (const name of cliRuntimeFiles) {
      fs.writeFileSync(path.join(runtimeRoot, name), 'export {};\n');
    }
    fs.mkdirSync(path.join(runtimeRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, 'dist', 'entry.js'), 'export {};\n');
    const acpxFixtureFiles = [
      'dist/extensions/acpx/index.js',
      'dist/extensions/acpx/package.json',
      'dist/extensions/acpx/openclaw.plugin.json',
      'dist/extensions/acpx/.justdo-extension-assembly.json',
      'dist/extensions/acpx/THIRD_PARTY_NOTICES.md',
      'dist/extensions/acpx/node_modules/acpx/dist/runtime.js',
      'dist/extensions/acpx/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js',
      'dist/extensions/acpx/node_modules/@agentclientprotocol/codex-acp/dist/index.js',
    ];
    for (const relativePath of acpxFixtureFiles) {
      const filePath = path.join(runtimeRoot, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, 'fixture\n');
    }
    const mxcFixtureFiles = [
      'dist/extensions/mxc/dist/index.js',
      'dist/extensions/mxc/dist/mxc-spawn-launcher.mjs',
      'dist/extensions/mxc/package.json',
      'dist/extensions/mxc/openclaw.plugin.json',
      'dist/extensions/mxc/node_modules/@microsoft/mxc-sdk/bin/x64/wxc-exec.exe',
      'dist/extensions/mxc/node_modules/@microsoft/mxc-sdk/bin/x64/wxc-host-prep.exe',
      'dist/extensions/mxc/node_modules/@microsoft/mxc-sdk/dist/index.js',
      'dist/extensions/mxc/node_modules/@microsoft/mxc-sdk/LICENSE.md',
      'dist/extensions/mxc/node_modules/node-pty/prebuilds/win32-x64/conpty.node',
    ];
    for (const relativePath of mxcFixtureFiles) {
      const filePath = path.join(runtimeRoot, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, 'fixture\n');
    }
    fs.writeFileSync(path.join(runtimeRoot, 'dist/extensions/mxc/node_modules/@microsoft/mxc-sdk/package.json'),
      JSON.stringify({ name: '@microsoft/mxc-sdk', version: '0.9.0', dependencies: { 'node-pty': '^1.2.0-beta.12' } }));
    fs.writeFileSync(path.join(runtimeRoot, 'dist/extensions/mxc/node_modules/node-pty/package.json'),
      JSON.stringify({ name: 'node-pty', version: '1.2.0-beta.15' }));
    writeWidgetLibraryArchiveFixture(runtimeRoot);
    // Match the local Worker inventory used by the real packaging verifier.
    // These are inert archive fixtures; no installed runtime code is executed.
    const sourceRuntime = path.join(repositoryRoot, 'vendor/openclaw-runtime/current');
    const sourceDist = path.join(sourceRuntime, 'dist');
    if (fs.existsSync(sourceDist)) {
      for (const entry of fs.readdirSync(sourceDist, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !/\.worker\.[cm]?js$/.test(entry.name)) continue;
        const relative = path.relative(sourceRuntime, path.join(entry.parentPath, entry.name));
        if (relative.split(path.sep).includes('node_modules')) continue;
        const filePath = path.join(runtimeRoot, relative);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, 'export {};\n');
      }
    }
    fs.writeFileSync(
      path.join(runtimeRoot, 'runtime-build-info.json'),
      JSON.stringify({
        openclawVersion: 'v2026.10.6',
        installMethod: 'npm-package',
        target: 'win-x64',
        nodeRuntimeManifestSha256: writeNodeFixture(runtimeRoot),
        npmPackageVersion: sourceLock.version,
        npmIntegrity: sourceLock.integrity,
        npmTarballSha256: sourceLock.tarballSha256,
        patchSetSha256: buildOpenClawPatchSetFingerprint(repositoryRoot, 'v2026.10.6'),
        buildRecipeSha256: buildOpenClawBuildRecipeFingerprint(repositoryRoot, 'v2026.10.6'),
        gatewayAsarSha256: crypto
          .createHash('sha256')
          .update(fs.readFileSync(path.join(runtimeRoot, 'gateway.asar')))
          .digest('hex'),
        runtimePackageSha256: crypto
          .createHash('sha256')
          .update(fs.readFileSync(path.join(runtimeRoot, 'package.json')))
          .digest('hex'),
        runtimePackageLockPath: 'npm-shrinkwrap.json',
        runtimePackageLockSha256: crypto
          .createHash('sha256')
          .update(fs.readFileSync(path.join(runtimeRoot, 'npm-shrinkwrap.json')))
          .digest('hex'),
      }),
    );
    writeOpenClawPatchManifest(runtimeRoot, { repoRoot: repositoryRoot });
    fs.rmSync(path.join(runtimeRoot, 'gateway.asar'));
    if (nativeChange === 'missing-proof' || nativeChange === 'wrong-contract') {
      const manifestPath = path.join(runtimeRoot, PATCH_MANIFEST_FILENAME);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (nativeChange === 'missing-proof') delete manifest.nativeDatabaseOwners;
      else manifest.nativeDatabaseOwners.contractSha256 = 'f'.repeat(64);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    }
    if (nativeChange === 'owner-bytes') {
      const contract = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'src/main/startup/upgrade/nativeDatabaseContract.json'), 'utf8'));
      fs.appendFileSync(path.join(runtimeRoot, contract.modules.preflight.path), '// drift after manifest\n');
    }
    if (!includeCompanion) fs.rmSync(workerPath);
    const provider = path.join(
      runtimeRoot,
      providerChange.startsWith('partitioner') ? PROVIDER_PARTITIONER_PATH : PROVIDER_TRANSPORT_PATH,
    );
    if (providerChange.endsWith('missing')) fs.unlinkSync(provider);
    if (providerChange.endsWith('changed')) fs.appendFileSync(provider, '// changed after proof\n');

    const tar = require('tar') as {
      create: (options: { cwd: string; file: string; sync: boolean }, paths: string[]) => void;
    };
    const tarPath = path.join(resourcesRoot, 'win-resources.tar');
    const archivePath = path.join(resourcesRoot, 'win-resources.tar.zst');
    tar.create(
      {
        cwd: archiveRoot,
        file: tarPath,
        sync: true,
      },
      ['cfmind'],
    );
    await compressTarArchive(tarPath, archivePath);
    fs.rmSync(tarPath);
    fs.writeFileSync(
      path.join(resourcesRoot, 'win-resources-metadata.json'),
      '{"schemaVersion":1,"totalEntries":1}\n',
    );

    const verification = verifyPackagedOpenClawRuntime({
        appOutDir,
        electronPlatformName: 'win32',
      }, { repoRoot: repositoryRoot });
    if (nativeChange === 'missing-proof' || nativeChange === 'wrong-contract') await expect(verification).rejects.toThrow(/selected-owner proof/);
    else if (nativeChange === 'owner-bytes') await expect(verification).rejects.toThrow(/owner bytes changed/);
    else if (!includeCompanion) await expect(verification).rejects.toThrow('dist/agents/archive-proof.worker.js');
    else if (providerChange.endsWith('missing')) await expect(verification).rejects.toThrow(/ENOENT/);
    else if (providerChange.endsWith('changed')) await expect(verification).rejects.toThrow(/dependencies/);
    else await expect(verification).resolves.toBeUndefined();
  }, 30_000);
});
