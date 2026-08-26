'use strict';

// Capability: recover aborted, restarted and unconsumed managed joins through native delivery state.
// Target: pristine openclaw@2026.7.1-2 plus patches 018-019's durable join states and commit bridge.
// Scope: abort/failure fallback, startup reconciliation and deferred delete cleanup after a restart.
// Safety: unconsumed joins restore their original cleanup/completion policy before native resume runs.
// Remove when: upstream durably resumes or falls back every interrupted same-run join.

const fs = require('fs');
const path = require('path');
const {
  findFilesContaining,
  replaceUnique,
  replaceUniquePattern,
  writeIfChanged,
} = require('./_patch-utils.js');

const REGISTRY_IMPORT =
  'import { B as markJustDoManagedJoinToolResultPersisted, C as commitJustDoManagedJoinContinuation, h as registerSubagentRun, i as countActiveRunsForSession } from "./subagent-registry-DexSZ4w1.js";';
const REGISTRY_IMPORT_PATCHED =
  'import { A as restoreJustDoManagedJoinDelivery, B as markJustDoManagedJoinToolResultPersisted, C as commitJustDoManagedJoinContinuation, h as registerSubagentRun, i as countActiveRunsForSession } from "./subagent-registry-DexSZ4w1.js";';

function restoreJustDoManagedJoinEntry(entry) {
  const join = entry?.delivery?.justDoManagedJoin;
  if (!join || join.state === 'consumed') return false;
  const expectsCompletionMessage = join.originalExpectsCompletionMessage !== false;
  entry.expectsCompletionMessage = expectsCompletionMessage;
  entry.completion = { ...entry.completion, required: expectsCompletionMessage };
  entry.cleanup = join.originalCleanup === 'delete' ? 'delete' : 'keep';
  entry.cleanupHandled = false;
  entry.cleanupCompletedAt = undefined;
  entry.delivery = {
    status: expectsCompletionMessage ? 'pending' : 'not_required',
    ...(join.startedAt ? { createdAt: join.startedAt } : {}),
  };
  return true;
}

function shouldRestoreJustDoManagedJoinRun(
  runId,
  entry,
  controller,
  requestedRunIds,
  requestedChildSessionKeys,
  onlyCommitted,
) {
  const join = entry?.delivery?.justDoManagedJoin;
  if (!join || join.controllerSessionKey !== controller || join.state === 'consumed') return false;
  const matchesRunId = requestedRunIds?.has(runId) === true;
  const matchesWaitingChild =
    requestedChildSessionKeys?.has(entry.childSessionKey) === true && join.state === 'waiting';
  if ((requestedRunIds || requestedChildSessionKeys) && !matchesRunId && !matchesWaitingChild)
    return false;
  return onlyCommitted !== true || join.state === 'tool_result_committed';
}

const REGISTRY_HELPERS = `${restoreJustDoManagedJoinEntry.toString()}
${shouldRestoreJustDoManagedJoinRun.toString()}
function restoreJustDoManagedJoinDelivery(params) {
\tconst controller = typeof params?.controllerSessionKey === "string" ? params.controllerSessionKey.trim() : "";
\tif (!controller) return false;
\tconst requestedRunIds = Array.isArray(params.runIds)
\t\t? new Set(params.runIds.filter((runId) => typeof runId === "string" && runId))
\t\t: null;
\tconst requestedChildSessionKeys = Array.isArray(params.childSessionKeys)
\t\t? new Set(params.childSessionKeys.filter((sessionKey) => typeof sessionKey === "string" && sessionKey))
\t\t: null;
\tconst restoredRunIds = [];
\tfor (const [runId, entry] of subagentRuns) {
\t\tif (!shouldRestoreJustDoManagedJoinRun(runId, entry, controller, requestedRunIds, requestedChildSessionKeys, params.onlyCommitted)) continue;
\t\tif (restoreJustDoManagedJoinEntry(entry)) restoredRunIds.push(runId);
\t}
\tif (restoredRunIds.length === 0) return false;
\tpersistSubagentRunsOrThrow();
\tfor (const runId of restoredRunIds) {
\t\tconst entry = subagentRuns.get(runId);
\t\tif (!entry || typeof entry.endedAt !== "number") continue;
\t\tresumedRuns.delete(runId);
\t\tresumeSubagentRun(runId);
\t}
\treturn true;
}
function recoverJustDoManagedJoinsAfterRestart() {
\tlet changed = false;
\tconst consumedDeleteRunIds = [];
\tfor (const [runId, entry] of subagentRuns) {
\t\tconst join = entry.delivery?.justDoManagedJoin;
\t\tif (!join) continue;
\t\tif (join.state === "consumed") {
\t\t\tif (join.originalCleanup === "delete" && typeof entry.cleanupCompletedAt !== "number") consumedDeleteRunIds.push(runId);
\t\t\tcontinue;
\t\t}
\t\tchanged = restoreJustDoManagedJoinEntry(entry) || changed;
\t}
\treturn { changed, consumedDeleteRunIds };
}
`;

function transformRegistry(content, filePath) {
  if (content.includes('function recoverJustDoManagedJoinsAfterRestart()')) return content;
  let updated = replaceUnique(
    content,
    'const resumedRuns = /* @__PURE__ */ new Set();',
    `${REGISTRY_HELPERS}const resumedRuns = /* @__PURE__ */ new Set();`,
    `${filePath}: managed join recovery transitions`,
  );
  updated = replaceUnique(
    updated,
    `\t\tif (subagentRegistryDeps.restoreSubagentRunsFromDisk({
\t\t\truns: subagentRuns,
\t\t\tmergeOnly: true
\t\t}) === 0) return;
\t\tif (reconcileOrphanedRestoredRuns({
\t\t\truns: subagentRuns,
\t\t\tresumedRuns
\t\t})) persistSubagentRuns();`,
    `\t\tif (subagentRegistryDeps.restoreSubagentRunsFromDisk({
\t\t\truns: subagentRuns,
\t\t\tmergeOnly: true
\t\t}) === 0) return;
\t\tconst justDoJoinRecovery = recoverJustDoManagedJoinsAfterRestart();
\t\tif (reconcileOrphanedRestoredRuns({
\t\t\truns: subagentRuns,
\t\t\tresumedRuns
\t\t}) || justDoJoinRecovery.changed) persistSubagentRuns();`,
    `${filePath}: managed join startup recovery`,
  );
  updated = replaceUnique(
    updated,
    '\t\tfor (const runId of subagentRuns.keys()) resumeSubagentRun(runId);',
    '\t\tfor (const runId of subagentRuns.keys()) resumeSubagentRun(runId);\n\t\tfor (const runId of justDoJoinRecovery.consumedDeleteRunIds) {\n\t\t\tconst entry = subagentRuns.get(runId);\n\t\t\tif (entry) startSubagentAnnounceCleanupFlow(runId, entry);\n\t\t}',
    `${filePath}: managed join consumed cleanup recovery`,
  );
  updated = replaceUniquePattern(
    updated,
    /export \{ ([^\n]+) \};/,
    (_match, exports) => `export { restoreJustDoManagedJoinDelivery as A, ${exports} };`,
    `${filePath}: managed join recovery export`,
  );
  return updated;
}

function transformTools(content, filePath) {
  if (
    content.includes(
      'restoreJustDoManagedJoinDelivery({ controllerSessionKey: sessionKey, runIds, childSessionKeys })',
    )
  )
    return content;
  if (!content.includes('function installJustDoManagedJoinCommitBridge()'))
    throw new Error(`${filePath}: managed join commit bridge prerequisite is missing`);
  let updated = replaceUnique(
    content,
    REGISTRY_IMPORT,
    REGISTRY_IMPORT_PATCHED,
    `${filePath}: managed join recovery import`,
  );
  updated = replaceUnique(
    updated,
    '\t\tcommitContinuation(sessionKey) {\n\t\t\ttry { return commitJustDoManagedJoinContinuation(sessionKey); } catch { return false; }\n\t\t}\n\t};',
    `\t\tcommitContinuation(sessionKey) {
\t\t\ttry { return commitJustDoManagedJoinContinuation(sessionKey); } catch { return false; }
\t\t},
\t\trestoreDelivery(sessionKey, runIds, childSessionKeys) {
\t\t\ttry { return restoreJustDoManagedJoinDelivery({ controllerSessionKey: sessionKey, runIds, childSessionKeys }); } catch { return false; }
\t\t}
\t};`,
    `${filePath}: managed join recovery bridge`,
  );
  return updated;
}

function transformTranscript(content, filePath) {
  if (content.includes('restoreJustDoManagedJoinAfterContinuationFailure')) return content;
  let updated = replaceUnique(
    content,
    'function notifyJustDoManagedJoinContinuationCommitted(sessionKey) {\n\tglobalThis[JUSTDO_MANAGED_JOIN_TRANSCRIPT_GLOBAL]?.commitContinuation?.(sessionKey);\n}',
    `function notifyJustDoManagedJoinContinuationCommitted(sessionKey) {
\tglobalThis[JUSTDO_MANAGED_JOIN_TRANSCRIPT_GLOBAL]?.commitContinuation?.(sessionKey);
}
function restoreJustDoManagedJoinAfterContinuationFailure(sessionKey) {
\tglobalThis[JUSTDO_MANAGED_JOIN_TRANSCRIPT_GLOBAL]?.restoreDelivery?.(sessionKey);
}`,
    `${filePath}: managed join transcript recovery bridge`,
  );
  updated = replaceUnique(
    updated,
    'if (finalRole === "assistant" && finalMessage.stopReason === "stop" && toolCalls.length === 0) notifyJustDoManagedJoinContinuationCommitted(opts?.sessionKey);',
    'if (finalRole === "assistant" && finalMessage.stopReason === "stop" && toolCalls.length === 0) notifyJustDoManagedJoinContinuationCommitted(opts?.sessionKey);\n\t\telse if (finalRole === "assistant" && (finalMessage.stopReason === "error" || finalMessage.stopReason === "aborted")) restoreJustDoManagedJoinAfterContinuationFailure(opts?.sessionKey);',
    `${filePath}: managed join failed continuation fallback`,
  );
  return updated;
}

function transformCodex(content, filePath) {
  if (content.includes('bridge.restoreDelivery?.(params.sessionKey)')) return content;
  return replaceUnique(
    content,
    '\tif (finalAssistant?.stopReason === "stop") bridge.commitContinuation?.(params.sessionKey);',
    '\tif (finalAssistant?.stopReason === "stop") bridge.commitContinuation?.(params.sessionKey);\n\telse if (finalAssistant?.stopReason === "error" || finalAssistant?.stopReason === "aborted") bridge.restoreDelivery?.(params.sessionKey);',
    `${filePath}: managed join Codex failure fallback`,
  );
}

function locateTargets(runtimeDir) {
  const unique = files => [...new Set(files)];
  const tools = findFilesContaining(runtimeDir, [
    'function createSessionsYieldTool(opts)',
    'function installJustDoManagedJoinCommitBridge()',
  ]);
  const registry = unique([
    ...findFilesContaining(runtimeDir, [
      'function restoreSubagentRunsOnce()',
      'const resumedRuns = /* @__PURE__ */ new Set();',
    ]),
    ...findFilesContaining(runtimeDir, [
      'function restoreSubagentRunsOnce()',
      'function recoverJustDoManagedJoinsAfterRestart()',
    ]),
  ]);
  const transcript = findFilesContaining(runtimeDir, [
    'function notifyJustDoManagedJoinContinuationCommitted(',
    'const guardedAppend',
  ]);
  const codex = findFilesContaining(runtimeDir, [
    'function commitJustDoManagedJoinCodexMirror(',
    'function mirrorCodexAppServerTranscript(',
  ]).filter(
    filePath =>
      !fs
        .readFileSync(filePath, 'utf8')
        .includes('function patchJustDoOfficialCodexPlugin(params)'),
  );
  const bundledExpected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  const companionExpected = 1;
  if (
    tools.length !== bundledExpected ||
    registry.length !== bundledExpected ||
    transcript.length !== bundledExpected ||
    codex.length !== companionExpected
  )
    throw new Error(
      `managed join recovery target counts are tools=${tools.length}, registry=${registry.length}, transcript=${transcript.length}, codex=${codex.length}; expected bundled=${bundledExpected}, companion=${companionExpected}`,
    );
  return { tools, registry, transcript, codex };
}

function applyPatch(runtimeDir) {
  const targets = locateTargets(runtimeDir);
  const transforms = new Map();
  for (const filePath of targets.tools)
    transforms.set(filePath, [...(transforms.get(filePath) ?? []), transformTools]);
  for (const filePath of targets.registry)
    transforms.set(filePath, [...(transforms.get(filePath) ?? []), transformRegistry]);
  for (const filePath of targets.transcript)
    transforms.set(filePath, [...(transforms.get(filePath) ?? []), transformTranscript]);
  for (const filePath of targets.codex)
    transforms.set(filePath, [...(transforms.get(filePath) ?? []), transformCodex]);
  const staged = [];
  for (const [filePath, fileTransforms] of transforms) {
    const original = fs.readFileSync(filePath, 'utf8');
    const updated = fileTransforms.reduce(
      (value, transform) => transform(value, filePath),
      original,
    );
    staged.push({ filePath, original, updated });
  }
  const changed = [];
  for (const { filePath, original, updated } of staged)
    if (writeIfChanged(filePath, original, updated))
      changed.push(path.relative(runtimeDir, filePath));
  return changed;
}

function verifyPatch(runtimeDir) {
  const targets = locateTargets(runtimeDir);
  for (const [name, files, contracts] of [
    [
      'registry',
      targets.registry,
      [
        'function restoreJustDoManagedJoinDelivery(params)',
        'function recoverJustDoManagedJoinsAfterRestart()',
        'justDoJoinRecovery.consumedDeleteRunIds',
        'shouldRestoreJustDoManagedJoinRun(runId, entry, controller, requestedRunIds, requestedChildSessionKeys, params.onlyCommitted)',
        'requestedChildSessionKeys?.has(entry.childSessionKey) === true &&',
        'state ===',
        'waiting',
      ],
    ],
    [
      'tools',
      targets.tools,
      [
        'restoreJustDoManagedJoinDelivery({ controllerSessionKey: sessionKey, runIds, childSessionKeys })',
      ],
    ],
    [
      'transcript',
      targets.transcript,
      ['restoreJustDoManagedJoinAfterContinuationFailure', 'finalMessage.stopReason === "aborted"'],
    ],
    [
      'codex',
      targets.codex,
      ['bridge.restoreDelivery?.(params.sessionKey)', 'finalAssistant?.stopReason === "aborted"'],
    ],
  ])
    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf8');
      for (const contract of contracts)
        if (!content.includes(contract))
          throw new Error(
            `managed join recovery ${name} contract is missing from ${filePath}: ${contract}`,
          );
    }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: { restoreJustDoManagedJoinEntry, shouldRestoreJustDoManagedJoinRun },
};
