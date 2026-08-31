'use strict';

// Capability: keep structured subagent-list polling out of agent tool-loop accounting.
// Target: openclaw@2026.7.1-2 shared Gateway tools.invoke implementation.
// Scope: loop-detection context only; hooks, approvals, authorization, and execution stay intact.
// Safety: every tool/action except authenticated out-of-band `subagents list` keeps loop accounting.
// Remove when: upstream scopes loop detection to agent-run tool calls or exposes a native subagent list RPC.

const fs = require('fs');
const path = require('path');
const {
  countOccurrences,
  findFilesContaining,
  replaceUnique,
  replaceUniquePattern,
  writeIfChanged,
} = require('./_patch-utils.js');

const MARKER = 'JUSTDO_GATEWAY_TOOL_INVOKE_LOOP_SCOPE_V2026_7_1_2';
const FUNCTION_SIGNATURE = 'async function invokeGatewayTool(params) {';
const LOOP_DETECTION_ANCHOR = 'loopDetection: resolveToolLoopDetectionConfig({';
const ORIGINAL_LOOP_DETECTION_PATTERN =
  /^([ \t]*)loopDetection: resolveToolLoopDetectionConfig\(\{\r?\n[ \t]*cfg: params\.cfg,\r?\n[ \t]*agentId\r?\n[ \t]*\}\)$/m;
const PATCHED_LOOP_DETECTION_ANCHOR =
  'loopDetection: gatewayTool.name === "subagents" && (params.input.args?.action ?? action) === "list" ? { enabled: false } : resolveToolLoopDetectionConfig({ cfg: params.cfg, agentId })';
const PATCHED_LOOP_DETECTION = `${PATCHED_LOOP_DETECTION_ANCHOR} // ${MARKER}`;

function countPattern(content, pattern) {
  return [...content.matchAll(new RegExp(pattern.source, pattern.flags.replace('g', '') + 'g'))]
    .length;
}

function transformGatewayToolInvoke(content, filePath) {
  const signatureCount = countOccurrences(content, FUNCTION_SIGNATURE);
  const originalCount = countPattern(content, ORIGINAL_LOOP_DETECTION_PATTERN);
  const patchedAnchorCount = countOccurrences(content, PATCHED_LOOP_DETECTION_ANCHOR);
  const patchedCount = countOccurrences(content, PATCHED_LOOP_DETECTION);
  const markerCount = countOccurrences(content, MARKER);
  if (signatureCount === 1 && originalCount === 0 && patchedCount === 1 && markerCount === 1) {
    return content;
  }
  if (
    path.basename(filePath) === 'gateway-bundle.mjs' &&
    signatureCount === 1 &&
    originalCount === 0 &&
    patchedAnchorCount === 1 &&
    patchedCount === 0 &&
    markerCount === 0
  ) {
    return replaceUnique(
      content,
      PATCHED_LOOP_DETECTION_ANCHOR,
      PATCHED_LOOP_DETECTION,
      `${filePath}: bundled Gateway tool invoke loop-detection marker`,
    );
  }
  if (patchedAnchorCount !== 0 || patchedCount !== 0 || markerCount !== 0) {
    throw new Error(
      `${filePath}: partial Gateway tool invoke loop-scope patch detected ` +
        `(signature=${signatureCount}, original=${originalCount}, anchor=${patchedAnchorCount}, ` +
        `patched=${patchedCount}, marker=${markerCount})`,
    );
  }
  if (signatureCount !== 1 || originalCount !== 1) {
    throw new Error(
      `${filePath}: Gateway tool invoke loop-detection contract is ambiguous ` +
        `(signature=${signatureCount}, original=${originalCount})`,
    );
  }

  return replaceUniquePattern(
    content,
    ORIGINAL_LOOP_DETECTION_PATTERN,
    `$1${PATCHED_LOOP_DETECTION}`,
    `${filePath}: Gateway tool invoke loop detection`,
  );
}

function locateTargets(runtimeDir) {
  const targets = new Set(
    findFilesContaining(runtimeDir, [FUNCTION_SIGNATURE, LOOP_DETECTION_ANCHOR]),
  );
  for (const filePath of findFilesContaining(runtimeDir, [FUNCTION_SIGNATURE, MARKER])) {
    targets.add(filePath);
  }
  for (const filePath of findFilesContaining(runtimeDir, [
    FUNCTION_SIGNATURE,
    PATCHED_LOOP_DETECTION_ANCHOR,
  ])) {
    targets.add(filePath);
  }
  const sourceTargets = [...targets].filter(
    filePath => path.basename(filePath) !== 'gateway-bundle.mjs',
  );
  const bundleTargets = [...targets].filter(
    filePath => path.basename(filePath) === 'gateway-bundle.mjs',
  );
  const expectedBundleTargets = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 1 : 0;
  if (sourceTargets.length !== 1 || bundleTargets.length !== expectedBundleTargets) {
    throw new Error(
      `Gateway tool invoke loop-scope target count is source=${sourceTargets.length}, ` +
        `bundle=${bundleTargets.length}; expected source=1, bundle=${expectedBundleTargets}`,
    );
  }
  return [...sourceTargets, ...bundleTargets];
}

function applyPatch(runtimeDir) {
  const staged = locateTargets(runtimeDir).map(filePath => {
    const original = fs.readFileSync(filePath, 'utf8');
    const updated = transformGatewayToolInvoke(original, filePath);
    return { filePath, original, updated };
  });
  return staged
    .filter(item => writeIfChanged(item.filePath, item.original, item.updated))
    .map(item => path.relative(runtimeDir, item.filePath));
}

function verifyPatch(runtimeDir) {
  for (const filePath of locateTargets(runtimeDir)) {
    const content = fs.readFileSync(filePath, 'utf8');
    if (
      countOccurrences(content, FUNCTION_SIGNATURE) !== 1 ||
      countPattern(content, ORIGINAL_LOOP_DETECTION_PATTERN) !== 0 ||
      countOccurrences(content, PATCHED_LOOP_DETECTION) !== 1 ||
      countOccurrences(content, MARKER) !== 1
    ) {
      throw new Error(`${filePath}: Gateway tool invoke loop-scope contract is incomplete`);
    }
  }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: {
    FUNCTION_SIGNATURE,
    LOOP_DETECTION_ANCHOR,
    MARKER,
    ORIGINAL_LOOP_DETECTION_PATTERN,
    PATCHED_LOOP_DETECTION_ANCHOR,
    PATCHED_LOOP_DETECTION,
    transformGatewayToolInvoke,
  },
};
