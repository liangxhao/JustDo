'use strict';

// Purpose: Reserve per-parent sessions_spawn capacity after each runtime's
// synchronous preflight and before its first asynchronous initialization step.
// The public tool holds the reservation through child registry registration.
// Affected OpenClaw version: v2026.6.11.
// Risk: Initialization for one parent is serialized; accepted, unregistered
// calls consume a temporary reservation.
// Remove when: OpenClaw provides this native/ACP admission boundary natively.
// Upstream tracking: TODO(openclaw): file an upstream issue with the parallel
// sessions_spawn maxChildrenPerAgent reproduction.
// Temporary: yes.

const fs = require('fs');
const path = require('path');

const HELPER_MARKER = 'const sessionsSpawnAdmissionTails = /* @__PURE__ */ new Map();';
const RESERVATION_MARKER = 'const sessionsSpawnAdmissionReservations = /* @__PURE__ */ new Map();';
const PUBLIC_HOLDER_MARKER = 'let sessionsSpawnAdmissionReservation;';
const CALLBACK_MARKER = 'reserveSessionsSpawnAdmission: reserveAdmission';
const BRANCH_MARKER = 'return await withReservedSessionsSpawnAdmission(ctx, async () => {';
const RELEASE_MARKER = 'releaseSessionsSpawnAdmissionReservation(sessionsSpawnAdmissionReservation);';
const RETRY_GUIDANCE = 'wait for an active child to finish before retrying';

const HELPER = `const sessionsSpawnAdmissionTails = /* @__PURE__ */ new Map();
const sessionsSpawnAdmissionReservations = /* @__PURE__ */ new Map();
function reserveSessionsSpawnAdmission(opts) {
  const cfg = getRuntimeConfig();
  const parentSessionKey = resolveSessionsSpawnAdmissionKey(opts);
  const configuredMaxChildren = cfg.agents?.defaults?.subagents?.maxChildrenPerAgent;
  const maxChildren = Number.isInteger(configuredMaxChildren) && configuredMaxChildren >= 1 && configuredMaxChildren <= 20 ? configuredMaxChildren : null;
  const activeChildren = countActiveRunsForSession(parentSessionKey);
  const initializingChildren = sessionsSpawnAdmissionReservations.get(parentSessionKey) ?? 0;
  if (maxChildren === null) return { status: "invalid", parentSessionKey, activeChildren, initializingChildren, maxChildren };
  if (activeChildren + initializingChildren >= maxChildren) return { status: "forbidden", parentSessionKey, activeChildren, initializingChildren, maxChildren };
  sessionsSpawnAdmissionReservations.set(parentSessionKey, initializingChildren + 1);
  return { status: "reserved", parentSessionKey, activeChildren, initializingChildren, maxChildren };
}
function releaseSessionsSpawnAdmissionReservation(reservation) {
  if (reservation?.status !== "reserved") return;
  const current = sessionsSpawnAdmissionReservations.get(reservation.parentSessionKey) ?? 0;
  if (current <= 1) sessionsSpawnAdmissionReservations.delete(reservation.parentSessionKey);
  else sessionsSpawnAdmissionReservations.set(reservation.parentSessionKey, current - 1);
}
function resolveSessionsSpawnAdmissionKey(opts) {
  const cfg = getRuntimeConfig();
  const { mainKey, alias } = resolveMainSessionAlias(cfg);
  const rawSessionKey = typeof opts?.agentSessionKey === "string" ? opts.agentSessionKey.trim() : "";
  return rawSessionKey ? resolveInternalSessionKey({ key: rawSessionKey, alias, mainKey }) : alias;
}
function formatSessionsSpawnAdmissionFailure(reservation) {
  if (!reservation || reservation.status === "invalid") return {
    status: "forbidden",
    error: "sessions_spawn requires agents.defaults.subagents.maxChildrenPerAgent to be an integer between 1 and 20"
  };
  return {
    status: "forbidden",
    error: \`sessions_spawn has reached max active children for this session (\${reservation.activeChildren} active + \${reservation.initializingChildren} initializing / \${reservation.maxChildren}); wait for an active child to finish before retrying\`
  };
}
async function withSessionsSpawnAdmissionLock(key, task) {
  const previous = sessionsSpawnAdmissionTails.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => gate);
  sessionsSpawnAdmissionTails.set(key, tail);
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release?.();
    if (sessionsSpawnAdmissionTails.get(key) === tail) sessionsSpawnAdmissionTails.delete(key);
  }
}
async function withReservedSessionsSpawnAdmission(ctx, task) {
  const reservation = ctx.reserveSessionsSpawnAdmission?.();
  if (!reservation || reservation.status !== "reserved") return formatSessionsSpawnAdmissionFailure(reservation);
  return await withSessionsSpawnAdmissionLock(reservation.parentSessionKey, task);
}
`;

const PUBLIC_PRISTINE_OPEN = `      const attachments = Array.isArray(params.attachments) ? params.attachments : void 0;
      if (runtime3 === "acp") {`;
const PUBLIC_OPEN = `      const attachments = Array.isArray(params.attachments) ? params.attachments : void 0;
      let sessionsSpawnAdmissionReservation;
      const reserveAdmission = () => {
        if (sessionsSpawnAdmissionReservation) return sessionsSpawnAdmissionReservation;
        const nextReservation = reserveSessionsSpawnAdmission(opts);
        if (nextReservation.status === "reserved") sessionsSpawnAdmissionReservation = nextReservation;
        return nextReservation;
      };
      try {
      if (runtime3 === "acp") {`;
const PUBLIC_PRISTINE_CLOSE = `      }), requestedAgentId));
    }
  };`;
const PUBLIC_CLOSE = `      }), requestedAgentId));
      } finally {
        releaseSessionsSpawnAdmissionReservation(sessionsSpawnAdmissionReservation);
      }
    }
  };`;

function replaceHelper(content) {
  const toolStart = content.indexOf('function createSessionsSpawnTool(opts) {');
  if (toolStart < 0) return { content, changed: false };
  const helperStart = content.indexOf(HELPER_MARKER);
  if (helperStart < 0) return {
    content: content.replace('function createSessionsSpawnTool(opts) {', `${HELPER}\nfunction createSessionsSpawnTool(opts) {`),
    changed: true,
  };
  const existing = content.slice(helperStart, toolStart);
  if (existing === `${HELPER}\n`) return { content, changed: false };
  return { content: `${content.slice(0, helperStart)}${HELPER}\n${content.slice(toolStart)}`, changed: true };
}

function removeOldPublicReservation(tool) {
  const oldOpenStart = tool.indexOf(`      const attachments = Array.isArray(params.attachments) ? params.attachments : void 0;
      const reservation = reserveSessionsSpawnAdmission(opts);`);
  if (oldOpenStart < 0) return { tool, changed: false };
  const branch = tool.indexOf('      if (runtime3 === "acp") {', oldOpenStart);
  const oldClose = `      }), requestedAgentId));
        })
      } finally {
        releaseSessionsSpawnAdmissionReservation(reservation);
      }
    }
  };`;
  if (branch < 0 || !tool.includes(oldClose)) return { tool, changed: false };
  return {
    tool: `${tool.slice(0, oldOpenStart)}${PUBLIC_PRISTINE_OPEN}${tool.slice(branch + '      if (runtime3 === "acp") {'.length)}`.replace(oldClose, PUBLIC_PRISTINE_CLOSE),
    changed: true,
  };
}

function patchPublicTool(content) {
  const start = content.indexOf('function createSessionsSpawnTool(opts) {');
  if (start < 0) return { content, changed: false };
  const next = content.indexOf('\nfunction ', start + 1);
  const end = next < 0 ? content.length : next;
  const before = content.slice(0, start);
  let tool = content.slice(start, end);
  const after = content.slice(end);
  let changed = false;
  const migrated = removeOldPublicReservation(tool);
  tool = migrated.tool;
  changed ||= migrated.changed;
  if (!tool.includes(PUBLIC_HOLDER_MARKER)) {
    if (!tool.includes(PUBLIC_PRISTINE_OPEN) || !tool.includes(PUBLIC_PRISTINE_CLOSE)) return { content, changed: false };
    tool = tool.replace(PUBLIC_PRISTINE_OPEN, PUBLIC_OPEN).replace(PUBLIC_PRISTINE_CLOSE, PUBLIC_CLOSE);
    changed = true;
  }
  const repeatedReservationGuard =
    'if (sessionsSpawnAdmissionReservation) return sessionsSpawnAdmissionReservation;';
  if (!tool.includes(repeatedReservationGuard)) {
    const reserveCallbackAnchor = `      const reserveAdmission = () => {
        const nextReservation = reserveSessionsSpawnAdmission(opts);`;
    const reserveCallbackPatched = `      const reserveAdmission = () => {
        if (sessionsSpawnAdmissionReservation) return sessionsSpawnAdmissionReservation;
        const nextReservation = reserveSessionsSpawnAdmission(opts);`;
    if (tool.includes(reserveCallbackAnchor)) {
      tool = tool.replace(reserveCallbackAnchor, reserveCallbackPatched);
      changed = true;
    }
  }
  const callbackAnchor = 'inheritedToolDenylist: opts?.inheritedToolDenylist';
  const callbackPatched = `${callbackAnchor},\n          reserveSessionsSpawnAdmission: reserveAdmission`;
  if (!tool.includes(CALLBACK_MARKER)) {
    const occurrences = tool.split(callbackAnchor).length - 1;
    if (occurrences === 2) {
      tool = tool.replaceAll(callbackAnchor, callbackPatched);
      changed = true;
    }
  }
  return { content: `${before}${tool}${after}`, changed };
}

function patchNativeSpawn(content) {
  const start = content.indexOf('async function spawnSubagentDirect(params, ctx) {');
  const end = content.indexOf('\nasync function loadAcpSpawnModule()', start);
  if (start < 0 || end < 0) return { content, changed: false };
  const before = content.slice(0, start);
  let fn = content.slice(start, end);
  const after = content.slice(end);
  if (fn.includes(BRANCH_MARKER)) return { content, changed: false };
  const open = `  if (plan.status === "error") return {
    status: "error",
    error: plan.error
  };
  const { resolvedModel, thinkingOverride } = plan;`;
  const openPatched = `  if (plan.status === "error") return {
    status: "error",
    error: plan.error
  };
  return await withReservedSessionsSpawnAdmission(ctx, async () => {
  const { resolvedModel, thinkingOverride } = plan;`;
  const close = `    attachments: attachmentsReceipt
  };
}`;
  const closePatched = `    attachments: attachmentsReceipt
  };
  });
}`;
  if (!fn.includes(open) || !fn.includes(close)) return { content, changed: false };
  fn = fn.replace(open, openPatched).replace(close, closePatched);
  return { content: `${before}${fn}${after}`, changed: true };
}

function patchAcpSpawn(content) {
  const start = content.indexOf('async function spawnAcpDirect(params, ctx) {');
  const end = content.indexOf('\nvar DEFAULT_STREAM_FLUSH_MS', start);
  if (start < 0 || end < 0) return { content, changed: false };
  const before = content.slice(0, start);
  let fn = content.slice(start, end);
  const after = content.slice(end);
  if (fn.includes(BRANCH_MARKER)) return { content, changed: false };
  const prepareStart = fn.indexOf('  const sessionKey = `agent:${targetAgentId}:acp:${crypto48.randomUUID()}`;');
  const prepareEnd = fn.indexOf('  let binding = null;', prepareStart);
  if (prepareStart < 0 || prepareEnd < 0) return { content, changed: false };
  const initialization = fn.slice(prepareStart, prepareEnd);
  const preparedStart = initialization.indexOf('  let preparedBinding = null;');
  if (preparedStart < 0) return { content, changed: false };
  const asyncInitialization = initialization.slice(0, preparedStart);
  const synchronousThreadPreflight = initialization.slice(preparedStart);
  fn = `${fn.slice(0, prepareStart)}${synchronousThreadPreflight}  return await withReservedSessionsSpawnAdmission(ctx, async () => {\n${asyncInitialization}${fn.slice(prepareEnd)}`;
  const close = `    note: spawnMode === "session" ? ACP_SPAWN_SESSION_ACCEPTED_NOTE : ACP_SPAWN_ACCEPTED_NOTE
  };
}`;
  const closePatched = `    note: spawnMode === "session" ? ACP_SPAWN_SESSION_ACCEPTED_NOTE : ACP_SPAWN_ACCEPTED_NOTE
  };
  });
}`;
  if (!fn.includes(close)) return { content, changed: false };
  fn = fn.replace(close, closePatched);
  return { content: `${before}${fn}${after}`, changed: true };
}

function findMissingMarkers(content) {
  const required = [HELPER_MARKER, RESERVATION_MARKER, PUBLIC_HOLDER_MARKER, CALLBACK_MARKER, RELEASE_MARKER,
    'countActiveRunsForSession(parentSessionKey)', 'activeChildren + initializingChildren >= maxChildren',
    'configuredMaxChildren <= 20', 'if (sessionsSpawnAdmissionReservation) return sessionsSpawnAdmissionReservation;',
    'sessions_spawn requires agents.defaults.subagents.maxChildrenPerAgent to be an integer between 1 and 20', RETRY_GUIDANCE];
  const missing = required.filter(marker => !content.includes(marker));
  const nativeStart = content.indexOf('async function spawnSubagentDirect(params, ctx) {');
  const nativeEnd = content.indexOf('\nasync function loadAcpSpawnModule()', nativeStart);
  const native = nativeStart >= 0 && nativeEnd > nativeStart ? content.slice(nativeStart, nativeEnd) : '';
  const acpStart = content.indexOf('async function spawnAcpDirect(params, ctx) {');
  const acpEnd = content.indexOf('\nvar DEFAULT_STREAM_FLUSH_MS', acpStart);
  const acp = acpStart >= 0 && acpEnd > acpStart ? content.slice(acpStart, acpEnd) : '';
  const toolStart = content.indexOf('function createSessionsSpawnTool(opts) {');
  const toolEnd = content.indexOf('\nfunction ', toolStart + 1);
  const tool = toolStart >= 0 ? content.slice(toolStart, toolEnd < 0 ? content.length : toolEnd) : '';
  const nativeValidation = native.indexOf('if (plan.status === "error")');
  const nativeReservation = native.indexOf(BRANCH_MARKER);
  if (nativeValidation < 0 || nativeReservation <= nativeValidation) missing.push('native post-preflight reservation ordering');
  const acpThreadValidation = acp.indexOf('if (!prepared.ok)');
  const acpReservation = acp.indexOf(BRANCH_MARKER);
  const acpFirstAwait = acp.indexOf('await resolveRuntimeCwdForAcpSpawn');
  if (acpThreadValidation < 0 || acpReservation <= acpThreadValidation || acpFirstAwait <= acpReservation) missing.push('ACP post-preflight reservation ordering');
  if ((tool.match(/reserveSessionsSpawnAdmission: reserveAdmission/g) ?? []).length !== 2) missing.push('native and ACP reservation callbacks');
  if (tool.includes('const reservation = reserveSessionsSpawnAdmission(opts);')) missing.push('stale public-entry reservation');
  return missing;
}

function patchFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  let content = fs.readFileSync(filePath, 'utf8');
  let changed = false;
  for (const patcher of [replaceHelper, patchPublicTool, patchNativeSpawn, patchAcpSpawn]) {
    const result = patcher(content);
    content = result.content;
    changed ||= result.changed;
  }
  if (!changed) return false;
  const missing = findMissingMarkers(content);
  if (missing.length > 0) throw new Error(`Atomic sessions_spawn admission patch could only be partially applied: ${missing.join(', ')}`);
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function applyPatch(runtimeDir, options = {}) {
  const filePath = path.join(runtimeDir, 'gateway-bundle.mjs');
  const patched = fs.existsSync(filePath) && patchFile(filePath) ? ['gateway-bundle.mjs'] : [];
  const label = options.label || 'patch-openclaw-atomic-sessions-spawn-admission';
  if (patched.length > 0) console.log(`[${label}] Patched atomic sessions_spawn admission: ${patched.join(', ')}`);
  else if (options.verbose) console.log(`[${label}] No atomic sessions_spawn admission patch needed.`);
  return patched;
}

function verifyPatch(runtimeDir) {
  const content = fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8');
  const missing = findMissingMarkers(content);
  if (missing.length > 0) throw new Error(`Atomic sessions_spawn admission patch is incomplete: ${missing.join(', ')}`);
  return true;
}

module.exports = { applyPatch, verifyPatch };
