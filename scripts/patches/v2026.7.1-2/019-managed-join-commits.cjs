'use strict';

// Capability: persist managed-join tool-result and successful-continuation commits separately.
// Target: pristine openclaw@2026.7.1-2 plus patch 018's waiting/presented registry contract.
// Scope: registry transitions, Pi transcript appends, Codex transcript mirrors and post-consumption cleanup.
// Safety: cleanup=delete is restored only after the continuation commit is durable; failed turns are not consumed.
// Remove when: upstream exposes durable join presentation/consumption commits and cleanup fencing.

const fs = require('fs');
const path = require('path');
const {
  findFilesContaining,
  replaceUnique,
  replaceUniquePattern,
  writeIfChanged,
} = require('./_patch-utils.js');

const REGISTRY_IMPORT =
  'import { h as registerSubagentRun, i as countActiveRunsForSession } from "./subagent-registry-DexSZ4w1.js";';
const REGISTRY_IMPORT_PATCHED =
  'import { B as markJustDoManagedJoinToolResultPersisted, C as commitJustDoManagedJoinContinuation, h as registerSubagentRun, i as countActiveRunsForSession } from "./subagent-registry-DexSZ4w1.js";';

function markJustDoManagedJoinToolResultInRuns(runs, controllerSessionKey, toolCallId, now) {
  const controller = typeof controllerSessionKey === 'string' ? controllerSessionKey.trim() : '';
  const callId = typeof toolCallId === 'string' ? toolCallId.trim() : '';
  if (!controller || !callId) return false;
  let changed = false;
  for (const entry of runs.values()) {
    const join = entry.delivery?.justDoManagedJoin;
    if (
      !join ||
      join.controllerSessionKey !== controller ||
      join.state !== 'presented' ||
      join.toolCallId !== callId
    )
      continue;
    entry.delivery.justDoManagedJoin = {
      ...join,
      state: 'tool_result_committed',
      toolResultCommittedAt: now,
    };
    changed = true;
  }
  return changed;
}

function commitJustDoManagedJoinContinuationInRuns(runs, controllerSessionKey, now) {
  const controller = typeof controllerSessionKey === 'string' ? controllerSessionKey.trim() : '';
  const deleteRunIds = [];
  if (!controller) return { changed: false, deleteRunIds };
  let changed = false;
  for (const [runId, entry] of runs) {
    const join = entry.delivery?.justDoManagedJoin;
    if (!join || join.controllerSessionKey !== controller || join.state !== 'tool_result_committed')
      continue;
    entry.delivery.justDoManagedJoin = { ...join, state: 'consumed', consumedAt: now };
    if (join.originalCleanup === 'delete') {
      entry.cleanup = 'delete';
      entry.cleanupHandled = false;
      entry.cleanupCompletedAt = undefined;
      deleteRunIds.push(runId);
    }
    changed = true;
  }
  return { changed, deleteRunIds };
}

const REGISTRY_HELPERS = `${markJustDoManagedJoinToolResultInRuns.toString()}
${commitJustDoManagedJoinContinuationInRuns.toString()}
function markJustDoManagedJoinToolResultPersisted(controllerSessionKey, toolCallId) {
\tconst changed = markJustDoManagedJoinToolResultInRuns(subagentRuns, controllerSessionKey, toolCallId, Date.now());
\tif (changed) persistSubagentRunsOrThrow();
\treturn changed;
}
function commitJustDoManagedJoinContinuation(controllerSessionKey) {
\tconst { changed, deleteRunIds } = commitJustDoManagedJoinContinuationInRuns(subagentRuns, controllerSessionKey, Date.now());
\tif (!changed) return false;
\tpersistSubagentRunsOrThrow();
\tfor (const runId of deleteRunIds) {
\t\tconst entry = subagentRuns.get(runId);
\t\tif (!entry) continue;
\t\tresumedRuns.delete(runId);
\t\tstartSubagentAnnounceCleanupFlow(runId, entry);
\t}
\treturn true;
}
`;

function transformRegistry(content, filePath) {
  if (
    content.includes(
      'function markJustDoManagedJoinToolResultPersisted(controllerSessionKey, toolCallId)',
    )
  )
    return content;
  let updated = replaceUnique(
    content,
    'const resumedRuns = /* @__PURE__ */ new Set();',
    `${REGISTRY_HELPERS}const resumedRuns = /* @__PURE__ */ new Set();`,
    `${filePath}: managed join commit transitions`,
  );
  updated = replaceUniquePattern(
    updated,
    /export \{ ([^\n]+) \};/,
    (_match, exports) =>
      `export { markJustDoManagedJoinToolResultPersisted as B, commitJustDoManagedJoinContinuation as C, ${exports} };`,
    `${filePath}: managed join commit exports`,
  );
  return updated;
}

const BRIDGE = `function installJustDoManagedJoinCommitBridge() {
\tglobalThis[JUSTDO_MANAGED_JOIN_GLOBAL] = {
\t\tmarkToolResult(sessionKey, toolCallId) {
\t\t\ttry { return markJustDoManagedJoinToolResultPersisted(sessionKey, toolCallId); } catch { return false; }
\t\t},
\t\tcommitContinuation(sessionKey) {
\t\t\ttry { return commitJustDoManagedJoinContinuation(sessionKey); } catch { return false; }
\t\t}
\t};
}
installJustDoManagedJoinCommitBridge();
`;

function transformTools(content, filePath) {
  if (content.includes('function installJustDoManagedJoinCommitBridge()')) return content;
  if (!content.includes('function waitForJustDoManagedSubagents('))
    throw new Error(`${filePath}: same-run join prerequisite is missing`);
  let updated = replaceUnique(
    content,
    REGISTRY_IMPORT,
    REGISTRY_IMPORT_PATCHED,
    `${filePath}: managed join commit imports`,
  );
  updated = replaceUnique(
    updated,
    'function isJustDoManagedJoinPending(entry) {',
    `${BRIDGE}function isJustDoManagedJoinPending(entry) {`,
    `${filePath}: managed join commit bridge`,
  );
  return updated;
}

function hasManagedJoinPersistenceContracts(content) {
  const markStart = content.indexOf(
    'function markJustDoManagedJoinToolResultPersisted(controllerSessionKey, toolCallId)',
  );
  const commitStart = content.indexOf(
    'function commitJustDoManagedJoinContinuation(controllerSessionKey)',
  );
  if (markStart < 0 || commitStart <= markStart) return false;
  const commitBodyStart = commitStart + 1;
  const nextFunctionOffset = content.slice(commitBodyStart).search(/\n(?:async\s+)?function\s/);
  const nextFunctionStart =
    nextFunctionOffset < 0 ? content.length : commitBodyStart + nextFunctionOffset;
  const markBlock = content.slice(markStart, commitStart);
  const commitBlock = content.slice(
    commitStart,
    nextFunctionStart < 0 ? content.length : nextFunctionStart,
  );
  const direct =
    markBlock.includes('if (changed) persistSubagentRunsOrThrow();') &&
    commitBlock.includes('persistSubagentRunsOrThrow();');
  const atomic =
    markBlock.includes('mutateJustDoSubagentRegistryAtomically(') &&
    markBlock.includes('markJustDoManagedJoinToolResultInRuns(') &&
    markBlock.includes('persistSubagentRunsOrThrow).changed;') &&
    commitBlock.includes('mutateJustDoSubagentRegistryAtomically(') &&
    commitBlock.includes('commitJustDoManagedJoinContinuationInRuns(') &&
    commitBlock.includes('persistSubagentRunsOrThrow);');
  return direct || atomic;
}

const TRANSCRIPT_BRIDGE = `const JUSTDO_MANAGED_JOIN_TRANSCRIPT_GLOBAL = Symbol.for("justdo.openclaw.managed-subagent-join.v2026.7.1-2");
function notifyJustDoManagedJoinToolResultCommitted(sessionKey, toolCallId) {
\tif (toolCallId) globalThis[JUSTDO_MANAGED_JOIN_TRANSCRIPT_GLOBAL]?.markToolResult?.(sessionKey, toolCallId);
}
function notifyJustDoManagedJoinContinuationCommitted(sessionKey) {
\tglobalThis[JUSTDO_MANAGED_JOIN_TRANSCRIPT_GLOBAL]?.commitContinuation?.(sessionKey);
}
`;

function transformTranscript(content, filePath) {
  if (
    content.includes('function notifyJustDoManagedJoinToolResultCommitted(sessionKey, toolCallId)')
  )
    return content;
  let updated = replaceUnique(
    content,
    'function capToolResultForPersistence(msg, maxChars, redactionConfig) {',
    `${TRANSCRIPT_BRIDGE}function capToolResultForPersistence(msg, maxChars, redactionConfig) {`,
    `${filePath}: managed join transcript commit bridge`,
  );
  updated = replaceUnique(
    updated,
    '\t\t\treturn appendMessageAndCacheTranscriptSeq(capToolResultForPersistence(persisted.message, maxToolResultChars, redactionConfig), { invalidateSerializedPrefixCache: callerInvalidatesCache || persistedToolResult !== normalizedToolResult || toolResultTransformerMayMutate || persisted.changed }).entryId;',
    '\t\t\tconst appendedToolResult = appendMessageAndCacheTranscriptSeq(capToolResultForPersistence(persisted.message, maxToolResultChars, redactionConfig), { invalidateSerializedPrefixCache: callerInvalidatesCache || persistedToolResult !== normalizedToolResult || toolResultTransformerMayMutate || persisted.changed });\n\t\t\tnotifyJustDoManagedJoinToolResultCommitted(opts?.sessionKey, id);\n\t\t\treturn appendedToolResult.entryId;',
    `${filePath}: managed join tool-result commit`,
  );
  updated = replaceUnique(
    updated,
    '\t\tconst { entryId: result, messageSeq, sessionFile } = appendMessageAndCacheTranscriptSeq(finalMessage, { invalidateSerializedPrefixCache: callerInvalidatesCache || transformedMessage !== nextMessage || finalWrite.changed });',
    '\t\tconst { entryId: result, messageSeq, sessionFile } = appendMessageAndCacheTranscriptSeq(finalMessage, { invalidateSerializedPrefixCache: callerInvalidatesCache || transformedMessage !== nextMessage || finalWrite.changed });\n\t\tif (finalRole === "assistant" && finalMessage.stopReason === "stop" && toolCalls.length === 0) notifyJustDoManagedJoinContinuationCommitted(opts?.sessionKey);',
    `${filePath}: managed join continuation commit`,
  );
  return updated;
}

const CODEX_BRIDGE = `const JUSTDO_MANAGED_JOIN_CODEX_GLOBAL = Symbol.for("justdo.openclaw.managed-subagent-join.v2026.7.1-2");
function commitJustDoManagedJoinCodexMirror(params, messages) {
\tconst bridge = globalThis[JUSTDO_MANAGED_JOIN_CODEX_GLOBAL];
\tif (!bridge) return;
\tfor (const message of messages) if (message.role === "toolResult") bridge.markToolResult?.(params.sessionKey, message.toolCallId);
\tconst finalAssistant = [...messages].reverse().find((message) => message.role === "assistant");
\tif (finalAssistant?.stopReason === "stop") bridge.commitContinuation?.(params.sessionKey);
}
`;

function transformCodex(content, filePath) {
  if (content.includes('function commitJustDoManagedJoinCodexMirror(params, messages)'))
    return content;
  let updated = replaceUnique(
    content,
    'async function mirrorCodexAppServerTranscript(params) {',
    `${CODEX_BRIDGE}async function mirrorCodexAppServerTranscript(params) {`,
    `${filePath}: managed join Codex commit bridge`,
  );
  updated = replaceUnique(
    updated,
    '\tfor (const update of appendedUpdates) try {',
    '\tcommitJustDoManagedJoinCodexMirror(params, messages);\n\tfor (const update of appendedUpdates) try {',
    `${filePath}: managed join Codex commits`,
  );
  return updated;
}

function locateTargets(runtimeDir) {
  const unique = files => [...new Set(files)];
  const tools = findFilesContaining(runtimeDir, [
    'function createSessionsYieldTool(opts)',
    'function waitForJustDoManagedSubagents(',
  ]);
  const registry = unique([
    ...findFilesContaining(runtimeDir, [
      'function restoreSubagentRunsOnce()',
      'const resumedRuns = /* @__PURE__ */ new Set();',
    ]),
    ...findFilesContaining(runtimeDir, [
      'function restoreSubagentRunsOnce()',
      'function markJustDoManagedJoinToolResultPersisted(',
    ]),
  ]);
  const transcript = unique([
    ...findFilesContaining(runtimeDir, [
      'function capToolResultForPersistence(msg, maxChars, redactionConfig)',
      'const guardedAppend = (message, callerOptions) =>',
    ]),
    ...findFilesContaining(runtimeDir, [
      'function capToolResultForPersistence(',
      'function notifyJustDoManagedJoinToolResultCommitted(',
    ]),
  ]);
  const codex = unique([
    ...findFilesContaining(runtimeDir, [
      'async function mirrorCodexAppServerTranscript(params)',
      'function buildMirrorDedupeIdentity(message)',
    ]),
    ...findFilesContaining(runtimeDir, [
      'function mirrorCodexAppServerTranscript(',
      'function commitJustDoManagedJoinCodexMirror(',
    ]),
  ]).filter(
    filePath =>
      !fs
        .readFileSync(filePath, 'utf8')
        .includes('function patchJustDoOfficialCodexPlugin(params)'),
  );
  const hasBundle = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs'));
  const bundledExpected = hasBundle ? 2 : 1;
  const companionExpected = 1;
  if (
    tools.length !== bundledExpected ||
    registry.length !== bundledExpected ||
    transcript.length !== bundledExpected ||
    codex.length !== companionExpected
  )
    throw new Error(
      `managed join commit target counts are tools=${tools.length}, registry=${registry.length}, transcript=${transcript.length}, codex=${codex.length}; expected bundled=${bundledExpected}, companion=${companionExpected}`,
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
        'function markJustDoManagedJoinToolResultPersisted(controllerSessionKey, toolCallId)',
        'function markJustDoManagedJoinToolResultInRuns(',
        'tool_result_committed',
        'consumed',
        'startSubagentAnnounceCleanupFlow(runId, entry);',
      ],
    ],
    [
      'tools',
      targets.tools,
      [
        'function installJustDoManagedJoinCommitBridge()',
        'markJustDoManagedJoinToolResultPersisted(sessionKey, toolCallId)',
        'commitJustDoManagedJoinContinuation(sessionKey)',
      ],
    ],
    [
      'transcript',
      targets.transcript,
      [
        'function notifyJustDoManagedJoinToolResultCommitted(sessionKey, toolCallId)',
        'notifyJustDoManagedJoinContinuationCommitted(opts?.sessionKey)',
      ],
    ],
    [
      'codex',
      targets.codex,
      [
        'function commitJustDoManagedJoinCodexMirror(params, messages)',
        'bridge.markToolResult?.(params.sessionKey, message.toolCallId)',
      ],
    ],
  ])
    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf8');
      for (const contract of contracts)
        if (!content.includes(contract))
          throw new Error(
            `managed join commit ${name} contract is missing from ${filePath}: ${contract}`,
          );
      if (name === 'registry') {
        if (!hasManagedJoinPersistenceContracts(content))
          throw new Error(
            `managed join commit registry persistence contract is missing from ${filePath}`,
          );
      }
    }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: {
    markJustDoManagedJoinToolResultInRuns,
    commitJustDoManagedJoinContinuationInRuns,
    hasManagedJoinPersistenceContracts,
  },
};
