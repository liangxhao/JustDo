'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const DLL_NAME = 'installer-clock.dll';
const COMPILE_FLAGS = ['/nologo', '/c', '/W4', '/WX', '/O1', '/Os', '/GS-', '/Zl', '/utf-8', '/Brepro'];
const LINK_FLAGS = [
  '/NOLOGO', '/DLL', '/NOENTRY', '/NODEFAULTLIB', '/MACHINE:X86', '/DYNAMICBASE',
  '/NXCOMPAT', '/SAFESEH', '/INCREMENTAL:NO', '/OPT:REF', '/OPT:ICF', '/Brepro',
];

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function regularFile(filename) {
  try {
    const info = fs.lstatSync(filename);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

function versions(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^\d+(?:\.\d+)+$/.test(entry.name))
    .map(entry => entry.name)
    .sort((left, right) => right.localeCompare(left, 'en', { numeric: true }));
}

function run(executable, args, options = {}) {
  const result = childProcess.spawnSync(executable, args, {
    encoding: 'utf8', windowsHide: true, timeout: 30_000, ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Installer clock tool failed (${path.basename(executable)}): ${
      result.error?.message || `${result.stdout || ''}\n${result.stderr || ''}`.trim()
    }`);
  }
  return result.stdout.trim();
}

function installedSdkRoot() {
  const registry = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  for (const view of ['32', '64']) {
    const result = childProcess.spawnSync(registry, [
      'query', 'HKLM\\SOFTWARE\\Microsoft\\Windows Kits\\Installed Roots',
      '/v', 'KitsRoot10', `/reg:${view}`,
    ], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    if (result.error || result.status !== 0) continue;
    const value = /^\s*KitsRoot10\s+REG_SZ\s+(.+?)\s*$/im.exec(result.stdout)?.[1];
    if (value && path.isAbsolute(value)) return value;
  }
  return undefined;
}

function discoverToolchain() {
  if (process.platform !== 'win32') throw new Error('The installer clock requires a Windows build host.');
  const programFiles = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const vswhere = path.join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const candidates = [];
  if (process.env.VCToolsInstallDir) candidates.push(path.resolve(process.env.VCToolsInstallDir));
  if (regularFile(vswhere)) {
    const installations = run(vswhere, [
      '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property', 'installationPath', '-utf8',
    ]).split(/\r?\n/).filter(Boolean);
    for (const installation of installations) {
      const tools = path.join(installation, 'VC', 'Tools', 'MSVC');
      candidates.push(...versions(tools).map(version => path.join(tools, version)));
    }
  }
  const hosts = process.arch === 'arm64' ? ['Hostarm64', 'Hostx64', 'Hostx86'] : ['Hostx64', 'Hostx86'];
  let compiler;
  for (const candidate of candidates) {
    for (const host of hosts) {
      const bin = path.join(candidate, 'bin', host, 'x86');
      if (['cl.exe', 'link.exe', 'c1.dll', 'c2.dll'].every(name => regularFile(path.join(bin, name)))) {
        compiler = { root: candidate, bin };
        break;
      }
    }
    if (compiler) break;
  }
  if (!compiler) {
    throw new Error('Building the installer clock requires installed Visual Studio C++ x86 build tools. No tools are downloaded.');
  }

  const sdkRoots = [...new Set([
    process.env.WindowsSdkDir,
    installedSdkRoot(),
    path.join(programFiles, 'Windows Kits', '10'),
  ].filter(Boolean).map(value => path.resolve(value)))];
  for (const sdkRoot of sdkRoots) {
    for (const version of versions(path.join(sdkRoot, 'Lib'))) {
      const libraries = ['kernel32.lib', 'user32.lib'].map(name => path.join(sdkRoot, 'Lib', version, 'um', 'x86', name));
      const includes = [path.join(compiler.root, 'include'), ...['um', 'shared', 'ucrt']
        .map(name => path.join(sdkRoot, 'Include', version, name))];
      if (libraries.every(regularFile) && includes.every(directory => fs.existsSync(directory))
          && regularFile(path.join(includes[1], 'windows.h'))) {
        return {
          compiler: path.join(compiler.bin, 'cl.exe'),
          linker: path.join(compiler.bin, 'link.exe'),
          includes,
          libraries,
          compilerVersion: path.basename(compiler.root),
          sdkVersion: version,
          fingerprintFiles: ['cl.exe', 'link.exe', 'c1.dll', 'c2.dll']
            .map(name => path.join(compiler.bin, name)).concat(libraries),
        };
      }
    }
  }
  throw new Error('Building the installer clock requires an installed Windows SDK with x86 kernel32/user32 import libraries.');
}

function fileProof(filename) {
  if (!regularFile(filename)) throw new Error(`Installer clock input must be a regular file: ${filename}`);
  const bytes = fs.readFileSync(filename);
  return { path: filename, size: bytes.length, sha256: digest(bytes) };
}

function inspectClockDll(bytes) {
  if (bytes.length < 256 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Installer clock has no PE header.');
  const pe = bytes.readUInt32LE(0x3c);
  if (pe + 160 > bytes.length || bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0'
      || bytes.readUInt16LE(pe + 4) !== 0x14c || bytes.readUInt16LE(pe + 24) !== 0x10b
      || (bytes.readUInt16LE(pe + 22) & 0x2000) === 0 || bytes.readUInt32LE(pe + 40) !== 0) {
    throw new Error('Installer clock must be a native x86 DLL without an entry point.');
  }
  if ((bytes.readUInt16LE(pe + 94) & 0x140) !== 0x140) {
    throw new Error('Installer clock must retain ASLR and NX compatibility.');
  }
  return true;
}

function assertManagedDirectory(root, directory) {
  const buildRoot = path.join(root, 'build');
  const relative = path.relative(buildRoot, path.resolve(directory));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Installer clock path escaped the repository build directory.');
  }
  let current = buildRoot;
  for (const component of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (component) current = path.join(current, component);
    let info;
    try {
      info = fs.lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Installer clock build paths must be directories without junctions or symbolic links: ${current}`);
    }
  }
}

function readPrepared(directory, fingerprint, root) {
  assertManagedDirectory(root, directory);
  try {
    const info = fs.lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    const manifestPath = path.join(directory, 'manifest.json');
    const dllPath = path.join(directory, DLL_NAME);
    if (!regularFile(manifestPath) || !regularFile(dllPath)) return false;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (manifest.schemaVersion !== SCHEMA_VERSION || manifest.fingerprint !== fingerprint
        || digest(JSON.stringify(manifest.inputs)) !== fingerprint) return false;
    const bytes = fs.readFileSync(dllPath);
    if (manifest.dll?.size !== bytes.length || manifest.dll.sha256 !== digest(bytes)) return false;
    inspectClockDll(bytes);
    return true;
  } catch {
    return false;
  }
}

function removeStaging(directory, cacheRoot, root) {
  if (path.dirname(path.resolve(directory)) !== path.resolve(cacheRoot)
      || !path.basename(directory).startsWith('.clock-staging-')) {
    throw new Error('Installer clock staging cleanup escaped its build directory.');
  }
  assertManagedDirectory(root, directory);
  fs.rmSync(directory, { recursive: true, force: true });
}

function prepareInstallerClockAssets(repoRoot) {
  const root = path.resolve(repoRoot);
  const cacheRoot = path.join(root, 'build', 'installer-clock');
  assertManagedDirectory(root, cacheRoot);
  const source = path.join(root, 'scripts', 'packaging', 'installer-clock.c');
  const exportsFile = path.join(root, 'scripts', 'packaging', 'installer-clock.def');
  const toolchain = discoverToolchain();
  const inputs = {
    schemaVersion: SCHEMA_VERSION,
    sources: [source, exportsFile, __filename].map(fileProof),
    compilerVersion: toolchain.compilerVersion,
    sdkVersion: toolchain.sdkVersion,
    includes: toolchain.includes,
    tools: toolchain.fingerprintFiles.map(fileProof),
    compileFlags: COMPILE_FLAGS,
    linkFlags: LINK_FLAGS,
  };
  const fingerprint = digest(JSON.stringify(inputs));
  const directory = path.join(cacheRoot, fingerprint);
  const result = cacheHit => ({ path: path.join(directory, DLL_NAME), directory, fingerprint, cacheHit });
  if (readPrepared(directory, fingerprint, root)) return result(true);
  assertManagedDirectory(root, cacheRoot);
  fs.mkdirSync(cacheRoot, { recursive: true });
  assertManagedDirectory(root, cacheRoot);
  const staging = fs.mkdtempSync(path.join(cacheRoot, '.clock-staging-'));
  try {
    const object = path.join(staging, 'installer-clock.obj');
    const dll = path.join(staging, DLL_NAME);
    // Explicit arguments and include/library paths avoid a command shell,
    // vcvars setup, ambient compiler switches and first-build downloads.
    const environment = { ...process.env };
    for (const key of Object.keys(environment)) {
      if (['CL', '_CL_', 'LINK', '_LINK_', 'INCLUDE', 'LIB', 'LIBPATH'].includes(key.toUpperCase())) delete environment[key];
    }
    assertManagedDirectory(root, staging);
    run(toolchain.compiler, [
      ...COMPILE_FLAGS, ...toolchain.includes.map(include => `/I${include}`), `/Fo${object}`, source,
    ], { cwd: staging, env: environment });
    assertManagedDirectory(root, staging);
    run(toolchain.linker, [
      ...LINK_FLAGS, `/DEF:${exportsFile}`, `/OUT:${dll}`, object, ...toolchain.libraries,
    ], { cwd: staging, env: environment });
    assertManagedDirectory(root, staging);
    const bytes = fs.readFileSync(dll);
    inspectClockDll(bytes);
    fs.writeFileSync(path.join(staging, 'manifest.json'), `${JSON.stringify({
      schemaVersion: SCHEMA_VERSION, fingerprint, inputs,
      dll: { size: bytes.length, sha256: digest(bytes) },
    }, null, 2)}\n`);
    for (const name of fs.readdirSync(staging)) {
      if (name !== DLL_NAME && name !== 'manifest.json') fs.unlinkSync(path.join(staging, name));
    }
    if (readPrepared(directory, fingerprint, root)) return result(true);
    if (fs.existsSync(directory)) {
      fs.renameSync(directory, path.join(cacheRoot, `.clock-invalid-${crypto.randomUUID()}`));
    }
    try {
      assertManagedDirectory(root, staging);
      assertManagedDirectory(root, directory);
      fs.renameSync(staging, directory);
    } catch (error) {
      if (!readPrepared(directory, fingerprint, root)) throw error;
      return result(true);
    }
    return result(false);
  } finally {
    if (fs.existsSync(staging)) removeStaging(staging, cacheRoot, root);
  }
}

if (require.main === module) {
  process.stdout.write(`${JSON.stringify(prepareInstallerClockAssets(path.resolve(__dirname, '../..')))}\n`);
}

module.exports = { prepareInstallerClockAssets, discoverToolchain, inspectClockDll };
