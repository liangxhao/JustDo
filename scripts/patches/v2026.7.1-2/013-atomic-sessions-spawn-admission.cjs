'use strict';

// Capability: reserve native subagent capacity atomically per canonical requester until registration.
// Target: pristine openclaw@2026.7.1-2, whose capacity check precedes async registration.
// Scope: only runtime=subagent uses the reservation; ACP keeps its pristine admission and concurrency behavior.
// Safety: native limits/registry and global run lanes stay authoritative; failures always release reservations.
// Remove when: upstream atomically reserves native capacity across its check-through-registration boundary.

const fs = require('fs');
const path = require('path');
const {
  findFilesContaining,
  replaceUnique,
  replaceUniquePattern,
  writeIfChanged,
} = require('./_patch-utils.js');

const CONTRACT = 'JUSTDO_ATOMIC_SESSIONS_SPAWN_ADMISSION_2026_7_1';
const FUNCTION_ANCHOR = 'function createSessionsSpawnTool(opts) {';
const HELPER = `// ${CONTRACT}
const nativeSessionsSpawnAdmissionReservations = /* @__PURE__ */ new Map();
function resolveNativeSessionsSpawnAdmissionKey(sessionKey) {
  const cfg = getRuntimeConfig();
  const { mainKey, alias } = resolveMainSessionAlias(cfg);
  const rawSessionKey = typeof sessionKey === "string" ? sessionKey.trim() : "";
  return rawSessionKey ? resolveInternalSessionKey({ key: rawSessionKey, alias, mainKey }) : alias;
}
function reserveNativeSessionsSpawnAdmission(sessionKey) {
  const requesterSessionKey = resolveNativeSessionsSpawnAdmissionKey(sessionKey);
  const cfg = getRuntimeConfig();
  const maxChildren = cfg.agents?.defaults?.subagents?.maxChildrenPerAgent ?? 5;
  const activeChildren = countActiveRunsForSession(requesterSessionKey);
  const initializingChildren = nativeSessionsSpawnAdmissionReservations.get(requesterSessionKey) ?? 0;
  if (activeChildren + initializingChildren >= maxChildren) return {
    status: "forbidden",
    requesterSessionKey,
    activeChildren,
    initializingChildren,
    maxChildren
  };
  nativeSessionsSpawnAdmissionReservations.set(requesterSessionKey, initializingChildren + 1);
  return { status: "reserved", requesterSessionKey, activeChildren, initializingChildren, maxChildren };
}
function releaseNativeSessionsSpawnAdmission(reservation) {
  if (reservation?.status !== "reserved") return;
  const current = nativeSessionsSpawnAdmissionReservations.get(reservation.requesterSessionKey) ?? 0;
  if (current <= 1) nativeSessionsSpawnAdmissionReservations.delete(reservation.requesterSessionKey);
  else nativeSessionsSpawnAdmissionReservations.set(reservation.requesterSessionKey, current - 1);
}
function formatNativeSessionsSpawnAdmissionFailure(reservation) {
  if (!reservation) return {
    status: "error",
    error: "sessions_spawn native admission callback is unavailable"
  };
  return {
    status: "forbidden",
    error: "sessions_spawn has reached max active native subagents for this session (" + reservation.activeChildren + " active + " + reservation.initializingChildren + " initializing / " + reservation.maxChildren + ")"
  };
}
`;
const NATIVE_PREFLIGHT_PATTERN =
  /([ \t]*)if \(plan\.status === "error"\) return \{\r?\n([ \t]*)status: "error",\r?\n\2error: plan\.error\r?\n\1\};\r?\n\1const \{ resolvedModel, thinkingOverride \} = plan;/;
const PUBLIC_NATIVE_OPEN_PATTERN =
  /([ \t]*)return jsonResult\(addRoleToFailureResult\(await spawnSubagentDirect\(\{/;
const PUBLIC_NATIVE_CONTEXT_PATTERN =
  /([ \t]*)inheritedToolDenylist: opts\?\.inheritedToolDenylist\r?\n([ \t]*)\}\), requestedAgentId\)\);/;
const PUBLIC_NATIVE_CLOSE_PATTERN =
  /([ \t]*)\}\), requestedAgentId\)\);(?=\r?\n[ \t]*\}\r?\n[ \t]*\};\r?\n\})/;
const PATCH_MARKERS = [
  'function resolveNativeSessionsSpawnAdmissionKey(sessionKey) {',
  'nativeSessionsSpawnAdmissionReservations.set(requesterSessionKey, initializingChildren + 1);',
  'function releaseNativeSessionsSpawnAdmission(reservation) {',
  'function formatNativeSessionsSpawnAdmissionFailure(reservation) {',
  'let nativeSessionsSpawnAdmissionReservation;',
  'reserveNativeSessionsSpawnAdmission: reserveNativeAdmission',
  'releaseNativeSessionsSpawnAdmission(nativeSessionsSpawnAdmissionReservation);',
  'const nativeAdmissionReservation = ctx.reserveNativeSessionsSpawnAdmission?.();',
  'nativeAdmissionReservation.status !== "reserved"',
];
const REJECTED_MARKERS = ['withSessionsSpawnAdmissionLock(', 'sessionsSpawnAdmissionTails'];

function applyPatch(runtimeDir) {
  const files = findFilesContaining(runtimeDir, FUNCTION_ANCHOR);
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  if (files.length !== expected)
    throw new Error(
      `sessions_spawn admission target count is ${files.length}, expected ${expected}`,
    );
  const artifactStates = files.map(filePath => {
    const content = fs.readFileSync(filePath, 'utf8');
    const presentMarkers = PATCH_MARKERS.filter(marker => content.includes(marker));
    if (REJECTED_MARKERS.some(marker => content.includes(marker))) {
      throw new Error(
        `sessions_spawn admission rejected an unknown prior implementation: ${filePath}`,
      );
    }
    if (presentMarkers.length > 0 && presentMarkers.length !== PATCH_MARKERS.length) {
      throw new Error(
        `sessions_spawn admission rejected a partial artifact (${presentMarkers.length}/${PATCH_MARKERS.length} markers): ${filePath}`,
      );
    }
    return { filePath, content, markerCount: presentMarkers.length };
  });
  const fullyPatchedCount = artifactStates.filter(
    state => state.markerCount === PATCH_MARKERS.length,
  ).length;
  if (fullyPatchedCount > 0 && fullyPatchedCount !== artifactStates.length) {
    throw new Error(
      `sessions_spawn admission rejected an inconsistent source/bundle artifact (${fullyPatchedCount}/${artifactStates.length} fully patched)`,
    );
  }
  const staged = [];
  for (const { filePath, content: original } of artifactStates) {
    if (PATCH_MARKERS.every(marker => original.includes(marker))) {
      staged.push({ filePath, original, updated: original });
      continue;
    }
    let updated = original;
    if (!updated.includes('function reserveNativeSessionsSpawnAdmission(sessionKey) {')) {
      updated = replaceUnique(
        updated,
        FUNCTION_ANCHOR,
        `${HELPER}\n${FUNCTION_ANCHOR}`,
        'sessions_spawn admission helper',
      );
    }
    if (
      !updated.includes(
        'const nativeAdmissionReservation = ctx.reserveNativeSessionsSpawnAdmission?.();',
      )
    ) {
      updated = replaceUniquePattern(
        updated,
        NATIVE_PREFLIGHT_PATTERN,
        (_match, indent, bodyIndent) =>
          `${indent}if (plan.status === "error") return {\n${bodyIndent}status: "error",\n${bodyIndent}error: plan.error\n${indent}};\n${indent}const nativeAdmissionReservation = ctx.reserveNativeSessionsSpawnAdmission?.();\n${indent}if (!nativeAdmissionReservation || nativeAdmissionReservation.status !== "reserved") return formatNativeSessionsSpawnAdmissionFailure(nativeAdmissionReservation);\n${indent}const { resolvedModel, thinkingOverride } = plan;`,
        'native sessions_spawn post-preflight reservation',
      );
      updated = replaceUniquePattern(
        updated,
        PUBLIC_NATIVE_OPEN_PATTERN,
        (_match, indent) =>
          `${indent}let nativeSessionsSpawnAdmissionReservation;\n${indent}const reserveNativeAdmission = () => {\n${indent}  if (nativeSessionsSpawnAdmissionReservation) return nativeSessionsSpawnAdmissionReservation;\n${indent}  const nextReservation = reserveNativeSessionsSpawnAdmission(opts?.agentSessionKey);\n${indent}  if (nextReservation.status === "reserved") nativeSessionsSpawnAdmissionReservation = nextReservation;\n${indent}  return nextReservation;\n${indent}};\n${indent}try {\n${indent}return jsonResult(addRoleToFailureResult(await spawnSubagentDirect({`,
        'native sessions_spawn public reservation holder',
      );
      updated = replaceUniquePattern(
        updated,
        PUBLIC_NATIVE_CONTEXT_PATTERN,
        (_match, indent, closeIndent) =>
          `${indent}inheritedToolDenylist: opts?.inheritedToolDenylist,\n${indent}reserveNativeSessionsSpawnAdmission: reserveNativeAdmission\n${closeIndent}}), requestedAgentId));`,
        'native sessions_spawn reservation callback',
      );
      updated = replaceUniquePattern(
        updated,
        PUBLIC_NATIVE_CLOSE_PATTERN,
        (_match, indent) =>
          `${indent}}), requestedAgentId));\n${indent}} finally {\n${indent}  releaseNativeSessionsSpawnAdmission(nativeSessionsSpawnAdmissionReservation);\n${indent}}`,
        'native sessions_spawn public reservation release',
      );
    }
    staged.push({ filePath, original, updated });
  }
  const changed = [];
  for (const { filePath, original, updated } of staged) {
    if (writeIfChanged(filePath, original, updated))
      changed.push(path.relative(runtimeDir, filePath));
  }
  return changed;
}

function verifyPatch(runtimeDir) {
  const files = findFilesContaining(
    runtimeDir,
    'function reserveNativeSessionsSpawnAdmission(sessionKey) {',
  );
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  if (files.length !== expected)
    throw new Error('atomic sessions_spawn admission targets are incomplete');
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    if (
      !content.includes('function resolveNativeSessionsSpawnAdmissionKey(sessionKey) {') ||
      !content.includes(
        'return rawSessionKey ? resolveInternalSessionKey({ key: rawSessionKey, alias, mainKey }) : alias;',
      )
    ) {
      throw new Error(`missing canonical sessions_spawn requester resolution: ${filePath}`);
    }
    if (
      !content.includes(
        'nativeSessionsSpawnAdmissionReservations.set(requesterSessionKey, initializingChildren + 1);',
      ) ||
      !content.includes('activeChildren + initializingChildren >= maxChildren')
    ) {
      throw new Error(`missing native sessions_spawn capacity reservation: ${filePath}`);
    }
    for (const marker of [
      'let nativeSessionsSpawnAdmissionReservation;',
      'reserveNativeSessionsSpawnAdmission: reserveNativeAdmission',
      'releaseNativeSessionsSpawnAdmission(nativeSessionsSpawnAdmissionReservation);',
      'const nativeAdmissionReservation = ctx.reserveNativeSessionsSpawnAdmission?.();',
      'nativeAdmissionReservation.status !== "reserved"',
    ]) {
      if (!content.includes(marker)) {
        throw new Error(`missing native sessions_spawn admission guard ${marker}: ${filePath}`);
      }
    }
    if (
      !content.includes('const activeChildren = countActiveRunsForSession(requesterInternalKey);')
    ) {
      throw new Error(`missing native per-requester capacity authority: ${filePath}`);
    }
    const nativeStart = content.indexOf('async function spawnSubagentDirect(params, ctx) {');
    const nativeEnd = content.indexOf('\nasync function loadAcpSpawnModule()', nativeStart);
    const nativeSource =
      nativeStart >= 0 && nativeEnd > nativeStart ? content.slice(nativeStart, nativeEnd) : '';
    const toolStart = content.indexOf(FUNCTION_ANCHOR);
    const sectionEnd = content.indexOf('\n//#endregion', toolStart);
    const toolSource =
      toolStart >= 0
        ? content.slice(toolStart, sectionEnd > toolStart ? sectionEnd : undefined)
        : '';
    const acpCandidates = ['if (runtime === "acp") {', 'if (runtime3 === "acp") {']
      .map(marker => toolSource.indexOf(marker))
      .filter(index => index >= 0);
    const acpBranch = acpCandidates.length > 0 ? Math.min(...acpCandidates) : -1;
    const publicHolder = toolSource.indexOf(
      'let nativeSessionsSpawnAdmissionReservation;',
      acpBranch,
    );
    const preflightError = nativeSource.indexOf('if (plan.status === "error") return {');
    const nativeReservation = nativeSource.indexOf(
      'const nativeAdmissionReservation = ctx.reserveNativeSessionsSpawnAdmission?.();',
      preflightError,
    );
    const firstNativeAwait = nativeSource.indexOf(
      'const initialPatchError = await patchChildSession({',
    );
    if (acpBranch < 0 || publicHolder <= acpBranch) {
      throw new Error(`ACP branch is not outside the native admission holder: ${filePath}`);
    }
    if (
      preflightError < 0 ||
      nativeReservation <= preflightError ||
      firstNativeAwait <= nativeReservation
    ) {
      throw new Error(
        `native reservation is not after sync preflight and before async init: ${filePath}`,
      );
    }
  }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: {
    CONTRACT,
    HELPER,
    NATIVE_PREFLIGHT_PATTERN,
    PUBLIC_NATIVE_OPEN_PATTERN,
    PUBLIC_NATIVE_CONTEXT_PATTERN,
    PUBLIC_NATIVE_CLOSE_PATTERN,
    PATCH_MARKERS,
    REJECTED_MARKERS,
  },
};
