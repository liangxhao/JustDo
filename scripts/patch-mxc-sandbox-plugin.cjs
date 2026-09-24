'use strict';

// OpenClaw 2026.9.6 maps materialized skills back under the writable workspace
// for Docker-style mounts. Windows ProcessContainer does not support path
// remapping and correctly rejects that nested read-only/write overlap. JustDo
// keeps the materialized skill copy outside the workspace and grants only that
// canonical host path read-only. The matching OpenClaw runtime patch makes
// prompt/tool paths use the same external path for the MXC backend.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nativeBinaries = require('../src/shared/security/mxcNativeBinaries.json');

const SUPPORTED_VERSION = nativeBinaries.pluginVersion;
const MARKER = 'JUSTDO_MXC_EXTERNAL_READONLY_SKILLS_V2026_9_6';
const HOST_PREP_MARKER = 'JUSTDO_MXC_CAPABILITY_SID_HOST_PREP_V2026_9_6';
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
  const packagePath = path.join(pluginDirectory, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (packageJson.version !== SUPPORTED_VERSION) {
    throw new Error(
      `MXC plugin patch supports ${SUPPORTED_VERSION}, found ${String(packageJson.version)}.`,
    );
  }
  return path.join(pluginDirectory, 'dist', 'index.js');
}

function transformMxcPlugin(content, filePath = 'dist/index.js') {
  const markerCount = content.split(MARKER).length - 1;
  const hostPrepMarkerCount = content.split(HOST_PREP_MARKER).length - 1;
  const skillsPatched = markerCount === 1 && content.includes(REPLACEMENT);
  const hostPrepPatched =
    hostPrepMarkerCount === 1 && content.includes(HOST_PREP_REPLACEMENT);
  if (skillsPatched && hostPrepPatched) return content;
  if ((markerCount !== 0 && !skillsPatched) || (hostPrepMarkerCount !== 0 && !hostPrepPatched)) {
    throw new Error(`${filePath}: partial or historical MXC skill path patch detected.`);
  }
  let updated = content;
  if (!skillsPatched) {
    const anchorCount = updated.split(ORIGINAL).length - 1;
    if (anchorCount !== 1) {
      throw new Error(`${filePath}: expected one MXC skill mount anchor, found ${anchorCount}.`);
    }
    updated = updated.replace(ORIGINAL, REPLACEMENT);
  }
  if (!hostPrepPatched) {
    const hostPrepAnchorCount = updated.split(HOST_PREP_ORIGINAL).length - 1;
    if (hostPrepAnchorCount !== 1) {
      throw new Error(
        `${filePath}: expected one MXC host preparation anchor, found ${hostPrepAnchorCount}.`,
      );
    }
    updated = updated.replace(HOST_PREP_ORIGINAL, HOST_PREP_REPLACEMENT);
  }
  return updated;
}

function patchMxcSandboxPlugin(pluginDirectory) {
  const entryPath = resolvePluginEntry(pluginDirectory);
  const original = fs.readFileSync(entryPath, 'utf8');
  const updated = transformMxcPlugin(original, entryPath);
  if (updated !== original) fs.writeFileSync(entryPath, updated, 'utf8');
  return entryPath;
}

function verifyMxcSandboxPlugin(pluginDirectory) {
  const entryPath = resolvePluginEntry(pluginDirectory);
  const content = fs.readFileSync(entryPath, 'utf8');
  if (
    !content.includes(REPLACEMENT) ||
    content.split(MARKER).length - 1 !== 1 ||
    !content.includes(HOST_PREP_REPLACEMENT) ||
    content.split(HOST_PREP_MARKER).length - 1 !== 1
  ) {
    throw new Error(`${entryPath}: JustDo MXC external skill path patch is missing.`);
  }
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
  const binDirectory = path.join(sdkDirectory, 'bin');
  if (!fs.existsSync(path.join(binDirectory, arch, 'wxc-exec.exe'))) {
    throw new Error(`MXC SDK is missing wxc-exec.exe for ${runtimeTarget}.`);
  }
  for (const entry of fs.readdirSync(binDirectory, { withFileTypes: true })) {
    if (entry.isDirectory() && ['x64', 'arm64'].includes(entry.name) && entry.name !== arch) {
      fs.rmSync(path.join(binDirectory, entry.name), { recursive: true, force: true });
    }
  }

  const prebuildsDirectory = path.join(sdkDirectory, 'node_modules', 'node-pty', 'prebuilds');
  const selectedPrebuild = `win32-${arch}`;
  if (!fs.existsSync(path.join(prebuildsDirectory, selectedPrebuild))) {
    throw new Error(`MXC SDK node-pty is missing ${selectedPrebuild} prebuilds.`);
  }
  for (const entry of fs.readdirSync(prebuildsDirectory, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== selectedPrebuild) {
      fs.rmSync(path.join(prebuildsDirectory, entry.name), { recursive: true, force: true });
    }
  }
}

module.exports = {
  MARKER,
  HOST_PREP_MARKER,
  patchMxcSandboxPlugin,
  pruneMxcSandboxPluginForTarget,
  verifyMxcNativeBinaries,
  transformMxcPlugin,
  verifyMxcSandboxPlugin,
  __testing: { HOST_PREP_ORIGINAL, HOST_PREP_REPLACEMENT, ORIGINAL, REPLACEMENT },
};
