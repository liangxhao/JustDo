'use strict';

// Capability: let the Windows MXC backend consume the already materialized
// sandbox skills directory as an external read-only ProcessContainer root.
// Target: OpenClaw 2026.9.6 sandbox skill runtime path selection.
// Scope: MXC only. Docker/SSH keep their container-relative skill projection.
// Safety: only the runtime-owned materialized skills root is exposed, read-only, to MXC sessions.
// Remove when: OpenClaw exposes a backend-owned skill prompt/read path mapping.

const fs = require('fs');
const path = require('path');
const {
  countOccurrences,
  findFilesContaining,
  replaceUniquePattern,
  writeIfChanged,
} = require('./_patch-utils.js');

const MARKER = 'JUSTDO_MXC_EXTERNAL_SKILL_RUNTIME_PATHS_V2026_9_6';
const ANCHOR =
  'const skillsPromptWorkspaceDir = params.sandbox.workspaceAccess === "rw" && params.sandbox.skillsWorkspaceDir && params.sandbox.containerWorkdir';
const PATTERN =
  /const skillsPromptWorkspaceDir = params\.sandbox\.workspaceAccess === "rw" && params\.sandbox\.skillsWorkspaceDir && params\.sandbox\.containerWorkdir \? ([^;\r\n]+) : params\.sandbox\.containerWorkdir \?\? skillsWorkspaceDir;/g;
const PATCHED_PATTERN =
  /const skillsPromptWorkspaceDir = params\.sandbox\.backendId === "mxc" && params\.sandbox\.skillsWorkspaceDir \? params\.sandbox\.skillsWorkspaceDir\.replace\(\/\\\\\/g, "\/"\) \/\*JUSTDO_MXC_EXTERNAL_SKILL_RUNTIME_PATHS_V2026_9_6\*\/ : params\.sandbox\.workspaceAccess === "rw" && params\.sandbox\.skillsWorkspaceDir && params\.sandbox\.containerWorkdir \? [^;\r\n]+ : params\.sandbox\.containerWorkdir \?\? skillsWorkspaceDir;/g;
const BUNDLED_PATCHED_PATTERN =
  /(const skillsPromptWorkspaceDir = params\.sandbox\.backendId === "mxc" && params\.sandbox\.skillsWorkspaceDir \? params\.sandbox\.skillsWorkspaceDir\.replace\(\/\\\\\/g, "\/"\))( : params\.sandbox\.workspaceAccess === "rw" && params\.sandbox\.skillsWorkspaceDir && params\.sandbox\.containerWorkdir \? [^;\r\n]+ : params\.sandbox\.containerWorkdir \?\? skillsWorkspaceDir;)/g;

function transformSkillRuntimePaths(content, filePath) {
  const markerCount = countOccurrences(content, MARKER);
  const patchedCount = [...content.matchAll(PATCHED_PATTERN)].length;
  if (markerCount === 1 && patchedCount === 1) return content;
  if (markerCount !== 0) {
    throw new Error(`${filePath}: partial MXC external skill runtime path patch detected.`);
  }
  const bundledPatchedCount = [...content.matchAll(BUNDLED_PATCHED_PATTERN)].length;
  if (bundledPatchedCount === 1) {
    return content.replace(BUNDLED_PATCHED_PATTERN, `$1 /*${MARKER}*/$2`);
  }
  if (bundledPatchedCount !== 0) {
    throw new Error(`${filePath}: ambiguous bundled MXC external skill runtime path patch.`);
  }
  return replaceUniquePattern(
    content,
    PATTERN,
    `const skillsPromptWorkspaceDir = params.sandbox.backendId === "mxc" && params.sandbox.skillsWorkspaceDir ? params.sandbox.skillsWorkspaceDir.replace(/\\\\/g, "/") /*${MARKER}*/ : params.sandbox.workspaceAccess === "rw" && params.sandbox.skillsWorkspaceDir && params.sandbox.containerWorkdir ? $1 : params.sandbox.containerWorkdir ?? skillsWorkspaceDir;`,
    `${filePath}: sandbox skill runtime path anchor`,
  );
}

function locateTargets(runtimeDir) {
  const targets = new Set(
    findFilesContaining(runtimeDir, ['function resolveSandboxSkillRuntimeInputs(params)', ANCHOR]),
  );
  for (const filePath of findFilesContaining(runtimeDir, [
    'function resolveSandboxSkillRuntimeInputs(params)',
    'params.sandbox.backendId === "mxc"',
  ])) {
    targets.add(filePath);
  }
  for (const filePath of findFilesContaining(runtimeDir, [MARKER])) targets.add(filePath);
  const bundleExists = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs'));
  const sourceTargets = [...targets].filter(
    filePath => path.basename(filePath) !== 'gateway-bundle.mjs',
  );
  const bundleTargets = [...targets].filter(
    filePath => path.basename(filePath) === 'gateway-bundle.mjs',
  );
  if (sourceTargets.length !== 1 || bundleTargets.length !== (bundleExists ? 1 : 0)) {
    throw new Error(
      `MXC external skill runtime path target counts are source=${sourceTargets.length}, ` +
        `bundle=${bundleTargets.length}; expected source=1, bundle=${bundleExists ? 1 : 0}`,
    );
  }
  return [...sourceTargets, ...bundleTargets];
}

function applyPatch(runtimeDir) {
  const staged = locateTargets(runtimeDir).map(filePath => {
    const original = fs.readFileSync(filePath, 'utf8');
    return { filePath, original, updated: transformSkillRuntimePaths(original, filePath) };
  });
  return staged
    .filter(item => writeIfChanged(item.filePath, item.original, item.updated))
    .map(item => path.relative(runtimeDir, item.filePath));
}

function verifyPatch(runtimeDir) {
  for (const filePath of locateTargets(runtimeDir)) {
    const content = fs.readFileSync(filePath, 'utf8');
    if (
      countOccurrences(content, MARKER) !== 1 ||
      [...content.matchAll(PATCHED_PATTERN)].length !== 1
    ) {
      throw new Error(`${filePath}: MXC external skill runtime path patch is incomplete.`);
    }
  }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: {
    ANCHOR,
    BUNDLED_PATCHED_PATTERN,
    MARKER,
    PATTERN,
    PATCHED_PATTERN,
    transformSkillRuntimePaths,
  },
};
