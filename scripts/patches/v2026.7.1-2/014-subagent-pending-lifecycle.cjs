'use strict';

// Capability: show accepted subagent work as pending until its real lifecycle start.
// Target: pristine openclaw@2026.7.1-2, which stamps accepted registry/task rows as running.
// Scope: registry admission, lifecycle transition, detached task state and list/session projections.
// Safety: queue time does not populate startedAt or consume the explicit run-timeout budget.
// Remove when: upstream persists and projects accepted/queued/running as distinct lifecycle states.

const fs = require('fs');
const path = require('path');
const { findFilesContaining, replaceUnique, writeIfChanged } = require('./_patch-utils.js');

const CONTRACT = 'JUSTDO_SUBAGENT_PENDING_LIFECYCLE_2026_7_1';
const TASK_IMPORT_ANCHOR =
  'import { a as failTaskRunByRunId, i as createRunningTaskRun, n as completeTaskRunByRunId, o as finalizeTaskRunByRunId, s as findDetachedTaskRun, u as setDetachedTaskDeliveryStatusByRunId } from "./detached-task-runtime-B93mVzDV.js";';
const TASK_IMPORT_REPLACEMENT =
  'import { a as failTaskRunByRunId, d as startTaskRunByRunId, i as createRunningTaskRun, n as completeTaskRunByRunId, o as finalizeTaskRunByRunId, r as createQueuedTaskRun, s as findDetachedTaskRun, u as setDetachedTaskDeliveryStatusByRunId } from "./detached-task-runtime-B93mVzDV.js";';

const LIFECYCLE_HELPERS = `const ${CONTRACT} = true;
const JUSTDO_SUBAGENT_EARLY_START_TTL_MS = 5 * 60 * 1e3;
const justDoSubagentEarlyStarts = /* @__PURE__ */ new Map();
function rememberJustDoSubagentEarlyStart(runId, startedAt, now = Date.now()) {
\tfor (const [candidateRunId, candidate] of justDoSubagentEarlyStarts) if (now - candidate.observedAt > JUSTDO_SUBAGENT_EARLY_START_TTL_MS) justDoSubagentEarlyStarts.delete(candidateRunId);
\tjustDoSubagentEarlyStarts.set(runId, { startedAt, observedAt: now });
}
function takeJustDoSubagentEarlyStart(runId) {
\tconst candidate = justDoSubagentEarlyStarts.get(runId);
\tjustDoSubagentEarlyStarts.delete(runId);
\treturn candidate?.startedAt;
}
function buildJustDoSubagentAdmissionState(startedAt, queuedAt) {
\tif (typeof startedAt === "number" && Number.isFinite(startedAt)) return {
\t\tstartedAt,
\t\texecution: { status: "running", startedAt }
\t};
\treturn { execution: { status: "pending", queuedAt } };
}
function markJustDoSubagentLifecycleStarted(entry, startedAt) {
\tentry.startedAt = startedAt;
\tif (typeof entry.sessionStartedAt !== "number") entry.sessionStartedAt = startedAt;
\tentry.execution = {
\t\t...entry.execution,
\t\tstatus: "running",
\t\tstartedAt
\t};
\tdelete entry.execution.queuedAt;
}
`;

function transformRegistry(content, filePath) {
  if (content.includes('function buildJustDoSubagentAdmissionState(')) {
    for (const contract of [
      'buildJustDoSubagentAdmissionState(admittedRunStartedAt, now)',
      'createQueuedTaskRun : createRunningTaskRun',
      'rememberJustDoSubagentEarlyStart(evt.runId, startedAt)',
      'markJustDoSubagentLifecycleStarted(entry, startedAt)',
      'startTaskRunByRunId({',
    ]) {
      if (!content.includes(contract))
        throw new Error(`${filePath}: partial subagent pending registry patch detected`);
    }
    return content;
  }
  let updated = replaceUnique(
    content,
    TASK_IMPORT_ANCHOR,
    TASK_IMPORT_REPLACEMENT,
    `${filePath}: queued task lifecycle imports`,
  );
  updated = replaceUnique(
    updated,
    'function createSubagentRunManager(params) {',
    `${LIFECYCLE_HELPERS}function createSubagentRunManager(params) {`,
    `${filePath}: pending lifecycle helpers`,
  );
  updated = replaceUnique(
    updated,
    `\t\tconst sessionStartedAt = getSubagentSessionStartedAt(source) ?? now;
\t\tconst accumulatedRuntimeMs = getSubagentSessionRuntimeMs(source, typeof source.endedAt === "number" ? source.endedAt : now) ?? 0;`,
    `\t\tconst sessionStartedAt = getSubagentSessionStartedAt(source) ?? now;
\t\tconst accumulatedRuntimeMs = getSubagentSessionRuntimeMs(source, typeof source.endedAt === "number" ? source.endedAt : now) ?? 0;
\t\tconst admittedRunStartedAt = takeJustDoSubagentEarlyStart(nextRunId);
\t\tconst admittedExecution = buildJustDoSubagentAdmissionState(admittedRunStartedAt, now).execution;`,
    `${filePath}: replacement run admission state`,
  );
  updated = replaceUnique(
    updated,
    `\t\t\tcreatedAt: now,
\t\t\tstartedAt: now,
\t\t\tsessionStartedAt,
\t\t\taccumulatedRuntimeMs,`,
    `\t\t\tcreatedAt: now,
\t\t\t...admittedRunStartedAt === void 0 ? {} : { startedAt: admittedRunStartedAt },
\t\t\tsessionStartedAt,
\t\t\taccumulatedRuntimeMs,`,
    `${filePath}: replacement run start timestamp`,
  );
  updated = replaceUnique(
    updated,
    `\t\t\texecution: {
\t\t\t\tstatus: "running",
\t\t\t\tstartedAt: now,
\t\t\t\ttranscriptFile: replaceParams.transcriptFile
\t\t\t},`,
    `\t\t\texecution: {
\t\t\t\t...admittedExecution,
\t\t\t\ttranscriptFile: replaceParams.transcriptFile
\t\t\t},`,
    `${filePath}: replacement run execution state`,
  );
  updated = replaceUnique(
    updated,
    `\t\tif (!runId || !childSessionKey || !requesterSessionKey) return;
\t\tconst now = Date.now();
\t\tconst generation = nextSubagentRunGeneration(params.runs.values(), childSessionKey);`,
    `\t\tif (!runId || !childSessionKey || !requesterSessionKey) return;
\t\tparams.ensureListener();
\t\tconst now = Date.now();
\t\tconst admittedRunStartedAt = takeJustDoSubagentEarlyStart(runId);
\t\tconst admittedState = buildJustDoSubagentAdmissionState(admittedRunStartedAt, now);
\t\tconst generation = nextSubagentRunGeneration(params.runs.values(), childSessionKey);`,
    `${filePath}: initial run admission state`,
  );
  updated = replaceUnique(
    updated,
    `\t\t\tcreatedAt: now,
\t\t\tstartedAt: now,
\t\t\texecution: {
\t\t\t\tstatus: "running",
\t\t\t\tstartedAt: now
\t\t\t},`,
    `\t\t\tcreatedAt: now,
\t\t\t...admittedState,`,
    `${filePath}: initial registry pending state`,
  );
  updated = replaceUnique(
    updated,
    `\t\t\tdelivery: { status: registerParams.expectsCompletionMessage === false ? "not_required" : "pending" },
\t\t\tsessionStartedAt: now,
\t\t\taccumulatedRuntimeMs: 0,`,
    `\t\t\tdelivery: { status: registerParams.expectsCompletionMessage === false ? "not_required" : "pending" },
\t\t\t...admittedRunStartedAt === void 0 ? {} : { sessionStartedAt: admittedRunStartedAt },
\t\t\taccumulatedRuntimeMs: 0,`,
    `${filePath}: initial session start timestamp`,
  );
  updated = replaceUnique(
    updated,
    `\t\ttry {
\t\t\tif (!createRunningTaskRun({`,
    `\t\ttry {
\t\t\tconst createAcceptedTaskRun = admittedRunStartedAt === void 0 ? createQueuedTaskRun : createRunningTaskRun;
\t\t\tif (!createAcceptedTaskRun({`,
    `${filePath}: detached task accepted state`,
  );
  updated = replaceUnique(
    updated,
    `\t\t\t\tdeliveryStatus: registerParams.expectsCompletionMessage === false ? "not_applicable" : "pending",
\t\t\t\tstartedAt: now,
\t\t\t\tlastEventAt: now`,
    `\t\t\t\tdeliveryStatus: registerParams.expectsCompletionMessage === false ? "not_applicable" : "pending",
\t\t\t\t...admittedRunStartedAt === void 0 ? {} : { startedAt: admittedRunStartedAt },
\t\t\t\tlastEventAt: admittedRunStartedAt ?? now`,
    `${filePath}: detached task start timestamp`,
  );
  updated = replaceUnique(
    updated,
    `\t\t\tconst entry = subagentRuns.get(evt.runId);
\t\t\tif (!entry) {
\t\t\t\tif (phase === "end" && typeof evt.sessionKey === "string") await refreshFrozenResultFromSession(evt.sessionKey);
\t\t\t\treturn;
\t\t\t}`,
    `\t\t\tconst entry = subagentRuns.get(evt.runId);
\t\t\tif (!entry) {
\t\t\t\tif (phase === "start") {
\t\t\t\t\tconst startedAt = typeof evt.data?.startedAt === "number" ? evt.data.startedAt : Date.now();
\t\t\t\t\trememberJustDoSubagentEarlyStart(evt.runId, startedAt);
\t\t\t\t} else if (phase === "end" || phase === "error") justDoSubagentEarlyStarts.delete(evt.runId);
\t\t\t\tif (phase === "end" && typeof evt.sessionKey === "string") await refreshFrozenResultFromSession(evt.sessionKey);
\t\t\t\treturn;
\t\t\t}`,
    `${filePath}: early lifecycle start capture`,
  );
  updated = replaceUnique(
    updated,
    `\t\t\tif (phase === "start") {
\t\t\t\tclearPendingLifecycleError(evt.runId);
\t\t\t\tclearPendingLifecycleTimeout(evt.runId);
\t\t\t\tconst startedAt = typeof evt.data?.startedAt === "number" ? evt.data.startedAt : void 0;
\t\t\t\tif (startedAt) {
\t\t\t\t\tentry.startedAt = startedAt;
\t\t\t\t\tif (typeof entry.sessionStartedAt !== "number") entry.sessionStartedAt = startedAt;
\t\t\t\t\tpersistSubagentRuns();
\t\t\t\t}
\t\t\t\treturn;
\t\t\t}`,
    `\t\t\tif (phase === "start") {
\t\t\t\tclearPendingLifecycleError(evt.runId);
\t\t\t\tclearPendingLifecycleTimeout(evt.runId);
\t\t\t\tjustDoSubagentEarlyStarts.delete(evt.runId);
\t\t\t\tconst startedAt = typeof evt.data?.startedAt === "number" ? evt.data.startedAt : Date.now();
\t\t\t\tmarkJustDoSubagentLifecycleStarted(entry, startedAt);
\t\t\t\tstartTaskRunByRunId({
\t\t\t\t\truntime: "subagent",
\t\t\t\t\trunId: entry.taskRunId ?? evt.runId,
\t\t\t\t\tsessionKey: entry.childSessionKey,
\t\t\t\t\tstartedAt,
\t\t\t\t\tlastEventAt: startedAt
\t\t\t\t});
\t\t\t\tpersistSubagentRuns();
\t\t\t\treturn;
\t\t\t}`,
    `${filePath}: lifecycle start transition`,
  );
  return updated;
}

function transformState(content, filePath) {
  if (content.includes('if (entry.execution?.status === "pending") return;')) {
    for (const contract of [
      'return entry.execution?.status === "pending" ? "pending" : "running";',
      'status: "pending",',
      'queuedAt: entry.execution?.queuedAt ?? entry.createdAt',
    ]) {
      if (!content.includes(contract))
        throw new Error(`${filePath}: partial subagent pending state patch detected`);
    }
    return content;
  }
  let updated = replaceUnique(
    content,
    `function resolveSubagentRunDeadlineMs(entry, observedStartedAt) {
\tconst durationMs = resolveSubagentRunDurationMs(entry.runTimeoutSeconds);`,
    `function resolveSubagentRunDeadlineMs(entry, observedStartedAt) {
\tif (entry.execution?.status === "pending") return;
\tconst durationMs = resolveSubagentRunDurationMs(entry.runTimeoutSeconds);`,
    `${filePath}: pending deadline`,
  );
  updated = replaceUnique(
    updated,
    `function resolveSubagentSessionStartedAtInternal(entry) {
\tif (typeof entry.sessionStartedAt === "number"`,
    `function resolveSubagentSessionStartedAtInternal(entry) {
\tif (entry.execution?.status === "pending") return;
\tif (typeof entry.sessionStartedAt === "number"`,
    `${filePath}: pending start projection`,
  );
  updated = replaceUnique(
    updated,
    'if (!entry.endedAt) return "running";',
    'if (!entry.endedAt) return entry.execution?.status === "pending" ? "pending" : "running";',
    `${filePath}: pending session status`,
  );
  updated = replaceUnique(
    updated,
    `\treturn {
\t\tstatus: "running",
\t\tstartedAt: entry.startedAt
\t};
}
function buildCompletionState`,
    `\tif (entry.execution?.status === "pending" || typeof entry.startedAt !== "number") return {
\t\tstatus: "pending",
\t\tqueuedAt: entry.execution?.queuedAt ?? entry.createdAt
\t};
\treturn {
\t\tstatus: "running",
\t\tstartedAt: entry.startedAt
\t};
}
function buildCompletionState`,
    `${filePath}: normalized execution state`,
  );
  return updated;
}

function transformList(content, filePath) {
  if (content.includes('entry.execution?.status === "pending" ? "pending" : "running"'))
    return content;
  return replaceUnique(
    content,
    'if (!hasSubagentRunEnded(entry)) return "running";',
    'if (!hasSubagentRunEnded(entry)) return entry.execution?.status === "pending" ? "pending" : "running";',
    `${filePath}: pending subagent list status`,
  );
}

function locateTargets(runtimeDir) {
  const registry = findFilesContaining(runtimeDir, [
    'function createSubagentRunManager(params)',
    'function ensureListener()',
    'const registerSubagentRun = (registerParams) =>',
  ]);
  const state = findFilesContaining(runtimeDir, [
    'function resolveSubagentRunDeadlineMs(entry, observedStartedAt)',
    'function resolveSubagentSessionStatus(entry)',
    'function buildExecutionState(entry)',
  ]);
  const list = findFilesContaining(runtimeDir, [
    'function resolveRunStatus(entry, options)',
    'function buildSubagentList(params)',
  ]);
  const expectedStateAndList = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  if (
    registry.length !== 1 ||
    state.length !== expectedStateAndList ||
    list.length !== expectedStateAndList
  )
    throw new Error(
      `subagent pending lifecycle target counts are registry=${registry.length}, state=${state.length}, list=${list.length}; ` +
        `expected registry=1, state/list=${expectedStateAndList}`,
    );
  return { registry, state, list };
}

function applyPatch(runtimeDir) {
  const targets = locateTargets(runtimeDir);
  const allFiles = [...new Set([...targets.registry, ...targets.state, ...targets.list])];
  const originals = new Map(
    allFiles.map(filePath => [filePath, fs.readFileSync(filePath, 'utf8')]),
  );
  const updates = new Map();
  for (const filePath of allFiles) {
    let updated = originals.get(filePath);
    if (targets.registry.includes(filePath)) updated = transformRegistry(updated, filePath);
    if (targets.state.includes(filePath)) updated = transformState(updated, filePath);
    if (targets.list.includes(filePath)) updated = transformList(updated, filePath);
    updates.set(filePath, updated);
  }
  const changed = [];
  for (const [filePath, updated] of updates) {
    if (writeIfChanged(filePath, originals.get(filePath), updated))
      changed.push(path.relative(runtimeDir, filePath));
  }
  return changed;
}

function verifyPatch(runtimeDir) {
  const targets = locateTargets(runtimeDir);
  const combined = [...new Set([...targets.registry, ...targets.state, ...targets.list])]
    .map(filePath => fs.readFileSync(filePath, 'utf8'))
    .join('\n');
  for (const contract of [
    CONTRACT,
    'status: "pending", queuedAt',
    'const createAcceptedTaskRun = admittedRunStartedAt === void 0 ? createQueuedTaskRun : createRunningTaskRun;',
    'markJustDoSubagentLifecycleStarted(entry, startedAt);',
    'startTaskRunByRunId({',
    'if (entry.execution?.status === "pending") return;',
    'entry.execution?.status === "pending" ? "pending" : "running"',
  ]) {
    if (!combined.includes(contract))
      throw new Error(`subagent pending lifecycle contract is missing: ${contract}`);
  }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: { CONTRACT, TASK_IMPORT_ANCHOR, TASK_IMPORT_REPLACEMENT, LIFECYCLE_HELPERS },
};
