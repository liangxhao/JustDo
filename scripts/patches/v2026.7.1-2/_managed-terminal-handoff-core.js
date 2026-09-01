'use strict';

const path = require('path');
const { replaceUnique, replaceUniquePattern, stableFunctionSource } = require('./_patch-utils.js');

const MARKER = 'JUSTDO_MANAGED_TERMINAL_HANDOFF_V2026_7_1_2';

function isJustDoExplicitWaitingHandoff(entry, controllerSessionKey) {
  const controller = typeof controllerSessionKey === 'string' ? controllerSessionKey.trim() : '';
  const join = entry?.delivery?.justDoManagedJoin;
  return (
    Boolean(controller) &&
    entry?.requesterSessionKey?.trim() === controller &&
    join?.state === 'waiting' &&
    join.controllerSessionKey === controller
  );
}

function canCorrelateJustDoCompletionSourceEntry(entry, params) {
  const controller =
    typeof params?.controllerSessionKey === 'string' ? params.controllerSessionKey.trim() : '';
  const source = typeof params?.sourceSessionKey === 'string' ? params.sourceSessionKey.trim() : '';
  if (
    !controller ||
    !source ||
    entry?.childSessionKey?.trim() !== source ||
    entry?.requesterSessionKey?.trim() !== controller ||
    entry?.delivery?.status === 'delivered' ||
    entry?.delivery?.status === 'discarded'
  )
    return false;
  const join = entry.delivery?.justDoManagedJoin;
  if (!join) return entry.expectsCompletionMessage === true && entry.completion?.required !== false;
  return (
    join.controllerSessionKey === controller &&
    join.originalExpectsCompletionMessage === true &&
    typeof params?.gatewayRunId === 'string' &&
    Boolean(params.gatewayRunId) &&
    join.gatewayRunId === params.gatewayRunId &&
    typeof join.toolCallId === 'string' &&
    Boolean(join.toolCallId.trim()) &&
    ['presented', 'tool_result_committed'].includes(join.state)
  );
}

function mutateJustDoManagedJoinEntriesAtomically(runs, entries, mutator, persist) {
  const snapshots = new Map();
  try {
    for (const candidate of entries) {
      const entry = runs.get(candidate.runId);
      if (!entry) continue;
      if (!snapshots.has(candidate.runId))
        snapshots.set(candidate.runId, { entry, snapshot: structuredClone(entry) });
      mutator(entry);
    }
    persist(runs);
  } catch (error) {
    for (const [runId, { entry, snapshot }] of snapshots) {
      for (const key of Object.keys(entry)) delete entry[key];
      Object.assign(entry, snapshot);
      if (runs.get(runId) !== entry) runs.set(runId, entry);
    }
    throw error;
  }
}

function restoreJustDoManagedJoinSnapshotsInPlace(runs, snapshots) {
  for (const [runId, snapshot] of snapshots) {
    const entry = runs.get(runId);
    if (!entry || typeof entry !== 'object') {
      runs.set(runId, snapshot);
      continue;
    }
    for (const key of Object.keys(entry)) delete entry[key];
    Object.assign(entry, snapshot);
  }
}

function mutateJustDoSubagentRegistryAtomically(runs, mutation, persist) {
  const snapshots = new Map(
    [...runs.entries()]
      .filter(([, entry]) => Boolean(entry?.delivery?.justDoManagedJoin))
      .map(([runId, entry]) => [runId, { entry, snapshot: structuredClone(entry) }]),
  );
  try {
    const result = mutation();
    if (result?.changed === true) persist();
    return result;
  } catch (error) {
    for (const [runId, { entry, snapshot }] of snapshots) {
      for (const key of Object.keys(entry)) delete entry[key];
      Object.assign(entry, snapshot);
      if (runs.get(runId) !== entry) runs.set(runId, entry);
    }
    throw error;
  }
}

function shouldAttemptJustDoCodexTerminalHandoff(params) {
  return Boolean(
    params?.attemptSucceeded &&
    params.hasSessionKey &&
    !params.aborted &&
    !params.timedOut &&
    !params.promptError &&
    !params.yieldDetected,
  );
}

function resolveJustDoCodexTerminalHandoffOutcome(implicitJoin, params) {
  if (params?.aborted || params?.timedOut) return { status: 'interrupted' };
  if (
    implicitJoin?.status === 'joined' &&
    typeof implicitJoin.prompt === 'string' &&
    implicitJoin.prompt
  )
    return { status: 'joined', prompt: implicitJoin.prompt };
  if (implicitJoin?.status === 'error' && implicitJoin.deliveryRestored !== true)
    return { status: 'durability_error' };
  return { status: 'terminal' };
}

function transformTools(content, filePath) {
  const isBundle = path.basename(filePath) === 'gateway-bundle.mjs';
  const contracts = [
    `// ${MARKER}`,
    isBundle
      ? 'join20?.state === "waiting" && join20.controllerSessionKey === controller'
      : 'join?.state === "waiting" && join.controllerSessionKey === controller',
    'priorJoin?.state === "waiting" && priorJoin.controllerSessionKey === controllerSessionKey',
    'gatewayRunId: opts.runId',
    'runId: options?.runId',
    isBundle
      ? 'mutateJustDoManagedJoinEntriesAtomically(subagentRuns, entries2, mutator'
      : 'mutateJustDoManagedJoinEntriesAtomically(subagentRuns, entries, mutator',
    'function restoreJustDoManagedJoinSnapshotsInPlace(',
    'restoreJustDoManagedJoinSnapshotsInPlace(subagentRuns, snapshots);',
    'gatewayRunId: params?.runId',
  ];
  if (content.includes(`// ${MARKER}`)) {
    const missing = contracts.filter(contract => !content.includes(contract));
    if (missing.length === 0) return content;
    throw new Error(
      `${filePath}: partial managed terminal handoff tools patch detected; missing ${missing.join(', ')}`,
    );
  }
  if (
    content.includes('gatewayRunId: opts.runId') ||
    content.includes('mutateJustDoManagedJoinEntriesAtomically(subagentRuns, entries, mutator')
  )
    throw new Error(`${filePath}: partial managed terminal handoff tools patch detected`);

  let updated = replaceUnique(
    content,
    isBundle
      ? 'function selectJustDoImplicitJoinRuns(entries2, controllerSessionKey) {'
      : 'function selectJustDoImplicitJoinRuns(entries, controllerSessionKey) {',
    `// ${MARKER}\n${stableFunctionSource(isJustDoExplicitWaitingHandoff)}\n${
      isBundle
        ? 'function selectJustDoImplicitJoinRuns(entries2, controllerSessionKey) {'
        : 'function selectJustDoImplicitJoinRuns(entries, controllerSessionKey) {'
    }`,
    `${filePath}: terminal handoff selector helper`,
  );
  updated = replaceUnique(
    updated,
    isBundle
      ? '    if (join20?.state === "implicit_waiting") return join20.controllerSessionKey === controller;\n    if (join20) return false;'
      : "    if (join?.state === 'implicit_waiting') return join.controllerSessionKey === controller;\n    if (join) return false;",
    isBundle
      ? '    if (join20?.state === "implicit_waiting") return join20.controllerSessionKey === controller;\n    if (join20?.state === "waiting" && join20.controllerSessionKey === controller) return true;\n    if (join20) return false;'
      : '    if (join?.state === \'implicit_waiting\') return join.controllerSessionKey === controller;\n    if (join?.state === "waiting" && join.controllerSessionKey === controller) return true;\n    if (join) return false;',
    `${filePath}: select explicit waiting handoff`,
  );
  updated = replaceUnique(
    updated,
    isBundle
      ? 'if (priorJoin?.state === "implicit_waiting" && priorJoin.controllerSessionKey === controllerSessionKey) return;\n      if (priorJoin) throw new Error("Required subagent completion is already owned by another delivery path.");'
      : 'if (priorJoin?.state === "implicit_waiting" && priorJoin.controllerSessionKey === controllerSessionKey) return;\n\t\t\tif (priorJoin) throw new Error("Required subagent completion is already owned by another delivery path.");',
    isBundle
      ? 'if (priorJoin?.state === "implicit_waiting" && priorJoin.controllerSessionKey === controllerSessionKey) return;\n      if (priorJoin?.state === "waiting" && priorJoin.controllerSessionKey === controllerSessionKey) {\n        entry.delivery.justDoManagedJoin = {\n          ...priorJoin,\n          state: "implicit_waiting",\n          gatewaySessionId: params?.sessionId,\n          gatewayRunId: params?.runId\n        };\n        return;\n      }\n      if (priorJoin) throw new Error("Required subagent completion is already owned by another delivery path.");'
      : 'if (priorJoin?.state === "implicit_waiting" && priorJoin.controllerSessionKey === controllerSessionKey) return;\n\t\t\tif (priorJoin?.state === "waiting" && priorJoin.controllerSessionKey === controllerSessionKey) {\n\t\t\t\tentry.delivery.justDoManagedJoin = {\n\t\t\t\t\t...priorJoin,\n\t\t\t\t\tstate: "implicit_waiting",\n\t\t\t\t\tgatewaySessionId: params?.sessionId,\n\t\t\t\t\tgatewayRunId: params?.runId\n\t\t\t\t};\n\t\t\t\treturn;\n\t\t\t}\n\t\t\tif (priorJoin) throw new Error("Required subagent completion is already owned by another delivery path.");',
    `${filePath}: transfer explicit waiting ownership`,
  );
  updated = replaceUnique(
    updated,
    isBundle
      ? 'function mutateJustDoManagedJoinEntries(entries2, mutator) {\n  for (const candidate of entries2) {\n    const entry = subagentRuns.get(candidate.runId);\n    if (entry) mutator(entry);\n  }\n  persistSubagentRunsToDiskOrThrow(subagentRuns);\n}'
      : 'function mutateJustDoManagedJoinEntries(entries, mutator) {\n\tfor (const candidate of entries) {\n\t\tconst entry = subagentRuns.get(candidate.runId);\n\t\tif (entry) mutator(entry);\n\t}\n\tpersistSubagentRunsToDiskOrThrow(subagentRuns);\n}',
    `${stableFunctionSource(mutateJustDoManagedJoinEntriesAtomically)}\n${stableFunctionSource(restoreJustDoManagedJoinSnapshotsInPlace)}\n${
      isBundle
        ? 'function mutateJustDoManagedJoinEntries(entries2, mutator) {\n  return mutateJustDoManagedJoinEntriesAtomically(subagentRuns, entries2, mutator, persistSubagentRunsToDiskOrThrow);\n}'
        : 'function mutateJustDoManagedJoinEntries(entries, mutator) {\n\treturn mutateJustDoManagedJoinEntriesAtomically(subagentRuns, entries, mutator, persistSubagentRunsToDiskOrThrow);\n}'
    }`,
    `${filePath}: atomic managed join mutation`,
  );
  const legacyOuterRollback =
    'for (const [runId, snapshot] of snapshots) subagentRuns.set(runId, snapshot);';
  const legacyOuterRollbackCount = updated.split(legacyOuterRollback).length - 1;
  if (legacyOuterRollbackCount !== 2)
    throw new Error(
      `${filePath}: managed join outer rollback count is ${legacyOuterRollbackCount}, expected 2`,
    );
  updated = updated
    .split(legacyOuterRollback)
    .join('restoreJustDoManagedJoinSnapshotsInPlace(subagentRuns, snapshots);');
  updated = replaceUnique(
    updated,
    isBundle
      ? 'gatewaySessionId: opts.sessionId,\n          originalCleanup:'
      : 'gatewaySessionId: opts.sessionId,\n\t\t\t\t\toriginalCleanup:',
    isBundle
      ? 'gatewaySessionId: opts.sessionId,\n          gatewayRunId: opts.runId,\n          originalCleanup:'
      : 'gatewaySessionId: opts.sessionId,\n\t\t\t\t\tgatewayRunId: opts.runId,\n\t\t\t\t\toriginalCleanup:',
    `${filePath}: explicit join run provenance`,
  );
  updated = replaceUnique(
    updated,
    isBundle
      ? 'createSessionsYieldTool({\n      sessionId: options?.sessionId,'
      : 'createSessionsYieldTool({\n\t\t\tsessionId: options?.sessionId,',
    isBundle
      ? 'createSessionsYieldTool({\n      sessionId: options?.sessionId,\n      runId: options?.runId,'
      : 'createSessionsYieldTool({\n\t\t\tsessionId: options?.sessionId,\n\t\t\trunId: options?.runId,',
    `${filePath}: yield tool run provenance`,
  );
  updated = replaceUnique(
    updated,
    'function resolveJustDoCompletionFollowupJoin(',
    `${stableFunctionSource(canCorrelateJustDoCompletionSourceEntry)}\nfunction resolveJustDoCompletionFollowupJoin(`,
    `${filePath}: completion source handoff correlation helper`,
  );
  updated = replaceUnique(
    updated,
    isBundle
      ? 'function resolveJustDoCompletionFollowupJoin(entries2, controllerSessionKey, completionSourceSessionKey, registeredRuns) {'
      : '  registeredRuns,\n) {\n  if (completionSourceSessionKey === undefined)',
    isBundle
      ? 'function resolveJustDoCompletionFollowupJoin(entries2, controllerSessionKey, completionSourceSessionKey, registeredRuns, gatewayRunId) {'
      : '  registeredRuns,\n  gatewayRunId,\n) {\n  if (completionSourceSessionKey === undefined)',
    `${filePath}: completion source correlation run parameter`,
  );
  updated = replaceUniquePattern(
    updated,
    /const sourceEntry = entries\d*\.find\([\s\S]*?\n\s*\);\n\s*if \(!sourceEntry\)/,
    `const sourceEntry = [...registeredRuns ?? []].find((entry) => canCorrelateJustDoCompletionSourceEntry(entry, {\n    controllerSessionKey: controller,\n    sourceSessionKey: source,\n    gatewayRunId\n  }));\n  if (!sourceEntry)`,
    `${filePath}: correlate native or same-run explicit source`,
  );
  updated = replaceUnique(
    updated,
    'resolveJustDoCompletionFollowupJoin(selectedRuns, controllerSessionKey, params?.excludedChildSessionKey, subagentRuns.values())',
    'resolveJustDoCompletionFollowupJoin(selectedRuns, controllerSessionKey, params?.excludedChildSessionKey, subagentRuns.values(), params?.runId)',
    `${filePath}: completion source run id`,
  );
  return updated;
}

function transformEmbeddedAttempt(content, filePath) {
  const isBundle = path.basename(filePath) === 'gateway-bundle.mjs';
  const promptErrorContract =
    'promptError = new Error("Managed subagent terminal handoff could not be persisted.");' +
    (isBundle ? '\n              ' : '\n\t\t\t\t\t\t\t') +
    'promptErrorSource = "prompt";';
  const contracts = [
    'event: "terminal_handoff_failed"',
    'recovery: implicitJoin.deliveryRestored === true ? "native_delivery_restored" : "native_delivery_not_restored"',
    promptErrorContract,
  ];
  const appliedCount = contracts.filter(contract => content.includes(contract)).length;
  if (appliedCount === contracts.length) return content;
  if (
    content.includes(
      'promptError = new Error("Managed subagent terminal handoff could not be persisted.");',
    )
  )
    throw new Error(`${filePath}: legacy managed terminal handoff embedded patch is unsupported`);
  if (appliedCount > 0)
    throw new Error(`${filePath}: partial managed terminal handoff embedded patch detected`);
  return replaceUnique(
    content,
    isBundle
      ? 'if (implicitJoin?.status === "joined" && typeof implicitJoin.prompt === "string" && implicitJoin.prompt) {\n            beforeAgentFinalizeRevisionReason = JUSTDO_MANAGED_IMPLICIT_JOIN_REVISION_PREFIX + implicitJoin.prompt;\n            return { suppressTerminalDelivery: true };\n          }'
      : 'if (implicitJoin?.status === "joined" && typeof implicitJoin.prompt === "string" && implicitJoin.prompt) {\n\t\t\t\t\t\tbeforeAgentFinalizeRevisionReason = JUSTDO_MANAGED_IMPLICIT_JOIN_REVISION_PREFIX + implicitJoin.prompt;\n\t\t\t\t\t\treturn { suppressTerminalDelivery: true };\n\t\t\t\t\t}',
    isBundle
      ? 'if (implicitJoin?.status === "joined" && typeof implicitJoin.prompt === "string" && implicitJoin.prompt) {\n            beforeAgentFinalizeRevisionReason = JUSTDO_MANAGED_IMPLICIT_JOIN_REVISION_PREFIX + implicitJoin.prompt;\n            return { suppressTerminalDelivery: true };\n          }\n          if (implicitJoin?.status === "error") {\n            console.warn("[JustDoManagedTerminalHandoff] " + JSON.stringify({\n              event: "terminal_handoff_failed",\n              sessionId: params?.sessionId,\n              runId: params?.runId,\n              reason: typeof implicitJoin.error === "string" && implicitJoin.error ? implicitJoin.error : "unknown",\n              deliveryRestored: implicitJoin.deliveryRestored === true,\n              recovery: implicitJoin.deliveryRestored === true ? "native_delivery_restored" : "native_delivery_not_restored"\n            }));\n            if (implicitJoin.deliveryRestored !== true) {\n              promptError = new Error("Managed subagent terminal handoff could not be persisted.");\n              promptErrorSource = "prompt";\n              return { suppressTerminalDelivery: true };\n            }\n          }'
      : 'if (implicitJoin?.status === "joined" && typeof implicitJoin.prompt === "string" && implicitJoin.prompt) {\n\t\t\t\t\t\tbeforeAgentFinalizeRevisionReason = JUSTDO_MANAGED_IMPLICIT_JOIN_REVISION_PREFIX + implicitJoin.prompt;\n\t\t\t\t\t\treturn { suppressTerminalDelivery: true };\n\t\t\t\t\t}\n\t\t\t\t\tif (implicitJoin?.status === "error") {\n\t\t\t\t\t\tconsole.warn("[JustDoManagedTerminalHandoff] " + JSON.stringify({\n\t\t\t\t\t\t\tevent: "terminal_handoff_failed",\n\t\t\t\t\t\t\tsessionId: params?.sessionId,\n\t\t\t\t\t\t\trunId: params?.runId,\n\t\t\t\t\t\t\treason: typeof implicitJoin.error === "string" && implicitJoin.error ? implicitJoin.error : "unknown",\n\t\t\t\t\t\t\tdeliveryRestored: implicitJoin.deliveryRestored === true,\n\t\t\t\t\t\t\trecovery: implicitJoin.deliveryRestored === true ? "native_delivery_restored" : "native_delivery_not_restored"\n\t\t\t\t\t\t}));\n\t\t\t\t\t\tif (implicitJoin.deliveryRestored !== true) {\n\t\t\t\t\t\t\tpromptError = new Error("Managed subagent terminal handoff could not be persisted.");\n\t\t\t\t\t\t\tpromptErrorSource = "prompt";\n\t\t\t\t\t\t\treturn { suppressTerminalDelivery: true };\n\t\t\t\t\t\t}\n\t\t\t\t\t}',
    `${filePath}: fail-safe terminal handoff error`,
  );
}

function transformRegistry(content, filePath) {
  const isBundle = path.basename(filePath) === 'gateway-bundle.mjs';
  const contracts = [
    'function mutateJustDoSubagentRegistryAtomically(',
    'return mutateJustDoSubagentRegistryAtomically(subagentRuns, () => {',
    'deleteRunIds } = mutateJustDoSubagentRegistryAtomically(',
    'restoredRunIds } = mutateJustDoSubagentRegistryAtomically(',
  ];
  const appliedCount = contracts.filter(contract => content.includes(contract)).length;
  if (appliedCount === contracts.length) return content;
  if (appliedCount > 0)
    throw new Error(`${filePath}: partial managed terminal handoff registry patch detected`);
  let updated = replaceUnique(
    content,
    isBundle
      ? 'function markJustDoManagedJoinToolResultPersisted(controllerSessionKey, toolCallId) {\n  const changed = markJustDoManagedJoinToolResultInRuns(subagentRuns, controllerSessionKey, toolCallId, Date.now());\n  if (changed) persistSubagentRunsOrThrow();\n  return changed;\n}'
      : 'function markJustDoManagedJoinToolResultPersisted(controllerSessionKey, toolCallId) {\n\tconst changed = markJustDoManagedJoinToolResultInRuns(subagentRuns, controllerSessionKey, toolCallId, Date.now());\n\tif (changed) persistSubagentRunsOrThrow();\n\treturn changed;\n}',
    `${stableFunctionSource(mutateJustDoSubagentRegistryAtomically)}\n${
      isBundle
        ? 'function markJustDoManagedJoinToolResultPersisted(controllerSessionKey, toolCallId) {\n  return mutateJustDoSubagentRegistryAtomically(subagentRuns, () => {\n    const changed = markJustDoManagedJoinToolResultInRuns(subagentRuns, controllerSessionKey, toolCallId, Date.now());\n    return { changed };\n  }, persistSubagentRunsOrThrow).changed;\n}'
        : 'function markJustDoManagedJoinToolResultPersisted(controllerSessionKey, toolCallId) {\n\treturn mutateJustDoSubagentRegistryAtomically(subagentRuns, () => {\n\t\tconst changed = markJustDoManagedJoinToolResultInRuns(subagentRuns, controllerSessionKey, toolCallId, Date.now());\n\t\treturn { changed };\n\t}, persistSubagentRunsOrThrow).changed;\n}'
    }`,
    `${filePath}: atomic managed tool-result commit`,
  );
  updated = replaceUnique(
    updated,
    isBundle
      ? 'function commitJustDoManagedJoinContinuation(controllerSessionKey) {\n  const { changed, deleteRunIds } = commitJustDoManagedJoinContinuationInRuns(subagentRuns, controllerSessionKey, Date.now());\n  if (!changed) return false;\n  persistSubagentRunsOrThrow();'
      : 'function commitJustDoManagedJoinContinuation(controllerSessionKey) {\n\tconst { changed, deleteRunIds } = commitJustDoManagedJoinContinuationInRuns(subagentRuns, controllerSessionKey, Date.now());\n\tif (!changed) return false;\n\tpersistSubagentRunsOrThrow();',
    isBundle
      ? 'function commitJustDoManagedJoinContinuation(controllerSessionKey) {\n  const { changed, deleteRunIds } = mutateJustDoSubagentRegistryAtomically(subagentRuns, () => commitJustDoManagedJoinContinuationInRuns(subagentRuns, controllerSessionKey, Date.now()), persistSubagentRunsOrThrow);\n  if (!changed) return false;'
      : 'function commitJustDoManagedJoinContinuation(controllerSessionKey) {\n\tconst { changed, deleteRunIds } = mutateJustDoSubagentRegistryAtomically(subagentRuns, () => commitJustDoManagedJoinContinuationInRuns(subagentRuns, controllerSessionKey, Date.now()), persistSubagentRunsOrThrow);\n\tif (!changed) return false;',
    `${filePath}: atomic managed continuation commit`,
  );
  updated = replaceUnique(
    updated,
    isBundle
      ? 'const restoredRunIds = [];\n  for (const [runId, entry] of subagentRuns) {\n    if (!shouldRestoreJustDoManagedJoinRun(runId, entry, controller, requestedRunIds, requestedChildSessionKeys, params.onlyCommitted)) continue;\n    if (restoreJustDoManagedJoinEntry(entry)) restoredRunIds.push(runId);\n  }\n  if (restoredRunIds.length === 0) return false;\n  persistSubagentRunsOrThrow();'
      : 'const restoredRunIds = [];\n\tfor (const [runId, entry] of subagentRuns) {\n\t\tif (!shouldRestoreJustDoManagedJoinRun(runId, entry, controller, requestedRunIds, requestedChildSessionKeys, params.onlyCommitted)) continue;\n\t\tif (restoreJustDoManagedJoinEntry(entry)) restoredRunIds.push(runId);\n\t}\n\tif (restoredRunIds.length === 0) return false;\n\tpersistSubagentRunsOrThrow();',
    isBundle
      ? 'const { changed, restoredRunIds } = mutateJustDoSubagentRegistryAtomically(subagentRuns, () => {\n    const restoredRunIds = [];\n    for (const [runId, entry] of subagentRuns) {\n      if (!shouldRestoreJustDoManagedJoinRun(runId, entry, controller, requestedRunIds, requestedChildSessionKeys, params.onlyCommitted)) continue;\n      if (restoreJustDoManagedJoinEntry(entry)) restoredRunIds.push(runId);\n    }\n    return { changed: restoredRunIds.length > 0, restoredRunIds };\n  }, persistSubagentRunsOrThrow);\n  if (!changed) return false;'
      : 'const { changed, restoredRunIds } = mutateJustDoSubagentRegistryAtomically(subagentRuns, () => {\n\t\tconst restoredRunIds = [];\n\t\tfor (const [runId, entry] of subagentRuns) {\n\t\t\tif (!shouldRestoreJustDoManagedJoinRun(runId, entry, controller, requestedRunIds, requestedChildSessionKeys, params.onlyCommitted)) continue;\n\t\t\tif (restoreJustDoManagedJoinEntry(entry)) restoredRunIds.push(runId);\n\t\t}\n\t\treturn { changed: restoredRunIds.length > 0, restoredRunIds };\n\t}, persistSubagentRunsOrThrow);\n\tif (!changed) return false;',
    `${filePath}: atomic managed delivery restore`,
  );
  return updated;
}

module.exports = {
  isJustDoExplicitWaitingHandoff,
  canCorrelateJustDoCompletionSourceEntry,
  mutateJustDoManagedJoinEntriesAtomically,
  restoreJustDoManagedJoinSnapshotsInPlace,
  mutateJustDoSubagentRegistryAtomically,
  shouldAttemptJustDoCodexTerminalHandoff,
  resolveJustDoCodexTerminalHandoffOutcome,
  transformTools,
  transformEmbeddedAttempt,
  transformRegistry,
};
