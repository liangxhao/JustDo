'use strict';

// OpenClaw 2026.9.8 maps materialized skills back under the writable workspace
// for Docker-style mounts. Windows ProcessContainer does not support path
// remapping and correctly rejects that nested read-only/write overlap. JustDo
// keeps the materialized skill copy outside the workspace and grants only that
// canonical host path read-only. The matching OpenClaw runtime patch makes
// prompt/tool paths use the same external path for the MXC backend.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nativeBinaries = require('../../src/shared/security/mxcNativeBinaries.json');

const SUPPORTED_VERSION = nativeBinaries.pluginVersion;
const MARKER = 'JUSTDO_MXC_EXTERNAL_READONLY_SKILLS_V2026_9_8';
const HOST_PREP_MARKER = 'JUSTDO_MXC_CAPABILITY_SID_HOST_PREP_V2026_9_8';
const LIFECYCLE_MARKER = 'JUSTDO_MXC_NATIVE_POLICY_LIFECYCLE_V2026_9_8';
const HOST_PROBE_MARKER = 'JUSTDO_MXC_EXECUTOR_HOST_PROBE_V2026_9_8';
// Backport upstream executor-based readiness without requiring IsolationSession's broker.
// Remove when the locked plugin probes the same executor it launches.
const HOST_PROBE_ORIGINAL = `function assertWindowsIsoEnvBrokerInstalled(deps) {
\ttry {
\t\tdeps.execFileSync(resolveWindowsSystemExecutable("sc.exe"), ["query", "IsoEnvBroker"], {
\t\t\tencoding: "utf-8",
\t\t\tstdio: "pipe",
\t\t\ttimeout: 5e3,
\t\t\twindowsHide: true
\t\t});
\t} catch (error) {
\t\tconst detail = error instanceof Error && error.message ? \`: \${error.message.trim()}\` : "";
\t\tthrow new Error(\`[mxc] MXC Windows ProcessContainer sandbox is not ready: IsoEnvBroker service is not installed\${detail}. Install the IsoEnvBroker service before enabling MXC sandbox execution.\`, { cause: error });
\t}
}`;
const HOST_PROBE_REPLACEMENT = `function assertMxcExecutorHostReady(params, deps) {
\t/*${HOST_PROBE_MARKER}*/
\ttry {
\t\tconst binaryPath = resolveMxcBinaryPath(params.mxcBinaryPath);
\t\tconst output = deps.execFileSync(binaryPath, ["--probe"], {
\t\t\tencoding: "utf-8",
\t\t\tstdio: "pipe",
\t\t\ttimeout: 5e3,
\t\t\twindowsHide: true
\t\t});
\t\tconst probe = JSON.parse(output);
\t\tif (probe?.tier !== "base-container" && probe?.tier !== "appcontainer-bfs" && probe?.tier !== "appcontainer-dacl") {
\t\t\tthrow new Error("MXC host probe did not select a supported ProcessContainer isolation tier.");
\t\t}
\t\tif (Array.isArray(probe.warnings)) {
\t\t\tfor (const warning of probe.warnings) {
\t\t\t\tif (typeof warning === "string") (params.warn ?? ((message) => console.warn(message)))(\`[mxc] \${warning}\`);
\t\t\t}
\t\t}
\t} catch (error) {
\t\tconst detail = error instanceof Error && error.message ? \`: \${error.message.trim()}\` : "";
\t\tthrow new Error(\`[mxc] MXC Windows ProcessContainer sandbox host probe failed\${detail}\`, { cause: error });
\t}
}`;
const HOST_PROBE_CALL_ORIGINAL = '\tassertWindowsIsoEnvBrokerInstalled({';
const HOST_PROBE_CALL_REPLACEMENT = '\tassertMxcExecutorHostReady(params, {';
const HOST_PROBE_REGISTRATION_ORIGINAL = '\tassertMxcReadiness();';
const HOST_PROBE_REGISTRATION_REPLACEMENT = '\tassertMxcReadiness({ mxcBinaryPath: config.mxcBinaryPath });';
// clearPolicyOnExit belongs to SandboxPolicy, not native ContainerConfig.
// Remove when upstream emits lifecycle.preservePolicy for SDK 0.8.0+.
const LIFECYCLE_ORIGINAL = 'lifecycle: { destroyOnExit: true },';
const LIFECYCLE_REPLACEMENT = `lifecycle: { destroyOnExit: true, preservePolicy: false }, /*${LIFECYCLE_MARKER}*/`;
const FILESYSTEM_ORIGINAL = '\t\treadwritePaths,\n\t\tclearPolicyOnExit: true';
const FILESYSTEM_REPLACEMENT = '\t\treadwritePaths';
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
  const hostPrepPatched = hostPrepMarkerCount === 1 && content.includes(HOST_PREP_REPLACEMENT);
  const lifecycleMarkerCount = content.split(LIFECYCLE_MARKER).length - 1;
  const lifecyclePatched =
    lifecycleMarkerCount === 1 &&
    content.includes(LIFECYCLE_REPLACEMENT) &&
    !content.includes('clearPolicyOnExit');
  const hostProbeMarkerCount = content.split(HOST_PROBE_MARKER).length - 1;
  const hostProbePatched =
    hostProbeMarkerCount === 1 &&
    content.includes(HOST_PROBE_REPLACEMENT) &&
    content.includes(HOST_PROBE_CALL_REPLACEMENT) &&
    content.includes(HOST_PROBE_REGISTRATION_REPLACEMENT) &&
    !content.includes('IsoEnvBroker');
  if (skillsPatched && hostPrepPatched && lifecyclePatched && hostProbePatched) return content;
  if (markerCount !== 0 || hostPrepMarkerCount !== 0 || lifecycleMarkerCount !== 0 || hostProbeMarkerCount !== 0) {
    throw new Error(
      `${filePath}: partial or historical MXC patch detected; rebuild from pristine packages.`,
    );
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
  for (const [original, replacement] of [
    [LIFECYCLE_ORIGINAL, LIFECYCLE_REPLACEMENT],
    [FILESYSTEM_ORIGINAL, FILESYSTEM_REPLACEMENT],
  ]) {
    const count = updated.split(original).length - 1;
    if (count !== 1) {
      throw new Error(`${filePath}: expected one MXC native policy anchor, found ${count}.`);
    }
    updated = updated.replace(original, replacement);
  }
  for (const [original, replacement] of [
    [HOST_PROBE_ORIGINAL, HOST_PROBE_REPLACEMENT],
    [HOST_PROBE_CALL_ORIGINAL, HOST_PROBE_CALL_REPLACEMENT],
    [HOST_PROBE_REGISTRATION_ORIGINAL, HOST_PROBE_REGISTRATION_REPLACEMENT],
  ]) {
    const count = updated.split(original).length - 1;
    if (count !== 1) {
      throw new Error(`${filePath}: expected one MXC host probe anchor, found ${count}.`);
    }
    updated = updated.replace(original, replacement);
  }
  if (updated.includes('IsoEnvBroker')) {
    throw new Error(`${filePath}: unexpected MXC broker prerequisite remains.`);
  }
  if (updated.includes('clearPolicyOnExit')) {
    throw new Error(`${filePath}: unexpected MXC clearPolicyOnExit field remains.`);
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
    content.split(HOST_PREP_MARKER).length - 1 !== 1 ||
    !content.includes(LIFECYCLE_REPLACEMENT) ||
    content.split(LIFECYCLE_MARKER).length - 1 !== 1 ||
    !content.includes(HOST_PROBE_REPLACEMENT) ||
    content.split(HOST_PROBE_MARKER).length - 1 !== 1 ||
    !content.includes(HOST_PROBE_CALL_REPLACEMENT) ||
    !content.includes(HOST_PROBE_REGISTRATION_REPLACEMENT) ||
    content.includes('IsoEnvBroker') ||
    content.includes('clearPolicyOnExit')
  ) {
    throw new Error(
      `${entryPath}: JustDo MXC patch is missing or incomplete; rebuild from pristine packages.`,
    );
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
  HOST_PROBE_MARKER,
  patchMxcSandboxPlugin,
  pruneMxcSandboxPluginForTarget,
  verifyMxcNativeBinaries,
  transformMxcPlugin,
  verifyMxcSandboxPlugin,
  __testing: {
    HOST_PROBE_ORIGINAL,
    HOST_PROBE_REPLACEMENT,
    HOST_PROBE_CALL_ORIGINAL,
    HOST_PROBE_REGISTRATION_ORIGINAL,
    HOST_PREP_ORIGINAL,
    HOST_PREP_REPLACEMENT,
    ORIGINAL,
    REPLACEMENT,
    LIFECYCLE_ORIGINAL,
    LIFECYCLE_REPLACEMENT,
    FILESYSTEM_ORIGINAL,
  },
};
