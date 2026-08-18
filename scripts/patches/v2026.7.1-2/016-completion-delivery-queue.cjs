'use strict';

// Capability: deliver required completions FIFO per requester while allowing different requesters in parallel.
// Target: pristine openclaw@2026.7.1-2 announce dispatch and durable subagent registry cleanup.
// Scope: required subagent_announce completion delivery, busy requester waits, terminal confirmation and recovery.
// Safety: failed heads retain their sequence; recent failures remain recoverable, while completions older than
// the target runtime's hard expiry are discarded before any recovery agent/provider request can start.
// Remove when: upstream has a durable per-requester completion FIFO whose restart recovery also
// preserves managed yields and refuses to dispatch completions beyond its own hard expiry.

const fs = require('fs');
const path = require('path');
const { findFilesContaining, replaceUnique, writeIfChanged } = require('./_patch-utils');

function expectedCopies(runtimeDir) {
  return fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
}
function findTargets(runtimeDir, needles, label) {
  const files = findFilesContaining(runtimeDir, needles);
  const expected = expectedCopies(runtimeDir);
  if (files.length !== expected)
    throw new Error(`${label} target count is ${files.length}, expected ${expected}`);
  return files;
}

const LOCK_HELPER = `const subagentCompletionDeliveryTails = /* @__PURE__ */ new Map();
async function withSubagentCompletionDeliveryLock(key, task) {
\tconst previous = subagentCompletionDeliveryTails.get(key) ?? Promise.resolve();
\tlet release;
\tconst gate = new Promise((resolve) => { release = resolve; });
\tconst tail = previous.catch(() => {}).then(() => gate);
\tsubagentCompletionDeliveryTails.set(key, tail);
\tawait previous.catch(() => {});
\ttry { return await task(); }
\tfinally {
\t\trelease?.();
\t\tif (subagentCompletionDeliveryTails.get(key) === tail) subagentCompletionDeliveryTails.delete(key);
\t}
}`;

function addGatewayContextReadiness(content, filePath) {
  if (content.includes('waitForSubagentAnnounceGatewayContext')) return content;
  let updated = content;
  if (
    updated.includes(
      'import { i as dispatchGatewayMethodInProcess } from "./server-plugins-XoQmHCe9.js";',
    )
  ) {
    updated = replaceUnique(
      updated,
      'import { i as dispatchGatewayMethodInProcess } from "./server-plugins-XoQmHCe9.js";',
      'import { i as dispatchGatewayMethodInProcess, s as hasInProcessGatewayContext } from "./server-plugins-XoQmHCe9.js";',
      `${filePath}: gateway context readiness import`,
    );
  }
  return replaceUnique(
    updated,
    'async function runAnnounceAgentCall(params) {',
    `async function waitForSubagentAnnounceGatewayContext(timeoutMs) {
\tconst deadline = Date.now() + Math.max(0, Math.min(timeoutMs ?? 5000, 5000));
\twhile (!hasInProcessGatewayContext()) {
\t\tif (Date.now() >= deadline) return false;
\t\tawait new Promise((resolve) => setTimeout(resolve, 25));
\t}
\treturn true;
}
async function runAnnounceAgentCall(params) {
\tif (!await waitForSubagentAnnounceGatewayContext(params.timeoutMs)) throw new Error("Subagent announce gateway context was not ready before dispatch");`,
    `${filePath}: startup gateway context readiness`,
  );
}

function transformOrigin(content, filePath) {
  const hasDeliveryQueue =
    content.includes('withSubagentCompletionDeliveryLock(key, commit)') &&
    content.includes('completion direct announce terminal confirmation');
  if (hasDeliveryQueue) return addGatewayContextReadiness(content, filePath);
  if (!content.includes('promoteDeliveredSubagentCompletionBranch'))
    throw new Error(`${filePath}: patch 015 promotion contract is missing`);
  let updated = replaceUnique(
    content,
    'async function promoteDeliveredSubagentCompletionBranch(',
    `${LOCK_HELPER}\nasync function promoteDeliveredSubagentCompletionBranch(`,
    `${filePath}: requester delivery lock`,
  );
  updated = replaceUnique(
    updated,
    '\t\tconst requesterActivity = resolveRequesterSessionActivity(canonicalRequesterSessionKey);',
    '\t\tlet requesterActivity = resolveRequesterSessionActivity(canonicalRequesterSessionKey);',
    `${filePath}: mutable requester activity`,
  );
  updated = replaceUnique(
    updated,
    '\t\tif (params.expectsCompletionMessage && subagentAnnounceDeliveryDeps.isRequesterSessionAbandoned(canonicalRequesterSessionKey, requesterActivity.sessionId)) return {',
    `\t\tif (params.expectsCompletionMessage && isSubagentCompletion && requesterActivity.sessionId && requesterActivity.isActive) {
\t\t\tconst requesterEnded = await waitForEmbeddedAgentRunEnd(requesterActivity.sessionId, announceTimeoutMs);
\t\t\tif (!requesterEnded) return { delivered: false, path: "none", reason: "requester_busy", error: "requester session remained active while completion waited for a fresh transcript" };
\t\t\trequesterActivity = resolveRequesterSessionActivity(canonicalRequesterSessionKey);
\t\t\tif (requesterActivity.isActive) return { delivered: false, path: "none", reason: "requester_busy", error: "requester session became active before completion delivery" };
\t\t}
\t\tif (params.expectsCompletionMessage && subagentAnnounceDeliveryDeps.isRequesterSessionAbandoned(canonicalRequesterSessionKey, requesterActivity.sessionId)) return {`,
    `${filePath}: requester busy wait`,
  );
  updated = replaceUnique(
    updated,
    `\t\tif (isGatewayAgentRunPending(directAnnounceResponse)) return {
\t\t\tdelivered: true,
\t\t\tpath: "direct"
\t\t};`,
    `\t\tif (isGatewayAgentRunPending(directAnnounceResponse)) {
\t\t\tconst pendingActivity = resolveRequesterSessionActivity(canonicalRequesterSessionKey);
\t\t\tif (pendingActivity.sessionId && pendingActivity.isActive) {
\t\t\t\tconst requesterEnded = await waitForEmbeddedAgentRunEnd(pendingActivity.sessionId, announceTimeoutMs);
\t\t\t\tif (!requesterEnded) return { delivered: false, path: "none", reason: "requester_busy", error: "direct requester run remained active before transcript commit" };
\t\t\t}
\t\t\tif (params.signal?.aborted) return { delivered: false, path: "none", reason: "aborted", error: "completion delivery aborted before terminal confirmation" };
\t\t\tdirectAnnounceResponse = await runAnnounceDeliveryWithRetry({
\t\t\t\toperation: "completion direct announce terminal confirmation",
\t\t\t\tsignal: params.signal,
\t\t\t\trun: async () => await runAnnounceAgentCall({ agentParams: directAgentParams, expectFinal: true, timeoutMs: announceTimeoutMs })
\t\t\t});
\t\t\tif (isGatewayAgentRunPending(directAnnounceResponse)) return { delivered: false, path: "none", reason: "requester_busy", error: "direct requester run did not produce a terminal result" };
\t\t}`,
    `${filePath}: terminal direct confirmation`,
  );
  updated = replaceUnique(
    updated,
    '\t\tsteer: async () => await maybeSteerSubagentAnnounce({',
    '\t\tsteer: strictCompletion ? async () => ({ status: "dropped" }) : async () => await maybeSteerSubagentAnnounce({',
    `${filePath}: strict completion no-steer fence`,
  );
  const start = updated.indexOf('async function deliverSubagentAnnouncement(params) {');
  const end = updated.indexOf('\n}\n//#endregion', start);
  if (start < 0 || end < 0) throw new Error(`${filePath}: delivery boundary is missing`);
  const originalFunction = updated.slice(start, end + 2);
  let replacement = replaceUnique(
    originalFunction,
    '\tconst delivery = await runSubagentAnnounceDispatch({',
    '\tconst deliver = async () => await runSubagentAnnounceDispatch({',
    `${filePath}: queueable delivery closure`,
  );
  replacement = replaceUnique(
    replacement,
    '\t});\n\tif (shouldPromoteCommittedCompletion(strictCompletion, delivery)) await promoteDeliveredSubagentCompletionBranch(params.targetRequesterSessionKey);\n\treturn delivery;\n}',
    `\t});
\tconst commit = async () => {
\t\tconst delivery = await deliver();
\t\tif (shouldPromoteCommittedCompletion(strictCompletion, delivery)) await promoteDeliveredSubagentCompletionBranch(params.targetRequesterSessionKey);
\t\treturn delivery;
\t};
\tif (!strictCompletion) return await commit();
\tconst cfg = subagentAnnounceDeliveryDeps.getRuntimeConfig();
\tconst key = resolveRequesterStoreKey(cfg, params.targetRequesterSessionKey);
\treturn await withSubagentCompletionDeliveryLock(key, commit);
}`,
    `${filePath}: per-requester completion FIFO`,
  );
  return addGatewayContextReadiness(
    `${updated.slice(0, start)}${replacement}${updated.slice(end + 2)}`,
    filePath,
  );
}

const QUEUE_HELPERS = `\tconst ensureCompletionDeliveryQueueSequence = (entry) => {
\t\tconst delivery = ensureDeliveryState(entry);
\t\tif (typeof delivery.queueSequence === "number" && Number.isFinite(delivery.queueSequence)) return false;
\t\tlet next = Math.max(1, Date.now() * 1e3);
\t\tfor (const candidate of params.runs.values()) if (typeof candidate.delivery?.queueSequence === "number" && Number.isFinite(candidate.delivery.queueSequence)) next = Math.max(next, candidate.delivery.queueSequence + 1);
\t\tdelivery.queueSequence = next;
\t\treturn true;
\t};
\tconst compareCompletionDeliveryQueueEntries = (a, b) => {
\t\tconst as = a.delivery?.queueSequence;
\t\tconst bs = b.delivery?.queueSequence;
\t\tif (Number.isFinite(as) && Number.isFinite(bs) && as !== bs) return as - bs;
\t\tif ((a.endedAt ?? Number.MAX_SAFE_INTEGER) !== (b.endedAt ?? Number.MAX_SAFE_INTEGER)) return (a.endedAt ?? Number.MAX_SAFE_INTEGER) - (b.endedAt ?? Number.MAX_SAFE_INTEGER);
\t\treturn a.runId.localeCompare(b.runId);
\t};
\tconst isCompletionDeliveryHardExpired = (entry, now = Date.now()) => entry.pauseReason !== "sessions_yield" && entry.expectsCompletionMessage === true && typeof entry.endedAt === "number" && now - entry.endedAt > ANNOUNCE_COMPLETION_HARD_EXPIRY_MS;
\tconst hasEarlierPendingCompletionDelivery = (runId, entry) => {
\t\tfor (const [candidateRunId, candidate] of params.runs.entries()) {
\t\t\tif (candidateRunId === runId || candidate.requesterSessionKey !== entry.requesterSessionKey) continue;
\t\t\tif (candidate.expectsCompletionMessage !== true || typeof candidate.endedAt !== "number") continue;
\t\t\tif (candidate.pauseReason === "sessions_yield" || candidate.suppressAnnounceReason === "steer-restart") continue;
\t\t\tif (candidate.cleanupCompletedAt || candidate.delivery?.status === "delivered" || candidate.delivery?.status === "discarded") continue;
\t\t\tif (compareCompletionDeliveryQueueEntries(candidate, entry) < 0) return true;
\t\t}
\t\treturn false;
\t};
`;

function transformRegistry(content, filePath) {
  const patchMarkers = [
    'hasEarlierPendingCompletionDelivery(runId, entry)',
    'delivery.queueSequence = next',
    'isCompletionDeliveryHardExpired',
    'completion-hard-expired',
  ];
  if (patchMarkers.every(marker => content.includes(marker))) {
    const scopedHardExpiryCall = '\tif (isCompletionDeliveryHardExpired(entry)) {';
    if (!content.includes(scopedHardExpiryCall)) return content;
    return replaceUnique(
      content,
      scopedHardExpiryCall,
      '\tif (entry.pauseReason !== "sessions_yield" && entry.expectsCompletionMessage === true && typeof entry.endedAt === "number" && Date.now() - entry.endedAt > ANNOUNCE_COMPLETION_HARD_EXPIRY_MS) {',
      filePath + ': restart hard-expiry scope',
    );
  }
  if (patchMarkers.some(marker => content.includes(marker)))
    throw new Error(
      `${filePath}: partial completion delivery queue patch detected; rebuild pristine runtime`,
    );
  let updated = replaceUnique(
    content,
    '\tconst beginSubagentCleanup = (runId) => {',
    `${QUEUE_HELPERS}\tconst beginSubagentCleanup = (runId) => {`,
    `${filePath}: durable queue helpers`,
  );
  const ended = `\t\t\tif (entry.endedAt !== endedAt) {
\t\t\t\tentry.endedAt = endedAt;
\t\t\t\tentry.execution = {
\t\t\t\t\t...entry.execution,
\t\t\t\t\tstatus: "terminal",
\t\t\t\t\tstartedAt: entry.startedAt,
\t\t\t\t\tendedAt
\t\t\t\t};
\t\t\t\tmutated = true;
\t\t\t}`;
  updated = replaceUnique(
    updated,
    ended,
    `${ended}\n\t\t\tif (entry.expectsCompletionMessage === true && ensureCompletionDeliveryQueueSequence(entry)) mutated = true;`,
    `${filePath}: persistent sequence assignment`,
  );
  updated = replaceUnique(
    updated,
    `\tconst startSubagentAnnounceCleanupFlow = (runId, entry) => {
\t\tif (entry.killReconciliation) return false;
\t\tconst cleanup = entry.cleanup;`,
    `\tconst startSubagentAnnounceCleanupFlow = (runId, entry) => {
\t\tif (entry.killReconciliation) return false;
\t\tif (entry.expectsCompletionMessage === true) {
\t\t\tconst sequenceChanged = ensureCompletionDeliveryQueueSequence(entry);
\t\t\tif (hasEarlierPendingCompletionDelivery(runId, entry)) {
\t\t\t\tparams.resumedRuns.delete(runId);
\t\t\t\tif (sequenceChanged) params.persist();
\t\t\t\treturn false;
\t\t\t}
\t\t\tif (sequenceChanged) params.persist();
\t\t}
\t\tconst cleanup = entry.cleanup;`,
    `${filePath}: failed-head FIFO gate`,
  );
  updated = replaceUnique(
    updated,
    '\t\t\tif (isDeliverySuspended(entry)) continue;',
    `\t\t\tif (entry.pauseReason === "sessions_yield") continue;
\t\t\tif (isDeliverySuspended(entry)) {
\t\t\t\tif (isCompletionDeliveryHardExpired(entry, now)) continue;
\t\t\t\tconst delivery = ensureDeliveryState(entry);
\t\t\t\tdelivery.status = "pending";
\t\t\t\tdelivery.attemptCount = 0;
\t\t\t\tdelivery.suspendedAt = void 0;
\t\t\t\tdelivery.suspendedReason = void 0;
\t\t\t\tparams.persist();
\t\t\t}`,
    `${filePath}: suspended head retry`,
  );
  updated = replaceUnique(
    updated,
    `\tif (typeof entry.endedAt === "number" && isDeliverySuspended(entry)) return;
\tif (entry.pauseReason === "sessions_yield" && entry.wakeOnDescendantSettle !== true) return;`,
    `\tif (entry.pauseReason === "sessions_yield" && entry.wakeOnDescendantSettle !== true) return;
\tif (entry.pauseReason !== "sessions_yield" && entry.expectsCompletionMessage === true && typeof entry.endedAt === "number" && Date.now() - entry.endedAt > ANNOUNCE_COMPLETION_HARD_EXPIRY_MS) {
\t\tresumedRuns.add(runId);
\t\tdiscardSuspendedPendingFinalDelivery(runId, entry, Date.now(), "completion-hard-expired").catch((error) => {
\t\t\tresumedRuns.delete(runId);
\t\t\tdefaultRuntime.log(\`[warn] Subagent hard-expiry discard failed for run \${runId}: \${String(error)}\`);
\t\t});
\t\treturn;
\t}
\tif (typeof entry.endedAt === "number" && isDeliverySuspended(entry)) {
\t\tconst delivery = ensureDeliveryState(entry);
\t\tdelivery.status = "pending";
\t\tdelivery.attemptCount = 0;
\t\tdelivery.suspendedAt = void 0;
\t\tdelivery.suspendedReason = void 0;
\t\tpersistSubagentRuns();
\t}`,
    `${filePath}: restart recovery`,
  );
  return updated;
}

function applyPatch(runtimeDir) {
  const groups = [
    [
      findTargets(
        runtimeDir,
        ['async function deliverSubagentAnnouncement(params)', 'isGatewayAgentRunPending'],
        'announce delivery',
      ),
      transformOrigin,
    ],
    [
      findTargets(
        runtimeDir,
        ['const beginSubagentCleanup = (runId) => {', 'startSubagentAnnounceCleanupFlow'],
        'subagent registry',
      ),
      transformRegistry,
    ],
  ];
  const staged = [];
  for (const [files, transform] of groups)
    for (const filePath of files) {
      const original = fs.readFileSync(filePath, 'utf8');
      staged.push({ filePath, original, updated: transform(original, filePath) });
    }
  const changed = [];
  for (const item of staged)
    if (writeIfChanged(item.filePath, item.original, item.updated)) changed.push(item.filePath);
  return changed;
}

function verifyPatch(runtimeDir) {
  for (const filePath of findTargets(
    runtimeDir,
    ['async function deliverSubagentAnnouncement(params)', 'isGatewayAgentRunPending'],
    'announce delivery',
  )) {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const needle of [
      'withSubagentCompletionDeliveryLock(key, commit)',
      'reason: "requester_busy"',
      'completion direct announce terminal confirmation',
      'strictCompletion ? async () => ({ status: "dropped" })',
      'waitForSubagentAnnounceGatewayContext',
      'Subagent announce gateway context was not ready before dispatch',
    ])
      if (!content.includes(needle)) throw new Error(`${filePath}: missing ${needle}`);
  }
  for (const filePath of findTargets(
    runtimeDir,
    ['const beginSubagentCleanup = (runId) => {', 'startSubagentAnnounceCleanupFlow'],
    'subagent registry',
  )) {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const needle of [
      'delivery.queueSequence = next',
      'isCompletionDeliveryHardExpired',
      'hasEarlierPendingCompletionDelivery(runId, entry)',
      'completion-hard-expired',
      'delivery.status = "pending"',
      'persistSubagentRuns();',
    ])
      if (!content.includes(needle)) throw new Error(`${filePath}: missing ${needle}`);
    const managedYieldFence = content.indexOf(
      'entry.pauseReason === "sessions_yield" && entry.wakeOnDescendantSettle !== true',
    );
    const hardExpiryFence = content.indexOf(
      'Date.now() - entry.endedAt > ANNOUNCE_COMPLETION_HARD_EXPIRY_MS',
    );
    if (managedYieldFence < 0 || hardExpiryFence < 0 || managedYieldFence > hardExpiryFence)
      throw new Error(`${filePath}: managed yield must remain ahead of completion hard expiry`);
  }
}

module.exports = {
  applyPatch,
  LOCK_HELPER,
  QUEUE_HELPERS,
  transformOrigin,
  transformRegistry,
  verifyPatch,
};
