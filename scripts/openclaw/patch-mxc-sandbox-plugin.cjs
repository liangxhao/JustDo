'use strict';
// The locked 10.6 plugin natively probes its selected executor and emits native SDK
// lifecycle configuration. Retain only external read-only skills and capability SID recognition.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createRequire } = require('node:module');
const nativeBinaries = require('../../src/shared/security/mxcNativeBinaries.json');
const SUPPORTED_VERSION = nativeBinaries.pluginVersion;
const MARKER = 'SANDBOX_EXTERNAL_READONLY_SKILLS_V2026_10_6';
const HOST_PREP_MARKER = 'SANDBOX_CAPABILITY_SID_HOST_PREP_V2026_10_6';
const ORIGINAL = `\treturn [
\t\t{
\t\t\thostPath: path.join(params.agentWorkspaceDir, "skills"),
\t\t\tcontainerPath: containerJoin(params.workdir, "skills"),
\t\t\trootDir: params.agentWorkspaceDir
\t\t},
\t\t{
\t\t\thostPath: path.join(params.agentWorkspaceDir, ".agents", "skills"),
\t\t\tcontainerPath: containerJoin(params.workdir, ".agents", "skills"),
\t\t\trootDir: params.agentWorkspaceDir
\t\t},
\t\t{
\t\t\thostPath: path.join(materializedSkillsWorkspaceDir, "skills"),
\t\t\tcontainerPath: containerJoin(params.workdir, ...MATERIALIZED_SANDBOX_SKILLS_WORKSPACE_PARTS, "skills"),
\t\t\trootDir: materializedSkillsWorkspaceDir
\t\t}
\t]`;
const REPLACEMENT = `\tconst materializedSkillsPath = path.join(materializedSkillsWorkspaceDir, "skills");
\t/*${MARKER}*/
\treturn [{
\t\thostPath: materializedSkillsPath,
\t\tcontainerPath: materializedSkillsPath,
\t\trootDir: materializedSkillsWorkspaceDir
\t}]`;
const HOST_PREP_ORIGINAL =
  'return output.includes("S-1-15-2-1") || output.includes("APPLICATION PACKAGES");';
const HOST_PREP_REPLACEMENT =
  'return output.includes("S-1-15-2-1") || output.includes("APPLICATION PACKAGES") || output.includes("S-1-15-3-"); /*' +
  `${HOST_PREP_MARKER}*/`;


function resolvePluginEntry(pluginDirectory) {
  const pkg = JSON.parse(fs.readFileSync(path.join(pluginDirectory, 'package.json'), 'utf8'));
  if (pkg.version !== SUPPORTED_VERSION) throw new Error('MXC plugin patch supports ' + SUPPORTED_VERSION + ', found ' + pkg.version);
  return path.join(pluginDirectory, 'dist', 'index.js');
}
function assertNativeContracts(content, file) {
  for (const fragment of [
    'assertMxcReadiness({ executablePath: mxcBinaryPath });',
    'probeMxcIsolationTier(params.executablePath)',
    'MxcProbeOutputSchema.safeParse(probe)',
    'preservePolicy: false',
    'destroyOnExit: true',
  ]) if (!content.includes(fragment)) throw new Error(file + ': native MXC contract missing: ' + fragment);
  if (/IsoEnvBroker|clearPolicyOnExit|JUSTDO_MXC_/.test(content))
    throw new Error(file + ': historical MXC shape; rebuild from pristine packages');
}
function transformMxcPlugin(content, filePath = 'dist/index.js') {
  assertNativeContracts(content, filePath);
  const skills = content.includes(REPLACEMENT) && content.split(MARKER).length === 2;
  const prep = content.includes(HOST_PREP_REPLACEMENT) && content.split(HOST_PREP_MARKER).length === 2;
  if (skills && prep) return content;
  if (content.includes(MARKER) || content.includes(HOST_PREP_MARKER))
    throw new Error(filePath + ': partial MXC patch; rebuild from pristine packages');
  let updated = content;
  for (const [original, replacement] of [[ORIGINAL, REPLACEMENT], [HOST_PREP_ORIGINAL, HOST_PREP_REPLACEMENT]]) {
    const count = updated.split(original).length - 1;
    if (count !== 1) throw new Error(filePath + ': native MXC anchor count ' + count + ', expected 1');
    updated = updated.replace(original, replacement);
  }
  return updated;
}
function patchMxcSandboxPlugin(pluginDirectory) {
  const entry = resolvePluginEntry(pluginDirectory);
  const source = fs.readFileSync(entry, 'utf8');
  const next = transformMxcPlugin(source, entry);
  if (next !== source) fs.writeFileSync(entry, next, 'utf8');
  return entry;
}
function verifyMxcSandboxPlugin(pluginDirectory) {
  const entry = resolvePluginEntry(pluginDirectory);
  const source = fs.readFileSync(entry, 'utf8');
  if (!source.includes(REPLACEMENT) || !source.includes(HOST_PREP_REPLACEMENT) || transformMxcPlugin(source, entry) !== source)
    throw new Error(entry + ': MXC patch missing or incomplete; rebuild from pristine packages');
}
function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

function resolveTargetArch(runtimeTarget) {
  const match = /^win-(x64|arm64)$/.exec(runtimeTarget);
  if (!match)
    throw new Error(
      `MXC native binaries require a Windows runtime target, found ${runtimeTarget}.`,
    );
  return match[1];
}

function verifyMxcNativeBinaries(pluginDirectory, runtimeTarget) {
  const sdkDirectory = path.join(pluginDirectory, 'node_modules', '@microsoft', 'mxc-sdk');
  const sdkPackage = JSON.parse(fs.readFileSync(path.join(sdkDirectory, 'package.json'), 'utf8'));
  if (sdkPackage.version !== nativeBinaries.sdkVersion) {
    throw new Error(
      `MXC SDK native manifest supports ${nativeBinaries.sdkVersion}, found ${String(sdkPackage.version)}.`,
    );
  }
  const arches = runtimeTarget
    ? [resolveTargetArch(runtimeTarget)]
    : Object.keys(nativeBinaries.sha256);
  for (const arch of arches) {
    const expectedFiles = nativeBinaries.sha256[arch];
    if (!expectedFiles) throw new Error(`MXC native manifest is missing architecture ${arch}.`);
    for (const [fileName, expectedHash] of Object.entries(expectedFiles)) {
      const filePath = path.join(sdkDirectory, 'bin', arch, fileName);
      if (!fs.existsSync(filePath)) throw new Error(`MXC SDK is missing ${fileName} for ${arch}.`);
      const actualHash = sha256File(filePath);
      if (actualHash !== expectedHash) {
        throw new Error(
          `MXC SDK ${fileName} hash mismatch for ${arch}: expected ${expectedHash}, found ${actualHash}.`,
        );
      }
    }
  }
}

function pruneMxcSandboxPluginForTarget(pluginDirectory, runtimeTarget) {
  const arch = resolveTargetArch(runtimeTarget);
  const sdkDirectory = path.join(pluginDirectory, 'node_modules', '@microsoft', 'mxc-sdk');
  const pluginRoot = fs.realpathSync(pluginDirectory);
  const assertInsidePlugin = file => {
    const resolved = fs.realpathSync(file);
    const relative = path.relative(pluginRoot, resolved);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('MXC SDK assets must resolve within its packaged plugin.');
    }
    return resolved;
  };
  const sdkPackagePath = assertInsidePlugin(path.join(sdkDirectory, 'package.json'));
  const ptyPackagePath = assertInsidePlugin(createRequire(sdkPackagePath).resolve('node-pty/package.json'));
  if (JSON.parse(fs.readFileSync(ptyPackagePath, 'utf8')).name !== 'node-pty') {
    throw new Error('MXC SDK node-pty package identity does not match.');
  }
  const prebuildsDirectory = assertInsidePlugin(path.join(path.dirname(ptyPackagePath), 'prebuilds'));
  const selectedPrebuild = `win32-${arch}`;
  const selectedDirectory = path.join(prebuildsDirectory, selectedPrebuild);
  if (!fs.statSync(selectedDirectory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`MXC SDK node-pty is missing ${selectedPrebuild} prebuilds.`);
  }
  assertInsidePlugin(selectedDirectory);
  const binDirectory = assertInsidePlugin(path.join(sdkDirectory, 'bin'));
  const selectedBin = assertInsidePlugin(path.join(binDirectory, arch));
  if (!fs.existsSync(path.join(selectedBin, 'wxc-exec.exe'))) {
    throw new Error(`MXC SDK is missing wxc-exec.exe for ${runtimeTarget}.`);
  }
  for (const entry of fs.readdirSync(binDirectory, { withFileTypes: true })) {
    if (entry.isDirectory() && ['x64', 'arm64'].includes(entry.name) && entry.name !== arch) {
      fs.rmSync(path.join(binDirectory, entry.name), { recursive: true, force: true });
    }
  }
  // The SDK's Linux branch is never selected by a Windows host. Keep the
  // Windows executor, WSL support DLLs and their pinned verification intact.
  fs.rmSync(path.join(selectedBin, 'lxc-exec'), { force: true });

  for (const entry of fs.readdirSync(prebuildsDirectory, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== selectedPrebuild) {
      fs.rmSync(path.join(prebuildsDirectory, entry.name), { recursive: true, force: true });
    }
  }
}

module.exports = { MARKER, HOST_PREP_MARKER, patchMxcSandboxPlugin, pruneMxcSandboxPluginForTarget, verifyMxcNativeBinaries, transformMxcPlugin, verifyMxcSandboxPlugin, __testing: { ORIGINAL, REPLACEMENT, HOST_PREP_ORIGINAL, HOST_PREP_REPLACEMENT, assertNativeContracts } };
