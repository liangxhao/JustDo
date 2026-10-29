import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const buildRoot = path.join(repoRoot, 'build');
const { prepareInstallerClockAssets, discoverToolchain } = require('../../scripts/packaging/installer-clock-assets.cjs');
let toolchainAvailable = false;
if (process.platform === 'win32') {
  try {
    discoverToolchain();
    toolchainAvailable = true;
  } catch {
    // Native build fixtures require the same installed tools as packaging.
  }
}
const fixtureRoots: string[] = [];

function fixture(): string {
  mkdirSync(buildRoot, { recursive: true });
  const root = mkdtempSync(path.join(buildRoot, 'installer-clock-test-'));
  fixtureRoots.push(root);
  const packaging = path.join(root, 'scripts', 'packaging');
  mkdirSync(packaging, { recursive: true });
  for (const name of ['installer-clock.c', 'installer-clock.def']) {
    copyFileSync(path.join(repoRoot, 'scripts', 'packaging', name), path.join(packaging, name));
  }
  return root;
}

function peTables(bytes: Buffer): { imports: string[]; exports: string[] } {
  const pe = bytes.readUInt32LE(0x3c);
  const optional = pe + 24;
  const sections = pe + 24 + bytes.readUInt16LE(pe + 20);
  const offset = (rva: number) => {
    for (let index = 0; index < bytes.readUInt16LE(pe + 6); index++) {
      const entry = sections + index * 40;
      const start = bytes.readUInt32LE(entry + 12);
      if (rva >= start && rva < start + bytes.readUInt32LE(entry + 16)) {
        return bytes.readUInt32LE(entry + 20) + rva - start;
      }
    }
    throw new Error(`PE address is outside a file section: ${rva}`);
  };
  const string = (rva: number) => {
    const start = offset(rva);
    return bytes.toString('ascii', start, bytes.indexOf(0, start));
  };
  const imports = [];
  let entry = offset(bytes.readUInt32LE(optional + 104));
  while (bytes.readUInt32LE(entry + 12) !== 0) {
    imports.push(string(bytes.readUInt32LE(entry + 12)).toLowerCase());
    entry += 20;
  }
  const exportTable = offset(bytes.readUInt32LE(optional + 96));
  const names = offset(bytes.readUInt32LE(exportTable + 32));
  const exports = [];
  for (let index = 0; index < bytes.readUInt32LE(exportTable + 24); index++) {
    exports.push(string(bytes.readUInt32LE(names + index * 4)));
  }
  return { imports: imports.sort(), exports: exports.sort() };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of fixtureRoots.splice(0)) {
    expect(path.dirname(path.resolve(root))).toBe(buildRoot);
    rmSync(root, { recursive: true, force: true });
  }
});

describe.runIf(toolchainAvailable)('native installer clock assets', () => {
  it('discovers an SDK registered outside Program Files without a developer-shell SDK variable', () => {
    const root = fixture();
    const sdk = path.join(root, 'custom-sdk');
    const version = '10.0.99999.0';
    for (const name of ['um', 'shared', 'ucrt']) {
      mkdirSync(path.join(sdk, 'Include', version, name), { recursive: true });
    }
    writeFileSync(path.join(sdk, 'Include', version, 'um', 'windows.h'), 'header fixture');
    const libraries = path.join(sdk, 'Lib', version, 'um', 'x86');
    mkdirSync(libraries, { recursive: true });
    for (const name of ['kernel32.lib', 'user32.lib']) writeFileSync(path.join(libraries, name), 'library fixture');
    vi.stubEnv('WindowsSdkDir', '');
    const childProcess = require('node:child_process');
    const actualSpawn = childProcess.spawnSync;
    const spawned = vi.spyOn(childProcess, 'spawnSync').mockImplementation((...args: unknown[]) => {
      if (path.basename(args[0] as string).toLowerCase() === 'reg.exe') {
        return { status: 0, stdout: `\r\n    KitsRoot10    REG_SZ    ${sdk}\\\r\n`, stderr: '' };
      }
      return actualSpawn(...args);
    });

    const discovered = discoverToolchain();

    expect(discovered.sdkVersion).toBe(version);
    expect(discovered.libraries).toEqual(['kernel32.lib', 'user32.lib'].map(name => path.join(libraries, name)));
    expect(spawned).toHaveBeenCalledWith(
      expect.stringMatching(/reg\.exe$/i),
      ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows Kits\\Installed Roots', '/v', 'KitsRoot10', '/reg:32'],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it.each(['build', 'installer-clock'])('rejects a junction at the managed %s directory before writing outside the repository', component => {
    const root = fixture();
    const outside = mkdtempSync(path.join(buildRoot, 'installer-clock-external-'));
    fixtureRoots.push(outside);
    const sentinel = path.join(outside, 'sentinel.txt');
    writeFileSync(sentinel, 'preserve external contents');
    const junction = component === 'build' ? path.join(root, 'build') : path.join(root, 'build', 'installer-clock');
    mkdirSync(path.dirname(junction), { recursive: true });
    symlinkSync(outside, junction, 'junction');

    expect(() => prepareInstallerClockAssets(root)).toThrow('without junctions or symbolic links');

    expect(readFileSync(sentinel, 'utf8')).toBe('preserve external contents');
    expect(readdirSync(outside)).toEqual(['sentinel.txt']);
  });

  it('builds the x86, CRT-free DLL and reuses only a verified complete artifact', () => {
    const root = fixture();
    const first = prepareInstallerClockAssets(root);
    const bytes = readFileSync(first.path);
    const pe = bytes.readUInt32LE(0x3c);
    const optional = pe + 24;
    expect(first.cacheHit).toBe(false);
    expect(path.dirname(first.directory)).toBe(path.join(root, 'build', 'installer-clock'));
    expect(bytes.readUInt16LE(pe + 4)).toBe(0x14c);
    expect(bytes.readUInt16LE(optional)).toBe(0x10b);
    expect(bytes.readUInt16LE(pe + 22) & 0x2000).toBe(0x2000);
    expect(bytes.readUInt32LE(optional + 16)).toBe(0);
    expect(bytes.readUInt16LE(optional + 70) & 0x540).toBe(0x540);
    expect(bytes.readUInt32LE(optional + 208)).toBe(0); // No managed runtime.
    expect(peTables(bytes)).toEqual({
      imports: ['kernel32.dll', 'user32.dll'],
      exports: ['CompleteActions', 'Destroy', 'Start', 'Stop'],
    });
    expect(readdirSync(first.directory).sort()).toEqual(['installer-clock.dll', 'manifest.json']);
    const manifest = path.join(first.directory, 'manifest.json');
    const before = statSync(manifest).mtimeMs;
    const cached = prepareInstallerClockAssets(root);
    expect(cached.path).toBe(first.path);
    expect(cached.cacheHit).toBe(true);
    expect(statSync(manifest).mtimeMs).toBe(before);

    writeFileSync(first.path, 'damaged native clock');
    const repaired = prepareInstallerClockAssets(root);
    expect(repaired.cacheHit).toBe(false);
    expect(repaired.fingerprint).toBe(first.fingerprint);
    expect(readFileSync(repaired.path)).toEqual(bytes);
    const proof = JSON.parse(readFileSync(manifest, 'utf8'));
    expect(proof.dll.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(readdirSync(path.dirname(first.directory)).some(name => name.startsWith('.clock-staging-'))).toBe(false);
  }, 30_000);

  it('binds native source changes and never publishes a failed compilation', () => {
    const root = fixture();
    const source = path.join(root, 'scripts', 'packaging', 'installer-clock.c');
    const original = prepareInstallerClockAssets(root);
    writeFileSync(source, `${readFileSync(source, 'utf8')}\n/* Changed build input. */\n`);
    const changed = prepareInstallerClockAssets(root);
    expect(changed.cacheHit).toBe(false);
    expect(changed.fingerprint).not.toBe(original.fingerprint);
    writeFileSync(source, 'invalid C source;');
    expect(() => prepareInstallerClockAssets(root)).toThrow('Installer clock tool failed (cl.exe)');
    expect(existsSync(path.join(changed.directory, 'manifest.json'))).toBe(true);
    expect(readdirSync(path.dirname(changed.directory)).sort()).toEqual([
      original.fingerprint, changed.fingerprint,
    ].sort());
  }, 30_000);
});
