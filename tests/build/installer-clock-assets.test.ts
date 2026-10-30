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
const {
  prepareInstallerClockAssets,
  rebuildInstallerClockAssets,
  buildInstallerClockAssets,
  discoverToolchain,
} = require('../../scripts/packaging/installer-clock-assets.cjs');
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
  for (const name of ['installer-clock.c', 'installer-clock.def', 'installer-clock-assets.cjs']) {
    copyFileSync(path.join(repoRoot, 'scripts', 'packaging', name), path.join(packaging, name));
  }
  return root;
}

function bundledDirectory(root: string): string {
  return path.join(root, 'resources', 'installer-clock', 'win-x86');
}

function bundledFixture(): string {
  const root = fixture();
  const directory = bundledDirectory(root);
  mkdirSync(directory, { recursive: true });
  for (const name of ['installer-clock.dll', 'manifest.json']) {
    copyFileSync(path.join(bundledDirectory(repoRoot), name), path.join(directory, name));
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

describe('bundled installer clock assets', () => {
  it('prepares a relocated checkout without build caches, compiler discovery or subprocesses', () => {
    const root = bundledFixture();
    const childProcess = require('node:child_process');
    const spawned = vi.spyOn(childProcess, 'spawnSync').mockImplementation(() => {
      throw new Error('Offline build host has no external tools.');
    });

    const prepared = prepareInstallerClockAssets(root);

    expect(prepared.path).toBe(path.join(bundledDirectory(root), 'installer-clock.dll'));
    expect(prepared.directory).toBe(bundledDirectory(root));
    expect(prepared.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(spawned).not.toHaveBeenCalled();
    expect(existsSync(path.join(root, 'build'))).toBe(false);
    const manifest = JSON.parse(readFileSync(path.join(prepared.directory, 'manifest.json'), 'utf8'));
    expect(manifest.inputs.target).toBe('win32-ia32');
    expect(manifest.inputs.sources.map((source: { path: string }) => source.path)).toEqual([
      'scripts/packaging/installer-clock.c',
      'scripts/packaging/installer-clock.def',
      'scripts/packaging/installer-clock-assets.cjs',
    ]);
    const bytes = readFileSync(prepared.path);
    expect(peTables(bytes)).toEqual({
      imports: ['kernel32.dll', 'user32.dll'],
      exports: ['CompleteActions', 'Destroy', 'Start', 'Stop'],
    });
  });

  it('accepts either LF or CRLF checkout text without changing the bundle fingerprint', () => {
    const root = bundledFixture();
    const original = prepareInstallerClockAssets(root);
    for (const newline of ['\n', '\r\n']) {
      for (const name of ['installer-clock.c', 'installer-clock.def', 'installer-clock-assets.cjs']) {
        const filename = path.join(root, 'scripts', 'packaging', name);
        const normalized = readFileSync(filename, 'utf8').replace(/\r\n/g, '\n');
        writeFileSync(filename, normalized.replace(/\n/g, newline));
      }

      expect(prepareInstallerClockAssets(root).fingerprint).toBe(original.fingerprint);
    }
  });

  it('rejects a missing manifest and a damaged DLL with an actionable offline recovery message', () => {
    const missingRoot = bundledFixture();
    rmSync(path.join(bundledDirectory(missingRoot), 'manifest.json'));

    expect(() => prepareInstallerClockAssets(missingRoot)).toThrow('Bundled DLL or manifest is missing');
    expect(() => prepareInstallerClockAssets(missingRoot)).toThrow('installer-clock-assets.cjs --rebuild');

    const damagedRoot = bundledFixture();
    const filename = path.join(bundledDirectory(damagedRoot), 'installer-clock.dll');
    const bytes = readFileSync(filename);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(filename, bytes);

    expect(() => prepareInstallerClockAssets(damagedRoot)).toThrow('size or SHA256 does not match');
    expect(existsSync(path.join(damagedRoot, 'build'))).toBe(false);
  });

  it('rejects stale sources and compiler flags instead of silently compiling a replacement', () => {
    const sourceRoot = bundledFixture();
    const source = path.join(sourceRoot, 'scripts', 'packaging', 'installer-clock.c');
    writeFileSync(source, `${readFileSync(source, 'utf8')}\n/* Changed clock behavior. */\n`);

    expect(() => prepareInstallerClockAssets(sourceRoot)).toThrow('does not match the current installer clock sources and build flags');

    const flagsRoot = bundledFixture();
    const manifestPath = path.join(bundledDirectory(flagsRoot), 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.inputs.compileFlags.push('/DUNEXPECTED_BUILD_FLAG');
    manifest.fingerprint = createHash('sha256').update(JSON.stringify(manifest.inputs)).digest('hex');
    writeFileSync(manifestPath, JSON.stringify(manifest));

    expect(() => prepareInstallerClockAssets(flagsRoot)).toThrow('does not match the current installer clock sources and build flags');
    expect(existsSync(path.join(flagsRoot, 'build'))).toBe(false);
  });

  it('rejects a junction or symbolic link used as the bundled resource directory', () => {
    const root = fixture();
    const outside = bundledFixture();
    const directory = bundledDirectory(root);
    mkdirSync(path.dirname(directory), { recursive: true });
    symlinkSync(bundledDirectory(outside), directory, process.platform === 'win32' ? 'junction' : 'dir');

    expect(() => prepareInstallerClockAssets(root)).toThrow('without junctions or symbolic links');
    expect(() => rebuildInstallerClockAssets(root)).toThrow('without junctions or symbolic links');
    expect(existsSync(path.join(root, 'build'))).toBe(false);
    expect(prepareInstallerClockAssets(outside).path).toBe(path.join(bundledDirectory(outside), 'installer-clock.dll'));
  });
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

    expect(() => buildInstallerClockAssets(root)).toThrow('without junctions or symbolic links');

    expect(readFileSync(sentinel, 'utf8')).toBe('preserve external contents');
    expect(readdirSync(outside)).toEqual(['sentinel.txt']);
  });

  it('builds the x86, CRT-free DLL and reuses only a verified complete artifact', () => {
    const root = fixture();
    const first = buildInstallerClockAssets(root);
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
    const cached = buildInstallerClockAssets(root);
    expect(cached.path).toBe(first.path);
    expect(cached.cacheHit).toBe(true);
    expect(statSync(manifest).mtimeMs).toBe(before);

    writeFileSync(first.path, 'damaged native clock');
    const repaired = buildInstallerClockAssets(root);
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
    const original = buildInstallerClockAssets(root);
    writeFileSync(source, `${readFileSync(source, 'utf8')}\n/* Changed build input. */\n`);
    const changed = buildInstallerClockAssets(root);
    expect(changed.cacheHit).toBe(false);
    expect(changed.fingerprint).not.toBe(original.fingerprint);
    writeFileSync(source, 'invalid C source;');
    expect(() => buildInstallerClockAssets(root)).toThrow('Installer clock tool failed (cl.exe)');
    expect(existsSync(path.join(changed.directory, 'manifest.json'))).toBe(true);
    expect(readdirSync(path.dirname(changed.directory)).sort()).toEqual([
      original.fingerprint, changed.fingerprint,
    ].sort());
  }, 30_000);

  it('publishes a portable bundle and preserves it when a subsequent native rebuild fails', () => {
    const root = fixture();
    const published = rebuildInstallerClockAssets(root);
    const dllPath = path.join(published.directory, 'installer-clock.dll');
    const manifestPath = path.join(published.directory, 'manifest.json');
    const originalDll = readFileSync(dllPath);
    const originalManifest = readFileSync(manifestPath);
    const source = path.join(root, 'scripts', 'packaging', 'installer-clock.c');
    const originalSource = readFileSync(source);
    writeFileSync(source, 'invalid C source;');

    expect(() => rebuildInstallerClockAssets(root)).toThrow('Installer clock tool failed (cl.exe)');

    expect(readFileSync(dllPath)).toEqual(originalDll);
    expect(readFileSync(manifestPath)).toEqual(originalManifest);
    writeFileSync(source, originalSource);
    expect(prepareInstallerClockAssets(root)).toEqual(published);
  }, 30_000);
});
