'use strict';

// Purpose: Keep JustDo-managed parent runs alive while their subagents execute,
// return child results through the original sessions_yield tool call, and keep
// the parent Gateway session id stable across normal continuation requests.
// Affected OpenClaw version: v2026.6.11.
// Risk: Changes sessions_spawn/sessions_yield semantics only for sessions whose
// ancestry is rooted at an agent:*:justdo:* session. Other channels and cron
// sessions retain OpenClaw's push-based announce behavior.
// Remove when: OpenClaw supports same-run subagent joins and immutable logical
// session identities natively.
// Temporary: yes.

const fs = require('fs');
const path = require('path');

const JOIN_MARKER = 'JUSTDO_MANAGED_SUBAGENT_JOIN_V1';
const INCREMENTAL_JOIN_MARKER = 'JUSTDO_MANAGED_SUBAGENT_INCREMENTAL_JOIN_V1';
const RELIABLE_JOIN_MARKER = 'JUSTDO_MANAGED_SUBAGENT_RELIABLE_JOIN_V1';
const TOOL_RESULT_COMMIT_MARKER = 'JUSTDO_MANAGED_JOIN_TOOL_RESULT_COMMIT_V1';
const CONTINUATION_COMMIT_MARKER = 'JUSTDO_MANAGED_JOIN_CONTINUATION_COMMIT_V1';
const DELETE_RETENTION_MARKER = 'JUSTDO_MANAGED_SUBAGENT_DELETE_RETENTION_V1';
const SESSION_MARKER = 'JUSTDO_MANAGED_SESSION_ID_STABILITY_V1';
const RECOVERY_MARKER = 'JUSTDO_MANAGED_SUBAGENT_RECOVERY_V1';
const RECOVERY_RELIABLE_MARKER = 'JUSTDO_MANAGED_SUBAGENT_RECOVERY_V2';
const ANNOUNCE_SUPPRESSION_MARKER = 'JUSTDO_MANAGED_JOIN_ANNOUNCE_SUPPRESSION_V1';

function replaceOnce(content, from, to) {
  if (content.includes(to)) return { content, changed: false };
  if (!content.includes(from)) return { content, changed: false };
  return { content: content.replace(from, to), changed: true };
}

const JOIN_HELPERS = `// ${JOIN_MARKER}
// ${INCREMENTAL_JOIN_MARKER}
// ${RELIABLE_JOIN_MARKER}
// ${CONTINUATION_COMMIT_MARKER}
const justDoManagedSubagentJoinTails = /* @__PURE__ */ new Map();
async function withJustDoManagedSubagentJoinLock(key, task) {
  const normalized = typeof key === "string" ? key.trim() : "";
  const previous = justDoManagedSubagentJoinTails.get(normalized) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => gate);
  justDoManagedSubagentJoinTails.set(normalized, tail);
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release?.();
    if (justDoManagedSubagentJoinTails.get(normalized) === tail) justDoManagedSubagentJoinTails.delete(normalized);
  }
}
function isJustDoManagedSubagentController(sessionKey) {
  let current = typeof sessionKey === "string" ? sessionKey.trim() : "";
  const visited = /* @__PURE__ */ new Set();
  for (let depth = 0; current && depth < 32 && !visited.has(current); depth += 1) {
    if (/^agent:[^:]+:justdo:[^:]+$/i.test(current)) return true;
    visited.add(current);
    let entry;
    if (typeof getSubagentRunByChildSessionKey2 === "function") entry = getSubagentRunByChildSessionKey2(current);
    else if (typeof getSubagentRunByChildSessionKey === "function") entry = getSubagentRunByChildSessionKey(current);
    current = entry?.controllerSessionKey?.trim() || entry?.requesterSessionKey?.trim() || "";
  }
  return false;
}
function buildJustDoSubagentJoinResult(entry) {
  const outcome = entry?.outcome && typeof entry.outcome === "object" ? entry.outcome : {};
  const status = typeof outcome.status === "string" ? outcome.status : typeof entry?.endedAt === "number" ? "ok" : "running";
  return {
    runId: typeof entry?.runId === "string" ? entry.runId : "",
    sessionKey: typeof entry?.childSessionKey === "string" ? entry.childSessionKey : "",
    status,
    result: typeof entry?.completion?.resultText === "string" ? entry.completion.resultText : null,
    ...typeof outcome.error === "string" && outcome.error ? { error: outcome.error } : {},
    ...typeof entry?.startedAt === "number" ? { startedAt: entry.startedAt } : {},
    ...typeof entry?.endedAt === "number" ? { endedAt: entry.endedAt } : {}
  };
}
function persistJustDoManagedSubagentJoinOrThrow() {
  if (typeof persistSubagentRunsOrThrow !== "function") throw new Error("Durable subagent registry persistence is unavailable.");
  persistSubagentRunsOrThrow();
}
function markJustDoManagedSubagentJoinToolResultPersisted(controllerSessionKey, toolCallId) {
  const controller = typeof controllerSessionKey === "string" ? controllerSessionKey.trim() : "";
  const callId = typeof toolCallId === "string" ? toolCallId.trim() : "";
  if (!controller || !callId || typeof subagentRuns?.values !== "function") return;
  const transcriptCommittedAt = Date.now();
  let changed = false;
  for (const entry of subagentRuns.values()) {
    if ((entry?.controllerSessionKey?.trim() || entry?.requesterSessionKey?.trim()) !== controller) continue;
    if (entry?.justDoJoinToolCallId !== callId || typeof entry?.justDoJoinPresentedAt !== "number") continue;
    entry.justDoJoinTranscriptCommittedAt = transcriptCommittedAt;
    changed = true;
  }
  if (!changed) return;
  try {
    persistJustDoManagedSubagentJoinOrThrow();
  } catch {
    // The presented claim is already durable. A failed metadata update leaves
    // recovery on the safe at-least-once path.
  }
}
function restoreJustDoManagedSubagentCleanup(entry) {
  const originalCleanup = entry?.justDoJoinOriginalCleanup;
  if (originalCleanup !== "keep" && originalCleanup !== "delete") return;
  entry.cleanup = originalCleanup;
  entry.justDoJoinOriginalCleanup = void 0;
}
function commitJustDoManagedSubagentJoinContinuation(controllerSessionKey) {
  const controller = typeof controllerSessionKey === "string" ? controllerSessionKey.trim() : "";
  if (!controller || typeof subagentRuns?.values !== "function") return;
  const consumedAt = Date.now();
  let changed = false;
  for (const entry of Array.from(subagentRuns.values())) {
    if ((entry?.controllerSessionKey?.trim() || entry?.requesterSessionKey?.trim()) !== controller) continue;
    if (typeof entry?.justDoJoinTranscriptCommittedAt !== "number" || typeof entry?.justDoJoinConsumedAt === "number") continue;
    entry.justDoJoinConsumedAt = consumedAt;
    restoreJustDoManagedSubagentCleanup(entry);
    if (entry.cleanup === "delete" && typeof entry.endedAt === "number" && typeof completeCleanupBookkeeping === "function") {
      completeCleanupBookkeeping({
        runId: entry.runId,
        entry,
        cleanup: "delete",
        completedAt: consumedAt
      });
      continue;
    }
    changed = true;
  }
  if (!changed) return;
  try {
    persistJustDoManagedSubagentJoinOrThrow();
  } catch {
  }
}
function enableJustDoManagedCompletionFallback(entries) {
  for (const entry of entries) {
    if (!entry || typeof entry.justDoJoinConsumedAt === "number") continue;
    entry.expectsCompletionMessage = true;
    if (entry.completion && typeof entry.completion === "object") entry.completion.required = true;
    entry.delivery = { status: "pending" };
    entry.cleanupCompletedAt = void 0;
    entry.cleanupHandled = false;
    entry.suppressAnnounceReason = void 0;
    restoreJustDoManagedSubagentCleanup(entry);
    entry.justDoJoinStartedAt = void 0;
    entry.justDoJoinPresentedAt = void 0;
    entry.justDoJoinToolCallId = void 0;
  }
  try {
    persistJustDoManagedSubagentJoinOrThrow();
  } catch {
  }
  for (const entry of entries) {
    if (typeof entry?.endedAt !== "number" || typeof entry?.runId !== "string") continue;
    if (typeof resumedRuns !== "undefined" && typeof resumedRuns?.delete === "function") resumedRuns.delete(entry.runId);
    if (typeof resumeSubagentRun === "function") resumeSubagentRun(entry.runId);
  }
}
async function waitForJustDoManagedSubagents(opts, message, toolCallId) {
  const initialRuns = listControlledSubagentRuns(opts.agentSessionKey).filter((entry) =>
    typeof entry?.runId === "string" && entry.runId &&
    typeof entry?.justDoJoinConsumedAt !== "number" && typeof entry?.justDoJoinPresentedAt !== "number"
  );
  if (initialRuns.length === 0) return jsonResult({
    status: "no_active_subagents",
    message: "No controlled subagents remain; continue without yielding.",
    results: []
  });
  const joinStartedAt = Date.now();
  for (const entry of initialRuns) {
    if (entry.cleanup === "delete" && entry.justDoJoinOriginalCleanup !== "delete") {
      entry.justDoJoinOriginalCleanup = "delete";
      entry.cleanup = "keep";
      entry.archiveAtMs = void 0;
      entry.cleanupCompletedAt = void 0;
      entry.cleanupHandled = false;
    }
    entry.expectsCompletionMessage = false;
    entry.justDoJoinStartedAt = joinStartedAt;
    entry.delivery = { status: "not_required" };
  }
  try {
    persistJustDoManagedSubagentJoinOrThrow();
  } catch (error) {
    enableJustDoManagedCompletionFallback(initialRuns);
    return jsonResult({
      status: "error",
      error: \`Unable to durably start subagent join: \${error instanceof Error ? error.message : String(error)}\`
    });
  }
  const expectedRunIds = new Set(initialRuns.map((entry) => entry?.runId).filter((runId) => typeof runId === "string" && runId));
  for (;;) {
    if (opts.abortSignal?.aborted) {
      enableJustDoManagedCompletionFallback(initialRuns);
      return jsonResult({
        status: "aborted",
        message: "Subagent join was stopped; completion delivery was restored.",
        results: []
      });
    }
    const currentRuns = listControlledSubagentRuns(opts.agentSessionKey).filter((entry) => expectedRunIds.has(entry?.runId));
    const byRunId = new Map(currentRuns.map((entry) => [entry.runId, entry]));
    const settled = initialRuns.map((initial) => byRunId.get(initial.runId) ?? initial);
    const completed = settled.filter((entry) =>
      typeof entry?.endedAt === "number" && typeof entry?.completion?.capturedAt === "number"
    );
    if (completed.length > 0) {
      const presentedAt = Date.now();
      for (const entry of completed) {
        entry.justDoJoinPresentedAt = presentedAt;
        entry.justDoJoinToolCallId = toolCallId;
      }
      try {
        persistJustDoManagedSubagentJoinOrThrow();
      } catch (error) {
        enableJustDoManagedCompletionFallback(settled);
        return jsonResult({
          status: "error",
          error: \`Unable to durably record subagent results: \${error instanceof Error ? error.message : String(error)}\`
        });
      }
      const pending = settled.length - completed.length;
      return jsonResult({
        status: pending > 0 ? "partial" : "completed",
        message,
        pending,
        results: completed.map(buildJustDoSubagentJoinResult)
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}`;

function patchManagedJoin(content) {
  let changed = false;
  if (
    content.includes(JOIN_MARKER) &&
    !content.includes(`// ${RELIABLE_JOIN_MARKER}\n// ${CONTINUATION_COMMIT_MARKER}`)
  ) {
    const helperStart = content.indexOf(`// ${JOIN_MARKER}`);
    const toolStart = content.indexOf('function createSessionsYieldTool(opts) {', helperStart);
    if (helperStart < 0 || toolStart < 0) return { content, changed: false };
    content = `${content.slice(0, helperStart)}${JOIN_HELPERS}\n${content.slice(toolStart)}`;
    changed = true;
  } else if (!content.includes(JOIN_MARKER)) {
    const anchor = 'function createSessionsYieldTool(opts) {';
    if (!content.includes(anchor)) return { content, changed: false };
    content = content.replace(anchor, `${JOIN_HELPERS}\n${anchor}`);
    changed = true;
  }

  let result = replaceOnce(
    content,
    'description: "End current turn. Use after spawning subagents; results arrive as next message.",',
    'description: "Wait for controlled subagents. JustDo-managed sessions return incrementally in this same run; other sessions yield and receive completion events.",',
  );
  content = result.content;
  changed ||= result.changed;
  result = replaceOnce(
    content,
    'description: "Wait for controlled subagents. JustDo-managed sessions continue in this same run; other sessions yield and receive completion events.",',
    'description: "Wait for controlled subagents. JustDo-managed sessions return incrementally in this same run; other sessions yield and receive completion events.",',
  );
  content = result.content;
  changed ||= result.changed;

  const yieldAnchor = `      if (!opts?.onYield) return jsonResult({
        status: "error",
        error: "Yield not supported in this context"
      });`;
  const yieldPatched = `      if (isJustDoManagedSubagentController(opts?.agentSessionKey)) {
        return await withJustDoManagedSubagentJoinLock(opts.agentSessionKey, () => waitForJustDoManagedSubagents(opts, message2, _toolCallId));
      }
${yieldAnchor}`;
  result = replaceOnce(content, yieldAnchor, yieldPatched);
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    '        return await waitForJustDoManagedSubagents(opts, message2);',
    '        return await withJustDoManagedSubagentJoinLock(opts.agentSessionKey, () => waitForJustDoManagedSubagents(opts, message2, _toolCallId));',
  );
  content = result.content;
  changed ||= result.changed;

  const constructionAnchor = `      runId: options2?.runId,
      onYield: options2?.onYield`;
  const constructionPatched = `      runId: options2?.runId,
      abortSignal: options2?.abortSignal,
      onYield: options2?.onYield`;
  result = replaceOnce(content, constructionAnchor, constructionPatched);
  content = result.content;
  changed ||= result.changed;

  const acceptedNote = `function resolveSubagentSpawnAcceptedNote(params) {
  if (params.spawnMode === "session") return SUBAGENT_SPAWN_SESSION_ACCEPTED_NOTE;
  return isCronSessionKey(params.agentSessionKey) ? void 0 : SUBAGENT_SPAWN_ACCEPTED_NOTE;
}`;
  const acceptedNotePatched = `function resolveSubagentSpawnAcceptedNote(params) {
  if (params.spawnMode === "session") return SUBAGENT_SPAWN_SESSION_ACCEPTED_NOTE;
  if (isJustDoManagedSubagentController(params.agentSessionKey)) return "Keep the pipeline full: spawn up to the active-child limit, then call sessions_yield. It returns when one or more children finish. Consume those results, immediately spawn replacements while work remains, and call sessions_yield again while children are pending. Do not poll or finish before all work is collected.";
  return isCronSessionKey(params.agentSessionKey) ? void 0 : SUBAGENT_SPAWN_ACCEPTED_NOTE;
}`;
  result = replaceOnce(content, acceptedNote, acceptedNotePatched);
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    '  if (isJustDoManagedSubagentController(params.agentSessionKey)) return "After spawning all required subagents, call sessions_yield exactly once. The runtime will join them and return their results in this same run; do not poll or finish early.";',
    '  if (isJustDoManagedSubagentController(params.agentSessionKey)) return "Keep the pipeline full: spawn up to the active-child limit, then call sessions_yield. It returns when one or more children finish. Consume those results, immediately spawn replacements while work remains, and call sessions_yield again while children are pending. Do not poll or finish before all work is collected.";',
  );
  content = result.content;
  changed ||= result.changed;

  return { content, changed };
}

function patchManagedSessionStability(content) {
  let changed = false;
  const resolveSessionAnchor = `  const terminalMainTranscriptNewerThanRegistry = sessionEntry && !requestedSessionId ? hasTerminalMainSessionTranscriptNewerThanRegistrySync({`;
  const resolveSessionPatched = `  const justDoManagedSession = /^agent:[^:]+:justdo:[^:]+$/i.test(sessionKey ?? ""); // ${SESSION_MARKER}
  const terminalMainTranscriptNewerThanRegistry = sessionEntry && !requestedSessionId && !justDoManagedSession ? hasTerminalMainSessionTranscriptNewerThanRegistrySync({`;
  let result = replaceOnce(content, resolveSessionAnchor, resolveSessionPatched);
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    '  const sessionId = requestedSessionId || (fresh ? sessionEntry?.sessionId : void 0) || crypto31.randomUUID();\n  const isNewSession = !fresh && !requestedSessionId;\n  const resolvedSessionEntry = terminalMainTranscriptNewerThanRegistry ? clearRotatedTerminalMainSessionMetadata(sessionEntry) : sessionEntry;',
    '  const sessionId = (justDoManagedSession ? sessionEntry?.sessionId : void 0) || requestedSessionId || (fresh ? sessionEntry?.sessionId : void 0) || crypto31.randomUUID();\n  const isNewSession = justDoManagedSession ? !sessionEntry?.sessionId : !fresh && !requestedSessionId;\n  const resolvedSessionEntry = terminalMainTranscriptNewerThanRegistry && !justDoManagedSession ? clearRotatedTerminalMainSessionMetadata(sessionEntry) : sessionEntry;',
  );
  content = result.content;
  changed ||= result.changed;

  const agentReuseAnchor =
    '            const canReuseSession = Boolean(entry?.sessionId) && (freshness?.fresh ?? false) && !failedSessionTranscriptMissing && !terminalMainTranscriptNewerThanRegistry;';
  const agentReusePatched = `            const justDoManagedSession = /^agent:[^:]+:justdo:[^:]+$/i.test(canonicalKey); // ${SESSION_MARKER}
            const canReuseSession = Boolean(entry?.sessionId) && (justDoManagedSession || (freshness?.fresh ?? false) && !failedSessionTranscriptMissing && !terminalMainTranscriptNewerThanRegistry);`;
  result = replaceOnce(content, agentReuseAnchor, agentReusePatched);
  content = result.content;
  changed ||= result.changed;

  const agentIdentityAnchor = `            let usableRequestedSessionId = requestedSessionId && (!entry?.sessionId || canReuseSession) ? requestedSessionId : void 0;
            const sessionId = usableRequestedSessionId ? usableRequestedSessionId : (canReuseSession ? entry?.sessionId : void 0) ?? randomUUID49();`;
  const agentIdentityPatched = `            let usableRequestedSessionId = justDoManagedSession
              ? requestedSessionId && (!entry?.sessionId || entry.sessionId.trim() === requestedSessionId) ? requestedSessionId : void 0
              : requestedSessionId && (!entry?.sessionId || canReuseSession) ? requestedSessionId : void 0;
            const sessionId = justDoManagedSession && entry?.sessionId ? entry.sessionId : usableRequestedSessionId ? usableRequestedSessionId : (canReuseSession ? entry?.sessionId : void 0) ?? randomUUID49();`;
  result = replaceOnce(content, agentIdentityAnchor, agentIdentityPatched);
  content = result.content;
  changed ||= result.changed;
  return { content, changed };
}

function patchManagedJoinRecovery(content) {
  let changed = false;
  const restoreAnchor = 'function restoreSubagentRunsOnce() {';
  const recoveryHelpers = `// ${RECOVERY_MARKER}
// ${RECOVERY_RELIABLE_MARKER}
function isJustDoManagedRestoredSubagent(entry, runs) {
  let current = entry?.controllerSessionKey?.trim() || entry?.requesterSessionKey?.trim() || "";
  const visited = /* @__PURE__ */ new Set();
  for (let depth = 0; current && depth < 32 && !visited.has(current); depth += 1) {
    if (/^agent:[^:]+:justdo:[^:]+$/i.test(current)) return true;
    visited.add(current);
    let parent;
    for (const candidate of runs.values()) {
      if (candidate?.childSessionKey === current) {
        parent = candidate;
        break;
      }
    }
    current = parent?.controllerSessionKey?.trim() || parent?.requesterSessionKey?.trim() || "";
  }
  return false;
}

function promoteUnconsumedJustDoJoinsForRecovery(runs) {
  let changed = false;
  for (const entry of runs.values()) {
    if (entry?.expectsCompletionMessage !== false || typeof entry?.justDoJoinConsumedAt === "number") continue;
    if (typeof entry?.justDoJoinStartedAt !== "number") continue;
    if (!isJustDoManagedRestoredSubagent(entry, runs)) continue;
    restoreJustDoManagedSubagentCleanup(entry);
    entry.expectsCompletionMessage = true;
    if (entry.completion && typeof entry.completion === "object") entry.completion.required = true;
    entry.delivery = { status: "pending" };
    entry.cleanupCompletedAt = void 0;
    entry.cleanupHandled = false;
    entry.suppressAnnounceReason = void 0;
    changed = true;
  }
  return changed;
}`;
  if (content.includes(RECOVERY_MARKER) && !content.includes(RECOVERY_RELIABLE_MARKER)) {
    const helperStart = content.indexOf(`// ${RECOVERY_MARKER}`);
    const restoreStart = content.indexOf(restoreAnchor, helperStart);
    if (helperStart < 0 || restoreStart < 0) return { content, changed: false };
    content = `${content.slice(0, helperStart)}${recoveryHelpers}\n${content.slice(restoreStart)}`;
    changed = true;
  } else if (!content.includes(RECOVERY_MARKER)) {
    if (!content.includes(restoreAnchor)) return { content, changed: false };
    content = content.replace(restoreAnchor, `${recoveryHelpers}\n${restoreAnchor}`);
    changed = true;
  }

  const restoreBodyAnchor = `    if (subagentRegistryDeps.restoreSubagentRunsFromDisk({
      runs: subagentRuns,
      mergeOnly: true
    }) === 0) return;
    if (reconcileOrphanedRestoredRuns({
      runs: subagentRuns,
      resumedRuns
    })) persistSubagentRuns();`;
  const restoreBodyPatched = `    const restoredRunCount = subagentRegistryDeps.restoreSubagentRunsFromDisk({
      runs: subagentRuns,
      mergeOnly: true
    });
    if (restoredRunCount === 0) return;
    const promotedJustDoJoins = promoteUnconsumedJustDoJoinsForRecovery(subagentRuns);
    if (reconcileOrphanedRestoredRuns({
      runs: subagentRuns,
      resumedRuns
    }) || promotedJustDoJoins) persistSubagentRuns();`;
  const result = replaceOnce(content, restoreBodyAnchor, restoreBodyPatched);
  content = result.content;
  changed ||= result.changed;
  return { content, changed };
}

function patchManagedJoinAnnounceSuppression(content) {
  const anchor =
    '    const directAgentThreadId = shouldDeliverAgentFinal ? stringifyRouteThreadId(deliveryTarget.threadId) : sessionOnlyOriginChannel ? stringifyRouteThreadId(sessionOnlyOrigin?.threadId) : void 0;';
  const patched = `    // ${ANNOUNCE_SUPPRESSION_MARKER}
    const justDoJoinedRun = typeof getSubagentRunByChildSessionKey2 === "function" ? getSubagentRunByChildSessionKey2(params.sourceSessionKey) : void 0;
    if (justDoJoinedRun?.expectsCompletionMessage === false && typeof justDoJoinedRun?.justDoJoinStartedAt === "number") return {
      delivered: true,
      deliveredAt: Date.now(),
      path: "none"
    };
${anchor}`;
  return replaceOnce(content, anchor, patched);
}

function patchManagedJoinToolResultCommit(content) {
  const anchor =
    '      return appendMessageAndCacheTranscriptSeq(capToolResultForPersistence(persisted.message, maxToolResultChars, redactionConfig), { invalidateSerializedPrefixCache: callerInvalidatesCache || persistedToolResult !== normalizedToolResult || toolResultTransformerMayMutate || persisted.changed }).entryId;';
  const patched = `      const appendedToolResult = appendMessageAndCacheTranscriptSeq(capToolResultForPersistence(persisted.message, maxToolResultChars, redactionConfig), { invalidateSerializedPrefixCache: callerInvalidatesCache || persistedToolResult !== normalizedToolResult || toolResultTransformerMayMutate || persisted.changed });
      // ${TOOL_RESULT_COMMIT_MARKER}
      if (id) markJustDoManagedSubagentJoinToolResultPersisted(opts?.sessionKey, id);
      return appendedToolResult.entryId;`;
  let result = replaceOnce(content, anchor, patched);
  if (!result.changed && !result.content.includes(TOOL_RESULT_COMMIT_MARKER))
    result = replaceOnce(content, anchor.trimStart(), patched.trimStart());
  const migrated = replaceOnce(
    result.content,
    'if (id) commitJustDoManagedSubagentJoinToolResult(opts?.sessionKey, id);',
    'if (id) markJustDoManagedSubagentJoinToolResultPersisted(opts?.sessionKey, id);',
  );
  const batchMigrated = replaceOnce(
    migrated.content,
    `      // ${TOOL_RESULT_COMMIT_MARKER}
      // JUSTDO_MANAGED_JOIN_TOOL_BATCH_COMMIT_V1
      if (pendingState.size() === 0) commitJustDoManagedSubagentJoinContinuation(opts?.sessionKey);
      if (id) markJustDoManagedSubagentJoinToolResultPersisted(opts?.sessionKey, id);`,
    `      // ${TOOL_RESULT_COMMIT_MARKER}
      if (id) markJustDoManagedSubagentJoinToolResultPersisted(opts?.sessionKey, id);`,
  );
  return {
    content: batchMigrated.content,
    changed: result.changed || migrated.changed || batchMigrated.changed,
  };
}

function patchManagedJoinContinuationCommit(content) {
  const oldHook = `    // ${CONTINUATION_COMMIT_MARKER}
    if (finalRole === "assistant") commitJustDoManagedSubagentJoinContinuation(opts?.sessionKey);`;
  const toolFreeHook = `    // ${CONTINUATION_COMMIT_MARKER}
    if (finalRole === "assistant" && toolCalls.length === 0) commitJustDoManagedSubagentJoinContinuation(opts?.sessionKey);`;
  const successfulHook = `    // ${CONTINUATION_COMMIT_MARKER}
    if (finalRole === "assistant" && finalMessage.stopReason === "stop" && toolCalls.length === 0) commitJustDoManagedSubagentJoinContinuation(opts?.sessionKey);`;
  const migratedOld = replaceOnce(content, oldHook, successfulHook);
  const migratedToolFree = replaceOnce(migratedOld.content, toolFreeHook, successfulHook);
  const migrated = {
    content: migratedToolFree.content,
    changed: migratedOld.changed || migratedToolFree.changed,
  };
  if (migrated.changed || migrated.content.includes(successfulHook)) return migrated;
  const anchor =
    '    const { entryId: result, messageSeq, sessionFile } = appendMessageAndCacheTranscriptSeq(finalMessage, { invalidateSerializedPrefixCache: callerInvalidatesCache || transformedMessage !== nextMessage || finalWrite.changed });';
  const patched = `${anchor}
${successfulHook}`;
  let result = replaceOnce(content, anchor, patched);
  if (result.changed) return result;
  return replaceOnce(content, anchor.trimStart(), patched.trimStart());
}

function patchManagedDeleteRetention(content) {
  let changed = false;
  let result = replaceOnce(
    content,
    `      cleanup: registerParams.cleanup,
      expectsCompletionMessage: registerParams.expectsCompletionMessage,`,
    `      cleanup: registerParams.cleanup, // ${DELETE_RETENTION_MARKER}
      justDoJoinOriginalCleanup: registerParams.justDoJoinOriginalCleanup,
      expectsCompletionMessage: registerParams.expectsCompletionMessage,`,
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    `      requesterAgentId,
      cleanup,
      label: label2 || void 0,`,
    `      requesterAgentId,
      cleanup: isJustDoManagedSubagentController(requesterInternalKey) && cleanup === "delete" ? "keep" : cleanup,
      ...isJustDoManagedSubagentController(requesterInternalKey) && cleanup === "delete" ? { justDoJoinOriginalCleanup: "delete" } : {},
      label: label2 || void 0,`,
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    `          const shouldExpectCompletionMessage = result.inlineDelivery ? false : expectsCompletionMessage;
          try {`,
    `          const shouldExpectCompletionMessage = result.inlineDelivery ? false : expectsCompletionMessage;
          const preserveManagedDeleteCleanup = isJustDoManagedSubagentController(ownership.controllerSessionKey) && trackedCleanup === "delete";
          try {`,
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    `              requesterAgentId: opts?.requesterAgentIdOverride,
              cleanup: trackedCleanup,
              label: label2 || void 0,`,
    `              requesterAgentId: opts?.requesterAgentIdOverride,
              cleanup: preserveManagedDeleteCleanup ? "keep" : trackedCleanup,
              ...preserveManagedDeleteCleanup ? { justDoJoinOriginalCleanup: "delete" } : {},
              label: label2 || void 0,`,
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    `  const completeCleanupBookkeeping2 = (cleanupParams) => {
    removeInternalSessionEffectsTranscript(cleanupParams.entry.execution?.transcriptFile);`,
    `  const completeCleanupBookkeeping2 = (cleanupParams) => {
    if ((cleanupParams.entry.justDoJoinOriginalCleanup === "keep" || cleanupParams.entry.justDoJoinOriginalCleanup === "delete") && typeof cleanupParams.entry.justDoJoinStartedAt !== "number") {
      cleanupParams.entry.cleanup = cleanupParams.entry.justDoJoinOriginalCleanup;
      cleanupParams.cleanup = cleanupParams.entry.justDoJoinOriginalCleanup;
      cleanupParams.entry.justDoJoinOriginalCleanup = void 0;
    }
    removeInternalSessionEffectsTranscript(cleanupParams.entry.execution?.transcriptFile);`,
  );
  content = result.content;
  changed ||= result.changed;
  return { content, changed };
}

function findMissingMarkers(content) {
  const required = [
    JOIN_MARKER,
    INCREMENTAL_JOIN_MARKER,
    RELIABLE_JOIN_MARKER,
    TOOL_RESULT_COMMIT_MARKER,
    CONTINUATION_COMMIT_MARKER,
    DELETE_RETENTION_MARKER,
    SESSION_MARKER,
    RECOVERY_MARKER,
    ANNOUNCE_SUPPRESSION_MARKER,
    'waitForJustDoManagedSubagents(opts, message2, _toolCallId)',
    'typeof entry?.completion?.capturedAt === "number"',
    'entry.justDoJoinPresentedAt = presentedAt',
    'if (id) markJustDoManagedSubagentJoinToolResultPersisted(opts?.sessionKey, id);',
    'finalRole === "assistant" && finalMessage.stopReason === "stop" && toolCalls.length === 0',
    'entry.justDoJoinStartedAt = joinStartedAt',
    'abortSignal: options2?.abortSignal',
    'const justDoManagedSession = /^agent:[^:]+:justdo:[^:]+$/i.test(sessionKey ?? "");',
    '(justDoManagedSession ? sessionEntry?.sessionId : void 0) || requestedSessionId',
    'justDoManagedSession || (freshness?.fresh ?? false)',
    'entry.sessionId.trim() === requestedSessionId',
    'promoteUnconsumedJustDoJoinsForRecovery(subagentRuns)',
    'if (typeof entry?.justDoJoinStartedAt !== "number") continue;',
    RECOVERY_RELIABLE_MARKER,
    'justDoJoinOriginalCleanup: registerParams.justDoJoinOriginalCleanup',
    'preserveManagedDeleteCleanup ? "keep" : trackedCleanup',
    'cleanupParams.cleanup = cleanupParams.entry.justDoJoinOriginalCleanup',
    'justDoJoinedRun?.expectsCompletionMessage === false',
  ];
  return required.filter(marker => !content.includes(marker));
}

function patchFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  let content = fs.readFileSync(filePath, 'utf8');
  let changed = false;
  for (const patcher of [
    patchManagedJoin,
    patchManagedSessionStability,
    patchManagedJoinRecovery,
    patchManagedJoinToolResultCommit,
    patchManagedJoinContinuationCommit,
    patchManagedDeleteRetention,
    patchManagedJoinAnnounceSuppression,
  ]) {
    const result = patcher(content);
    content = result.content;
    changed ||= result.changed;
  }
  if (!changed) return false;
  const missing = findMissingMarkers(content);
  if (missing.length > 0) {
    throw new Error(
      `Managed subagent join patch could only be partially applied: ${missing.join(', ')}`,
    );
  }
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function applyPatch(runtimeDir, options = {}) {
  const filePath = path.join(runtimeDir, 'gateway-bundle.mjs');
  const patched = fs.existsSync(filePath) && patchFile(filePath) ? ['gateway-bundle.mjs'] : [];
  const label = options.label || 'patch-openclaw-managed-subagent-join';
  if (patched.length > 0)
    console.log(`[${label}] Patched managed subagent join and session stability.`);
  else if (options.verbose) console.log(`[${label}] No managed subagent join patch needed.`);
  return patched;
}

function verifyPatch(runtimeDir) {
  const content = fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8');
  const missing = findMissingMarkers(content);
  if (missing.length > 0)
    throw new Error(`Managed subagent join patch is incomplete: ${missing.join(', ')}`);
  if (content.includes('JUSTDO_MANAGED_JOIN_TOOL_BATCH_COMMIT_V1'))
    throw new Error('Managed subagent join patch still contains unsafe Tool Result batch commit');
  return true;
}

module.exports = { applyPatch, verifyPatch };
