'use strict';

// Capability: return completed managed-child results from sessions_yield without ending the parent turn.
// Target: pristine openclaw@2026.7.1-2 plus the explicit classifier contract from patch 017.
// Scope: managed sessions_yield admission, durable waiting/presented states and incremental result batches.
// Safety: native onYield remains byte-for-byte on the non-managed branch; state is persisted before waiting.
// Remove when: upstream sessions_yield can durably join children within the invoking tool call.

const fs = require('fs');
const path = require('path');
const { findFilesContaining, replaceUnique, writeIfChanged } = require('./_patch-utils.js');

const STATE_IMPORT =
  'import { H as resolveSubagentRunTimerDelayMs } from "./subagent-registry-state-CP7kKu69.js";';
const STATE_IMPORT_PATCHED =
  'import { H as resolveSubagentRunTimerDelayMs, U as subagentRuns, r as persistSubagentRunsToDiskOrThrow } from "./subagent-registry-state-CP7kKu69.js";';

function buildJustDoManagedJoinResult(entry) {
  const outcome = entry?.outcome && typeof entry.outcome === 'object' ? entry.outcome : {};
  return {
    runId: typeof entry?.runId === 'string' ? entry.runId : '',
    sessionKey: typeof entry?.childSessionKey === 'string' ? entry.childSessionKey : '',
    status:
      typeof outcome.status === 'string'
        ? outcome.status
        : typeof entry?.endedAt === 'number'
          ? 'ok'
          : 'running',
    result: typeof entry?.completion?.resultText === 'string' ? entry.completion.resultText : null,
    ...(typeof outcome.error === 'string' && outcome.error ? { error: outcome.error } : {}),
    ...(typeof entry?.startedAt === 'number' ? { startedAt: entry.startedAt } : {}),
    ...(typeof entry?.endedAt === 'number' ? { endedAt: entry.endedAt } : {}),
  };
}

function partitionJustDoManagedJoinResults(entries) {
  const completed = entries.filter(
    entry =>
      typeof entry?.endedAt === 'number' &&
      typeof entry?.completion?.capturedAt === 'number' &&
      entry?.delivery?.justDoManagedJoin?.state === 'waiting',
  );
  return { completed, pending: entries.length - completed.length };
}

function selectJustDoManagedJoinVisibleRuns(entries) {
  return entries.filter(entry => {
    if (
      !entry?.runId ||
      entry.delivery?.status === 'delivered' ||
      entry.delivery?.status === 'discarded'
    )
      return false;
    const state = entry.delivery?.justDoManagedJoin?.state;
    return state !== 'presented' && state !== 'tool_result_committed' && state !== 'consumed';
  });
}

const HELPERS = `const JUSTDO_MANAGED_JOIN_GLOBAL = Symbol.for("justdo.openclaw.managed-subagent-join.v2026.7.1-2");
const justDoManagedJoinWaiters = new Map();
${buildJustDoManagedJoinResult.toString()}
${partitionJustDoManagedJoinResults.toString()}
${selectJustDoManagedJoinVisibleRuns.toString()}
function isJustDoManagedJoinPending(entry) {
\tconst state = entry?.delivery?.justDoManagedJoin?.state;
\treturn state === "waiting" || state === "presented" || state === "tool_result_committed";
}
function mutateJustDoManagedJoinEntries(entries, mutator) {
\tfor (const candidate of entries) {
\t\tconst entry = subagentRuns.get(candidate.runId);
\t\tif (entry) mutator(entry);
\t}
\tpersistSubagentRunsToDiskOrThrow(subagentRuns);
}
async function waitForJustDoManagedSubagentsCore(opts, message, toolCallId) {
\tconst controllerSessionKey = typeof opts?.agentSessionKey === "string" ? opts.agentSessionKey.trim() : "";
\tconst visibleRuns = selectJustDoManagedJoinVisibleRuns(listControlledSubagentRuns(controllerSessionKey));
\tif (visibleRuns.length === 0) return jsonResult({
\t\tstatus: "no_active_subagents",
\t\tmessage: "No controlled subagents remain; continue without yielding.",
\t\tresults: []
\t});
\tconst snapshots = new Map(visibleRuns.map((entry) => [entry.runId, structuredClone(subagentRuns.get(entry.runId) ?? entry)]));
\tconst startedAt = Date.now();
\ttry {
\t\tmutateJustDoManagedJoinEntries(visibleRuns, (entry) => {
\t\t\tconst priorJoin = entry.delivery?.justDoManagedJoin;
\t\t\tif (isJustDoManagedJoinPending(entry)) return;
\t\t\tentry.delivery = {
\t\t\t\t...entry.delivery,
\t\t\t\tstatus: "not_required",
\t\t\t\tjustDoManagedJoin: {
\t\t\t\t\tstate: "waiting",
\t\t\t\t\tstartedAt,
\t\t\t\t\tcontrollerSessionKey,
\t\t\t\t\toriginalCleanup: priorJoin?.originalCleanup ?? entry.cleanup,
\t\t\t\t\toriginalExpectsCompletionMessage: priorJoin?.originalExpectsCompletionMessage ?? entry.expectsCompletionMessage
\t\t\t\t}
\t\t\t};
\t\t\tentry.expectsCompletionMessage = false;
\t\t\tentry.completion = { ...entry.completion, required: false };
\t\t\tif (entry.cleanup === "delete") entry.cleanup = "keep";
\t\t\tentry.cleanupHandled = false;
\t\t\tentry.cleanupCompletedAt = void 0;
\t\t});
\t} catch (error) {
\t\tfor (const [runId, snapshot] of snapshots) subagentRuns.set(runId, snapshot);
\t\treturn jsonResult({ status: "error", error: \`Unable to durably start subagent join: \${error instanceof Error ? error.message : String(error)}\` });
\t}
\tconst expectedRunIds = new Set(visibleRuns.map((entry) => entry.runId));
\tfor (;;) {
\t\tif (opts.abortSignal?.aborted) {
\t\t\tglobalThis[JUSTDO_MANAGED_JOIN_GLOBAL]?.restoreDelivery?.(controllerSessionKey);
\t\t\treturn jsonResult({ status: "aborted", message: "Subagent join was stopped; completion delivery was restored.", results: [] });
\t\t}
\t\tconst currentRuns = listControlledSubagentRuns(controllerSessionKey).filter((entry) => expectedRunIds.has(entry.runId));
\t\tconst { completed, pending } = partitionJustDoManagedJoinResults(currentRuns);
\t\tif (completed.length > 0) {
\t\t\tconst presentedAt = Date.now();
\t\t\ttry {
\t\t\t\tmutateJustDoManagedJoinEntries(completed, (entry) => {
\t\t\t\t\tentry.delivery.justDoManagedJoin = { ...entry.delivery.justDoManagedJoin, state: "presented", presentedAt, toolCallId };
\t\t\t\t});
\t\t\t} catch (error) {
\t\t\t\tglobalThis[JUSTDO_MANAGED_JOIN_GLOBAL]?.restoreDelivery?.(controllerSessionKey);
\t\t\t\treturn jsonResult({ status: "error", error: \`Unable to durably record subagent results: \${error instanceof Error ? error.message : String(error)}\` });
\t\t\t}
\t\t\treturn jsonResult({ status: pending > 0 ? "partial" : "completed", message, pending, results: completed.map(buildJustDoManagedJoinResult) });
\t\t}
\t\tawait new Promise((resolve) => setTimeout(resolve, 50));
\t}
}
async function waitForJustDoManagedSubagents(opts, message, toolCallId) {
\tconst controllerSessionKey = typeof opts?.agentSessionKey === "string" ? opts.agentSessionKey.trim() : "";
\tif (!controllerSessionKey) return jsonResult({ status: "error", error: "Managed subagent join requires a controller session." });
\tif (justDoManagedJoinWaiters.has(controllerSessionKey)) return jsonResult({
\t\tstatus: "already_waiting",
\t\tmessage: "A sessions_yield call is already waiting for this controller.",
\t\tresults: []
\t});
\tjustDoManagedJoinWaiters.set(controllerSessionKey, toolCallId);
\ttry {
\t\treturn await waitForJustDoManagedSubagentsCore(opts, message, toolCallId);
\t} finally {
\t\tif (justDoManagedJoinWaiters.get(controllerSessionKey) === toolCallId) justDoManagedJoinWaiters.delete(controllerSessionKey);
\t}
}
`;

function transform(content, filePath) {
  if (content.includes('function waitForJustDoManagedSubagents(')) return content;
  if (!content.includes('function isJustDoManagedSessionFromRuns(runs, sessionKey)'))
    throw new Error(`${filePath}: managed classification prerequisite is missing`);
  let updated = replaceUnique(
    content,
    STATE_IMPORT,
    STATE_IMPORT_PATCHED,
    `${filePath}: managed join state imports`,
  );
  updated = replaceUnique(
    updated,
    '//#region src/agents/tools/sessions-yield-tool.ts',
    `${HELPERS}//#region src/agents/tools/sessions-yield-tool.ts`,
    `${filePath}: managed same-run join helpers`,
  );
  updated = replaceUnique(
    updated,
    '\t\texecute: async (_toolCallId, args) => {\n\t\t\tconst message = readStringParam(args, "message") || "Turn yielded.";',
    '\t\texecute: async (_toolCallId, args) => {\n\t\t\tconst message = readStringParam(args, "message") || "Turn yielded.";\n\t\t\tif (isJustDoManagedSessionFromRuns(subagentRuns, opts?.agentSessionKey)) return await waitForJustDoManagedSubagents(opts, message, _toolCallId);',
    `${filePath}: managed sessions_yield dispatch`,
  );
  updated = replaceUnique(
    updated,
    'createSessionsYieldTool({\n\t\t\tsessionId: options?.sessionId,\n\t\t\tonYield: options?.onYield\n\t\t})',
    'createSessionsYieldTool({\n\t\t\tsessionId: options?.sessionId,\n\t\t\tagentSessionKey: options?.agentSessionKey,\n\t\t\tabortSignal: options?.abortSignal,\n\t\t\tonYield: options?.onYield\n\t\t})',
    `${filePath}: managed sessions_yield context`,
  );
  return updated;
}

function locateTarget(runtimeDir) {
  const files = findFilesContaining(runtimeDir, [
    'function createSessionsYieldTool(opts)',
    'function isJustDoManagedSessionFromRuns(runs, sessionKey)',
  ]);
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  if (files.length !== expected)
    throw new Error(`managed same-run join target count is ${files.length}, expected ${expected}`);
  return files;
}

function applyPatch(runtimeDir) {
  const staged = locateTarget(runtimeDir).map(filePath => {
    const original = fs.readFileSync(filePath, 'utf8');
    return { filePath, original, updated: transform(original, filePath) };
  });
  const changed = [];
  for (const { filePath, original, updated } of staged)
    if (writeIfChanged(filePath, original, updated))
      changed.push(path.relative(runtimeDir, filePath));
  return changed;
}

function verifyPatch(runtimeDir) {
  for (const filePath of locateTarget(runtimeDir)) {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const expected of [
      'function waitForJustDoManagedSubagents(',
      'function waitForJustDoManagedSubagentsCore(',
      'return await waitForJustDoManagedSubagents(opts,',
      'justDoManagedJoinWaiters.has(controllerSessionKey)',
      'selectJustDoManagedJoinVisibleRuns(listControlledSubagentRuns(controllerSessionKey))',
      'state: "waiting"',
      'state: "presented"',
      'persistSubagentRunsToDiskOrThrow(subagentRuns);',
      'await opts.onYield(',
    ])
      if (!content.includes(expected))
        throw new Error(`managed same-run join contract is missing from ${filePath}: ${expected}`);
  }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: {
    buildJustDoManagedJoinResult,
    partitionJustDoManagedJoinResults,
    selectJustDoManagedJoinVisibleRuns,
  },
};
