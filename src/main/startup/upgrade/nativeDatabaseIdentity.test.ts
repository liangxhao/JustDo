import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import nodeRuntime from '../../../shared/openclaw/nodeRuntime.json';
import contract from './nativeDatabaseContract.json';
import { admitNativeDatabaseRuntime } from './nativeDatabaseIdentity';

const electronModule = vi.hoisted(() => vi.fn(() => { throw new Error('Node must not load original-fs.'); }));
vi.mock('node:module', () => ({ createRequire: () => electronModule }));

const directories: string[] = [];
const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, entry]) => [key, canonical(entry)])) : value;
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-database-admission-')); directories.push(root);
  const target = `${{ win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform as 'win32' | 'darwin' | 'linux']}-${process.arch}`;
  const nodeTarget = nodeRuntime.targets[target as keyof typeof nodeRuntime.targets];
  const write = (file: string, content: string) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), content); };
  const pkg = JSON.stringify({ name: 'openclaw', version: '2026.10.6', openclaw: { schemaVersions: contract.schemaVersions } });
  const nativeNode = JSON.stringify({ version: nodeRuntime.version, target, archive: nodeTarget.archive, archiveSha256: nodeTarget.sha256,
    executable: nodeTarget.executable, files: { [nodeTarget.executable]: { sha256: hash('fixture-node') } } });
  const proof = { contractSha256: hash(JSON.stringify(canonical(contract))),
    modules: Object.entries(contract.modules).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([role, value]) => ({ role, ...value })) };
  const build = { target, openclawVersion: contract.openclawVersion, patchSetSha256: 'a'.repeat(64), buildRecipeSha256: 'b'.repeat(64),
    runtimePackageSha256: hash(pkg), runtimePackageLockSha256: hash('{}'), gatewayAsarSha256: hash('fixture-archive'), nodeRuntimeManifestSha256: hash(nativeNode) };
  const manifest = { formatVersion: 2, target, openclawVersion: contract.openclawVersion,
    patchSetSha256: build.patchSetSha256, buildRecipeSha256: build.buildRecipeSha256,
    sourceArtifacts: { ...build, runtimePackageLockPath: 'npm-shrinkwrap.json' },
    gatewayBundle: { path: 'gateway-bundle.mjs', sha256: hash('fixture-bundle') }, nativeDatabaseOwners: proof };
  write('package.json', pkg); write('runtime-build-info.json', JSON.stringify(build));
  write('runtime-patch-manifest.json', JSON.stringify(manifest)); write('npm-shrinkwrap.json', '{}');
  write('gateway-bundle.mjs', 'fixture-bundle'); write('gateway.asar', 'fixture-archive');
  write('node-runtime/node-runtime-manifest.json', nativeNode); write('node-runtime/' + nodeTarget.executable, 'fixture-node');
  return { root, manifest, build, write };
}
afterEach(() => { vi.restoreAllMocks(); for (const root of directories.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('native database immutable admission', () => {
  it('requires the actual selected owner bytes after all manifest and Node metadata admission checks', async () => {
    const f = fixture();
    // Metadata fixtures do not fake native owners; actual positive bytes are exercised by the mandatory native gate.
    await expect(admitNativeDatabaseRuntime(f.root)).rejects.toMatchObject({ code: 'ENOENT', path: path.join(f.root, contract.modules.agent.path) });
    expect(electronModule).not.toHaveBeenCalled();
  });
  it.each(['missing', 'extra-key', 'wrong-export', 'wrong-hash'])('refuses missing or altered producer owner proofs before reading owners: %s', async kind => {
    const f = fixture(); const altered: Record<string, unknown> = structuredClone(f.manifest);
    const proof = altered.nativeDatabaseOwners as { unauthorized?: boolean; contractSha256: string; modules: { exports: Record<string, string> }[] };
    if (kind === 'missing') delete altered.nativeDatabaseOwners;
    if (kind === 'extra-key') proof.unauthorized = true;
    if (kind === 'wrong-export') proof.modules[0].exports.clearOpenClawAgentDatabaseOpenFailure = 'wrong';
    if (kind === 'wrong-hash') proof.contractSha256 = '0'.repeat(64);
    f.write('runtime-patch-manifest.json', JSON.stringify(altered));
    await expect(admitNativeDatabaseRuntime(f.root)).rejects.toThrow(/missing or inconsistent/);
  });
  it.each([null, [], { gatewayBundle: {} }, { sourceArtifacts: null }])('fails closed on malformed manifest structure without dereferencing unknown fields: %j', async fields => {
    const f = fixture(); f.write('runtime-patch-manifest.json', JSON.stringify(fields && !Array.isArray(fields) ? { ...f.manifest, ...fields } : fields));
    await expect(admitNativeDatabaseRuntime(f.root)).rejects.toThrow(/missing or inconsistent/);
  });
  it('accepts the packaged archive omission while still requiring every actual native owner', async () => {
    const f = fixture(); fs.unlinkSync(path.join(f.root, 'gateway.asar'));
    await expect(admitNativeDatabaseRuntime(f.root)).rejects.toMatchObject({ code: 'ENOENT', path: path.join(f.root, contract.modules.agent.path) });
    f.write(contract.modules.agent.path, 'tampered owner');
    await expect(admitNativeDatabaseRuntime(f.root)).rejects.toThrow(/missing or inconsistent/);
  });
  it.each(['changed', 'directory'])('still rejects an inconsistent duplicate archive whenever it is present: %s', async kind => {
    const f = fixture();
    if (kind === 'changed') f.write('gateway.asar', 'changed archive');
    else { fs.unlinkSync(path.join(f.root, 'gateway.asar')); fs.mkdirSync(path.join(f.root, 'gateway.asar')); }
    await expect(admitNativeDatabaseRuntime(f.root)).rejects.toThrow(/missing or inconsistent/);
  });
  it('refuses inconsistent bundled Node metadata and changed bundle bytes', async () => {
    const f = fixture(); f.write('node-runtime/node-runtime-manifest.json', '{}');
    await expect(admitNativeDatabaseRuntime(f.root)).rejects.toThrow(/missing or inconsistent/);
    const g = fixture(); g.write('gateway-bundle.mjs', 'changed');
    await expect(admitNativeDatabaseRuntime(g.root)).rejects.toThrow(/missing or inconsistent/);
  });
});
