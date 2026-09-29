'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Preserve native module identity between the Gateway bundle and dynamically loaded SDKs. */
function createSharedSdkModulesPlugin(runtimeDir, esbuild) {
  const runtimeRoot = fs.realpathSync(runtimeDir);
  const entry = path.join(runtimeRoot, 'dist', 'plugin-sdk', 'secret-input-runtime.js');
  if (!fs.existsSync(entry)) throw new Error('Missing native secret-input-runtime SDK entry.');
  // Locate the pinned SDK's native state owners through its dependency graph.
  // Pure helpers remain bundled; config/auth/degradation state must have one owner.
  const analysis = esbuild.buildSync({
    absWorkingDir: runtimeRoot,
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  const ownerContracts = [
    'getActiveSecretsRuntimeConfigSnapshot',
    'isSecretOwnerAvailable',
    // Degradation classification uses instanceof across the bundle/SDK boundary.
    'isSecretResolutionError',
    'getRuntimeConfigSnapshot',
    'getRuntimeAuthProfileStoreCredentialsRevision',
    'getAuthoredConfigSecretRef',
    // Config activation calls these native owners; readers/writers must agree.
    'getScopedConfigSnapshotPreparation',
    'getRetainedLegacyDefaultAgentId',
    'getPublishedConfigRuntimeEnvState',
    'clearExecutablePathCache',
    // Auth snapshots cross these cache, ownership, transaction and error boundaries.
    'closeAuthProfileReadPool',
    'resolveSharedAuthStoreOwnership',
    'registerFreshSharedAuthStoreHandoff',
    'markAuthProfileMigrationRequired',
    'loadPersistedAuthProfileStoreAtDatabasePath',
  ];
  const inputs = Object.keys(analysis.metafile.inputs).map(input => {
    const absolute = fs.realpathSync(path.resolve(runtimeRoot, input));
    return { absolute, content: fs.readFileSync(absolute, 'utf8') };
  });
  const shared = new Map();
  for (const contract of ownerContracts) {
    const matches = inputs.filter(input => input.content.includes(`function ${contract}(`));
    if (matches.length !== 1) throw new Error(`Expected one native SDK state owner for ${contract}.`);
    const input = matches[0].absolute;
    const absolute = fs.realpathSync(path.resolve(runtimeRoot, input));
    const relative = path.relative(runtimeRoot, absolute);
    if (!relative.startsWith(`dist${path.sep}`) || relative.split(path.sep).includes('..')) {
      throw new Error('Native SDK dependency escaped the runtime dist directory.');
    }
    shared.set(absolute, `./${relative.replaceAll(path.sep, '/')}`);
  }
  return {
    name: 'openclaw-shared-sdk-modules',
    setup(build) {
      build.onResolve({ filter: /^\.{1,2}[/\\]/ }, args => {
        const candidate = path.resolve(args.resolveDir, args.path);
        if (!fs.existsSync(candidate)) return null;
        const externalPath = shared.get(fs.realpathSync(candidate));
        return externalPath ? { path: externalPath, external: true } : null;
      });
    },
  };
}

module.exports = { createSharedSdkModulesPlugin };
