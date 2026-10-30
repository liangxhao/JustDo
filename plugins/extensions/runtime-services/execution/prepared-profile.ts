import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { MANAGED_EXECUTION_DESCRIPTOR, type ManagedExecutionDescriptor } from '../sdk/execution';

const EXECUTION_PATCH = {
  version: '2026.10.7',
  file: 'scripts/patches/v2026.10.7/019-plugin-owned-execution.cjs',
  sha256: 'd438a372dbff9838dd75e840f0ea3a648cccabec6042d1bc29bfec7cec70aad1',
} as const;

interface Environment {
  resolveSdkCore(): string;
  argvEntry: string | undefined;
}
interface PreparedRuntimeApi {
  rootDir?: string;
  runtime: { version: string; subagent: object };
}
const hashes = new Map<string, { identity: string; sha256: string }>();
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const version = (value: unknown): string | undefined =>
  typeof value === 'string' ? value.replace(/^v/, '') : undefined;
const sha256 = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);

function json(file: string, limit: number): unknown {
  const info = statSync(file);
  if (!info.isFile() || info.size > limit) throw new Error('Invalid prepared profile metadata');
  return JSON.parse(readFileSync(file, 'utf8'));
}
function fileIdentity(file: string): string {
  const info = statSync(file, { bigint: true });
  if (!info.isFile()) throw new Error('Invalid prepared runtime entry');
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
}
function hashRuntime(file: string): string {
  const identity = fileIdentity(file);
  const cached = hashes.get(file);
  if (cached?.identity === identity) return cached.sha256;
  const handle = openSync(file, 'r');
  try {
    const initial = fstatSync(handle, { bigint: true });
    const expectedIdentity = [initial.dev, initial.ino, initial.size, initial.mtimeNs, initial.ctimeNs].join(':');
    if (expectedIdentity !== identity) throw new Error('Prepared runtime entry changed');
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let size: number;
    while ((size = readSync(handle, chunk, 0, chunk.length, null)) > 0)
      hash.update(chunk.subarray(0, size));
    if (fileIdentity(file) !== identity) throw new Error('Prepared runtime entry changed');
    const digest = hash.digest('hex');
    hashes.set(file, { identity, sha256: digest });
    return digest;
  } finally {
    closeSync(handle);
  }
}
function sdkPackage(sdkCore: string): { root: string; version: string | undefined } | undefined {
  let directory = path.dirname(realpathSync(sdkCore));
  for (let depth = 0; depth < 16; depth++) {
    try {
      const pkg = json(path.join(directory, 'package.json'), 1024 * 1024);
      if (record(pkg) && pkg.name === 'openclaw') return { root: directory, version: version(pkg.version) };
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT')
        throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

/** Private adapter for the host's verified prepared artifact; never exported by the public SDK. */
export function readPreparedManagedExecutionDescriptor(
  api: PreparedRuntimeApi,
  environment: Environment = {
    resolveSdkCore: () => createRequire(import.meta.url).resolve('openclaw/plugin-sdk/core'),
    argvEntry: process.argv[1],
  },
): ManagedExecutionDescriptor | undefined {
  try {
    if (!api.rootDir || !environment.argvEntry) return;
    const executor = api.runtime.subagent as unknown as Record<string, unknown>;
    if (!record(executor) || ['run', 'describeRun', 'cancelRun'].some(method =>
      typeof executor[method] !== 'function')) return;
    const pluginRoot = realpathSync(api.rootDir);
    const profileFile = path.join(pluginRoot, 'execution', 'runtime-profile.json');
    if (realpathSync(profileFile) !== profileFile) return;
    const profile = json(profileFile, 16 * 1024);
    if (!record(profile) || profile.formatVersion !== 1 ||
        profile.capability !== 'managed-execution-v1' ||
        version(profile.openclawVersion) !== EXECUTION_PATCH.version ||
        version(api.runtime.version) !== EXECUTION_PATCH.version ||
        !record(profile.gatewayBundle) || !record(profile.executionPatch)) return;
    const bundle = profile.gatewayBundle;
    const patch = profile.executionPatch;
    if (bundle.path !== 'gateway-bundle.mjs' || !sha256(bundle.sha256) ||
        !Number.isSafeInteger(bundle.size) || Number(bundle.size) < 1 ||
        patch.file !== EXECUTION_PATCH.file || patch.sha256 !== EXECUTION_PATCH.sha256) return;
    const sdk = sdkPackage(environment.resolveSdkCore());
    if (!sdk || sdk.version !== EXECUTION_PATCH.version) return;
    const bundleFile = path.join(sdk.root, 'gateway-bundle.mjs');
    if (realpathSync(bundleFile) !== bundleFile ||
        realpathSync(environment.argvEntry) !== bundleFile || statSync(bundleFile).size !== bundle.size) return;
    const manifestFile = path.join(sdk.root, 'runtime-patch-manifest.json');
    if (realpathSync(manifestFile) !== manifestFile) return;
    const manifest = json(manifestFile, 2 * 1024 * 1024);
    if (!record(manifest) || manifest.formatVersion !== 2 ||
        version(manifest.openclawVersion) !== EXECUTION_PATCH.version ||
        !record(manifest.gatewayBundle) || manifest.gatewayBundle.path !== bundle.path ||
        manifest.gatewayBundle.size !== bundle.size || manifest.gatewayBundle.sha256 !== bundle.sha256 ||
        !Array.isArray(manifest.patches) ||
        manifest.patches.filter(item => record(item) && item.file === patch.file && item.sha256 === patch.sha256).length !== 1)
      return;
    if (hashRuntime(bundleFile) !== bundle.sha256) return;
    return MANAGED_EXECUTION_DESCRIPTOR;
  } catch {
    // Missing, malformed, stale and unverified hosts remain unsupported.
    return;
  }
}
