import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import nodeRuntime from '../../../shared/openclaw/nodeRuntime.json';
import contract from './nativeDatabaseContract.json';

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const ordinal = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const isSha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => ordinal(a, b)).map(([key, entry]) => [key, canonical(entry)])) : value;
const expectedOwnerProof = {
  contractSha256: digest(Buffer.from(JSON.stringify(canonical(contract)))),
  modules: Object.entries(contract.modules).sort(([a], [b]) => ordinal(a, b))
    .map(([role, module]) => ({ role, ...module })),
};
const hashFile = async (file: string, stream = createReadStream): Promise<string> => {
  const hash = createHash('sha256');
  for await (const chunk of stream(file)) hash.update(chunk);
  return hash.digest('hex');
};
function physicalArchiveFileSystem(): Pick<typeof import('node:fs'), 'promises' | 'createReadStream'> {
  // Electron's ordinary fs treats an ASAR file as a virtual directory. Only its
  // physical metadata and whole-file hash use original-fs; member reads stay archive-aware.
  if (process.versions.electron)
    return createRequire(__filename)('original-fs') as typeof import('node:fs');
  return { promises: fs, createReadStream };
}
const json = async (file: string): Promise<unknown> => JSON.parse(await fs.readFile(file, 'utf8'));

export type NativeDatabaseRuntimeIdentity = {
  runtimeRoot: string;
  executable: string;
  runtimeVersion: string;
  runtimeBuildId: string;
  manifestSha256: string;
  schemaVersions: { state: number; agent: number };
};

export type NativeDatabaseDeliveryIdentity = Pick<NativeDatabaseRuntimeIdentity,
  'runtimeVersion' | 'runtimeBuildId'>;

/** Delivery routing facts only; this does not admit runtime bytes or native storage. */
export async function readNativeDatabaseDeliveryIdentity(
  runtimeRoot: string,
): Promise<NativeDatabaseDeliveryIdentity> {
  const [pkgBytes, manifestBytes] = await Promise.all([
    fs.readFile(path.join(runtimeRoot, 'package.json')),
    fs.readFile(path.join(runtimeRoot, 'runtime-patch-manifest.json')),
  ]);
  const pkg: unknown = JSON.parse(pkgBytes.toString('utf8'));
  const manifest: unknown = JSON.parse(manifestBytes.toString('utf8'));
  if (!isRecord(pkg) || pkg.name !== 'openclaw' || typeof pkg.version !== 'string' ||
      pkg.version.length > 128 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(pkg.version) ||
      !isRecord(manifest) || manifest.formatVersion !== 2 || manifest.openclawVersion !== `v${pkg.version}`)
    throw new Error('The bundled native runtime delivery metadata is missing or inconsistent.');
  return { runtimeVersion: `v${pkg.version}`, runtimeBuildId: digest(manifestBytes) };
}

/** Selected owners have a version-locked contract; the build separately freezes the dependency graph. */
export async function admitNativeDatabaseRuntime(
  requestedRoot: string,
  options: { readArchiveModule?: (archivePath: string, relativePath: string) => Promise<Uint8Array> } = {},
): Promise<NativeDatabaseRuntimeIdentity> {
  const runtimeRoot = await fs.realpath(requestedRoot);
  const manifestBytes = await fs.readFile(path.join(runtimeRoot, 'runtime-patch-manifest.json'));
  const manifest: unknown = JSON.parse(manifestBytes.toString('utf8'));
  const build = await json(path.join(runtimeRoot, 'runtime-build-info.json'));
  const pkgBytes = await fs.readFile(path.join(runtimeRoot, 'package.json'));
  const pkg: unknown = JSON.parse(pkgBytes.toString('utf8'));
  const hostPlatform = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform as 'win32' | 'darwin' | 'linux'];
  const target = `${hostPlatform}-${process.arch}`;
  const nodeTarget = nodeRuntime.targets[target as keyof typeof nodeRuntime.targets];
  function fail(): never { throw new Error('The bundled native database maintenance runtime is missing or inconsistent.'); }
  if (!isRecord(manifest) || !isRecord(manifest.sourceArtifacts) || !isRecord(manifest.gatewayBundle) ||
      !isRecord(build) || !isRecord(pkg) || !isRecord(pkg.openclaw) || !isRecord(pkg.openclaw.schemaVersions)) fail();
  for (const field of ['runtimePackageSha256', 'runtimePackageLockSha256', 'nodeRuntimeManifestSha256', 'gatewayAsarSha256'])
    if (!isSha(manifest.sourceArtifacts[field]) || !isSha(build[field])) fail();
  if (!isSha(manifest.gatewayBundle.sha256)) fail();
  if (!nodeTarget || manifest.formatVersion !== 2 || manifest.target !== target || build.target !== target ||
      manifest.openclawVersion !== contract.openclawVersion || build.openclawVersion !== contract.openclawVersion ||
      pkg.name !== 'openclaw' || `v${pkg.version}` !== contract.openclawVersion ||
      pkg.openclaw?.schemaVersions?.state !== contract.schemaVersions.state ||
      pkg.openclaw?.schemaVersions?.agent !== contract.schemaVersions.agent ||
      manifest.patchSetSha256 !== build.patchSetSha256 || !isSha(manifest.patchSetSha256) ||
      manifest.buildRecipeSha256 !== build.buildRecipeSha256 || !isSha(manifest.buildRecipeSha256) ||
      JSON.stringify(canonical(manifest.nativeDatabaseOwners)) !== JSON.stringify(canonical(expectedOwnerProof)) ||
      digest(pkgBytes) !== manifest.sourceArtifacts?.runtimePackageSha256 ||
      digest(pkgBytes) !== build.runtimePackageSha256 ||
      manifest.gatewayBundle?.path !== 'gateway-bundle.mjs' ||
      await hashFile(path.join(runtimeRoot, 'gateway-bundle.mjs')) !== manifest.gatewayBundle.sha256) fail();
  for (const [field, buildField] of [
    ['runtimePackageLockSha256', 'runtimePackageLockSha256'],
    ['nodeRuntimeManifestSha256', 'nodeRuntimeManifestSha256'],
    ['gatewayAsarSha256', 'gatewayAsarSha256'],
  ]) if (manifest.sourceArtifacts[field] !== build[buildField]) fail();
  if (manifest.sourceArtifacts.runtimePackageLockPath !== 'npm-shrinkwrap.json' ||
      await hashFile(path.join(runtimeRoot, 'npm-shrinkwrap.json')) !== build.runtimePackageLockSha256) fail();
  const nodeManifestBytes = await fs.readFile(path.join(runtimeRoot, 'node-runtime/node-runtime-manifest.json'));
  const node: unknown = JSON.parse(nodeManifestBytes.toString('utf8'));
  const executable = path.join(runtimeRoot, 'node-runtime', nodeTarget.executable);
  if (!isRecord(node) || !isRecord(node.files)) fail();
  const executableEntry = node.files[nodeTarget.executable];
  if (!isRecord(executableEntry) || !isSha(executableEntry.sha256)) fail();
  if (digest(nodeManifestBytes) !== build.nodeRuntimeManifestSha256 || node.version !== nodeRuntime.version ||
      node.target !== target || node.archiveSha256 !== nodeTarget.sha256 || node.archive !== nodeTarget.archive ||
      node.executable !== nodeTarget.executable ||
      await hashFile(executable) !== executableEntry.sha256) fail();
  const archive = path.join(runtimeRoot, 'gateway.asar');
  const physical = physicalArchiveFileSystem();
  const archivePresent = await physical.promises.stat(archive).then(stat => {
    if (!stat.isFile()) fail();
    return true;
  }, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  // Windows tar packing and macOS/Linux resource filters omit this duplicate archive.
  // The producer proof, original dist owners, bundle, package and Node checks remain mandatory.
  if (archivePresent && await hashFile(archive, physical.createReadStream) !== build.gatewayAsarSha256) fail();
  for (const module of Object.values(contract.modules)) {
    const bytes = await fs.readFile(path.join(runtimeRoot, module.path));
    if (digest(bytes) !== module.sha256) fail();
    const tail = bytes.toString('utf8').slice(bytes.lastIndexOf('\nexport {'));
    for (const [symbol, alias] of Object.entries(module.exports)) {
      const exports = [...tail.matchAll(new RegExp('\\b' + symbol + '(?: as ([\\w$]+))?\\s*[,}]', 'g'))];
      if (exports.length !== 1 || (exports[0][1] ?? symbol) !== alias) fail();
    }
    if (archivePresent) {
      // Electron Main provides archive-aware fs; plain Node tests supply the archive reader.
      const archived = options.readArchiveModule
        ? await options.readArchiveModule(archive, module.path)
        : await fs.readFile(path.join(archive, module.path));
      if (digest(archived) !== module.sha256) fail();
    }
  }
  const manifestSha256 = digest(manifestBytes);
  return { runtimeRoot, executable, runtimeVersion: contract.openclawVersion,
    runtimeBuildId: manifestSha256, manifestSha256, schemaVersions: contract.schemaVersions };
}
