import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import lock from '../../../../shared/openclaw/nodeRuntime.json';
import { resolveBundledNodeRuntimePaths } from './bundledNodeRuntime';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(packaged: boolean) {
  const appPath = fs.mkdtempSync(path.join(os.tmpdir(), 'node-runtime-'));
  roots.push(appPath);
  const resourcesPath = path.join(appPath, 'resources');
  const root = packaged
    ? path.join(resourcesPath, 'cfmind/node-runtime')
    : path.join(appPath, 'vendor/openclaw-runtime/current/node-runtime');
  const contract = lock.targets['win-x64'];
  const executable = path.join(root, contract.executable);
  const npmBin = path.join(root, contract.npmBin);
  fs.mkdirSync(npmBin, { recursive: true });
  fs.writeFileSync(executable, 'locked executable fixture');
  fs.writeFileSync(path.join(npmBin, 'npm-cli.js'), 'npm');
  fs.writeFileSync(path.join(npmBin, 'npx-cli.js'), 'npx');
  const manifest = {
    version: lock.version, target: 'win-x64', executable: contract.executable,
    archive: contract.archive, archiveSha256: contract.sha256,
    files: { [contract.executable]: { sha256: createHash('sha256').update(fs.readFileSync(executable)).digest('hex') } },
  };
  fs.writeFileSync(path.join(root, 'node-runtime-manifest.json'), JSON.stringify(manifest));
  return { root, executable, npmBin, options: { packaged, appPath, resourcesPath, platform: 'win32' as const, arch: 'x64' } };
}

describe('bundled Node admission', () => {
  it.each([false, true])('resolves the locked executable and its complete external npm tree (packaged=%s)', packaged => {
    const value = fixture(packaged);
    expect(resolveBundledNodeRuntimePaths(value.options)).toEqual({ executable: value.executable, npmBin: value.npmBin });
  });
  it('rejects missing or changed payloads without falling back to Electron or PATH', () => {
    const value = fixture(true);
    fs.appendFileSync(value.executable, 'changed');
    expect(() => resolveBundledNodeRuntimePaths(value.options)).toThrow(/missing or damaged/);
    fs.unlinkSync(value.executable);
    expect(() => resolveBundledNodeRuntimePaths(value.options)).toThrow(/missing or damaged/);
  });
  it('rejects a different platform proof and unsupported architectures', () => {
    const value = fixture(true);
    const manifestPath = path.join(value.root, 'node-runtime-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.target = 'win-arm64';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => resolveBundledNodeRuntimePaths(value.options)).toThrow(/missing or damaged/);
    expect(() => resolveBundledNodeRuntimePaths({ ...value.options, arch: 'ia32' })).toThrow(/Unsupported/);
  });
});
