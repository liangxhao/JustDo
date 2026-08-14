'use strict';

// Purpose: Preserve streamed thinking and tool-call blocks after chat.history
// refreshes, promote finalized completion branches before the next prompt,
// serialize completion announcements per requester, treat sessions_yield completion
// handoffs as committed outbound delivery evidence, suppress redundant CLI transcript
// gap-fill after an embedded yielded turn, accept intentional silent
// completion turns that reply NO_REPLY, and accept visible stop turns regardless
// of usage metadata.
// OpenAI-compatible providers may omit usage or report zero usage for complete
// streamed responses, so usage alone cannot prove that a turn was truncated.
// Affected OpenClaw version: v2026.6.11.
// Risk: Chat history exposes sanitized tool-call blocks that upstream currently
// projects out; completion announcements for one requester wait for the active
// requester turn and prior completion delivery to finish.
// Remove when: OpenClaw preserves display thinking/tool calls in chat.history,
// promotes finalized completion side branches, serializes completion delivery
// from the latest requester transcript, records sessions_yield handoffs as
// committed delivery evidence natively, avoids mirroring already-persisted yielded
// assistant text as a CLI transcript message, accepts intentional silent completion
// turns for subagent announcements, and no longer uses token usage metadata to
// retry visible stop turns.
// Upstream tracking: TODO(openclaw): file issue/PR with JustDo long-task
// thinking refresh and subagent sessions_yield announce reproductions.
// Temporary: yes.

const fs = require('fs');
const path = require('path');

function walkJsFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsFiles(fullPath, out);
    } else if (entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name)) {
      out.push(fullPath);
    }
  }
  return out;
}

function replaceOnce(content, from, to) {
  if (content.includes(to)) return { content, changed: false };
  if (!content.includes(from)) {
    return { content, changed: false };
  }
  return { content: content.replace(from, to), changed: true };
}

function collapseOnce(content, from, to) {
  if (!content.includes(from)) {
    return { content, changed: false };
  }
  return { content: content.replace(from, to), changed: true };
}

function patchFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  let content = fs.readFileSync(filePath, 'utf8');
  let changed = false;

  const mixedToolProjectionBefore = `function projectAssistantTextFromMixedToolContent(content, maxChars) {
	if (!content.some((block) => {
		if (!block || typeof block !== "object") return false;
		return isToolHistoryBlockType(block.type);
	})) return null;
	const textBlocks = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const entry = block;
		if (entry.type !== "text" || typeof entry.text !== "string" || !entry.text.trim()) continue;
		const truncated = truncateChatHistoryText(stripInlineDirectiveTagsForDisplay(entry.text).text, maxChars);
		if (truncated.text.trim()) textBlocks.push({
			type: "text",
			text: truncated.text
		});
	}
	return textBlocks.length > 0 ? {
		content: textBlocks,
		changed: true
	} : null;
}`;

  const mixedToolProjectionAfter = `function projectAssistantTextFromMixedToolContent(content, maxChars) {
	if (!content.some((block) => {
		if (!block || typeof block !== "object") return false;
		return isToolHistoryBlockType(block.type);
	})) return null;
	const displayBlocks = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const entry = block;
		if (entry.type === "thinking" || entry.type === "reasoning" || entry.type === "redacted_thinking") {
			displayBlocks.push(block);
			continue;
		}
		if (entry.type !== "text" || typeof entry.text !== "string" || !entry.text.trim()) continue;
		const truncated = truncateChatHistoryText(stripInlineDirectiveTagsForDisplay(entry.text).text, maxChars);
		if (truncated.text.trim()) displayBlocks.push({
			type: "text",
			text: truncated.text
		});
	}
	return displayBlocks.length > 0 ? {
		content: displayBlocks,
		changed: true
	} : null;
}`;

  const mixedToolProjectionWithTools = `function projectAssistantTextFromMixedToolContent(content, maxChars) {
	if (!content.some((block) => {
		if (!block || typeof block !== "object") return false;
		return isToolHistoryBlockType(block.type);
	})) return null;
	const displayBlocks = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const entry = block;
		if (entry.type === "thinking" || entry.type === "reasoning" || entry.type === "redacted_thinking") {
			displayBlocks.push(block);
			continue;
		}
		if (isToolHistoryBlockType(entry.type)) {
			displayBlocks.push(block);
			continue;
		}
		if (entry.type !== "text" || typeof entry.text !== "string" || !entry.text.trim()) continue;
		const truncated = truncateChatHistoryText(stripInlineDirectiveTagsForDisplay(entry.text).text, maxChars);
		if (truncated.text.trim()) displayBlocks.push({
			type: "text",
			text: truncated.text
		});
	}
	return displayBlocks.length > 0 ? {
		content: displayBlocks,
		changed: true
	} : null;
}`;

  const mixedToolProjectionBundle = `function projectAssistantTextFromMixedToolContent(content, maxChars) {
  if (!content.some((block3) => {
    if (!block3 || typeof block3 !== "object") return false;
    return isToolHistoryBlockType(block3.type);
  })) return null;
  const displayBlocks = [];
  for (const block3 of content) {
    if (!block3 || typeof block3 !== "object") continue;
    const entry = block3;
    if (entry.type === "thinking" || entry.type === "reasoning" || entry.type === "redacted_thinking") {
      displayBlocks.push(block3);
      continue;
    }
    if (entry.type !== "text" || typeof entry.text !== "string" || !entry.text.trim()) continue;
    const truncated = truncateChatHistoryText(stripInlineDirectiveTagsForDisplay(entry.text).text, maxChars);
    if (truncated.text.trim()) displayBlocks.push({
      type: "text",
      text: truncated.text
    });
  }
  return displayBlocks.length > 0 ? {
    content: displayBlocks,
    changed: true
  } : null;
}`;
  const mixedToolProjectionBundleWithTools = mixedToolProjectionBundle.replace(
    '    if (entry.type !== "text" || typeof entry.text !== "string" || !entry.text.trim()) continue;',
    '    if (isToolHistoryBlockType(entry.type)) {\n      displayBlocks.push(block3);\n      continue;\n    }\n    if (entry.type !== "text" || typeof entry.text !== "string" || !entry.text.trim()) continue;',
  );

  let result = replaceOnce(content, mixedToolProjectionBefore, mixedToolProjectionAfter);
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(content, mixedToolProjectionAfter, mixedToolProjectionWithTools);
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(content, mixedToolProjectionBundle, mixedToolProjectionBundleWithTools);
  content = result.content;
  changed ||= result.changed;

  // Commentary messages containing only a tool call are auditable history,
  // even when the provider emitted no accompanying text/reasoning block.
  result = replaceOnce(content, '\treturn hasTool && hasText;', '\treturn hasTool;');
  content = result.content;
  changed ||= result.changed;
  result = replaceOnce(content, '  return hasTool && hasText;', '  return hasTool;');
  content = result.content;
  changed ||= result.changed;
  result = replaceOnce(
    content,
    '\treturn hasToolHistoryBlock && hasText;',
    '\treturn hasToolHistoryBlock;',
  );
  content = result.content;
  changed ||= result.changed;
  result = replaceOnce(
    content,
    '  return hasToolHistoryBlock && hasText;',
    '  return hasToolHistoryBlock;',
  );
  content = result.content;
  changed ||= result.changed;

  // Migrate the previous JustDo revision. Rebuilding here still selected the
  // old canonical leaf, so it could not make the just-persisted side branch
  // visible to the next completion prompt. Canonical promotion now happens
  // after the outer completion delivery has committed its final leaf control.
  result = collapseOnce(
    content,
    '              if (yieldMessage) await persistSessionsYieldContextMessage(activeSession, yieldMessage);\n              activeSession.agent.state.messages = activeSessionManager.buildSessionContext().messages;',
    '              if (yieldMessage) await persistSessionsYieldContextMessage(activeSession, yieldMessage);',
  );
  content = result.content;
  changed ||= result.changed;

  result = collapseOnce(
    content,
    '\t\t\t\tif (yieldMessage) await persistSessionsYieldContextMessage(activeSession, yieldMessage);\n\t\t\t\tactiveSession.agent.state.messages = activeSessionManager.buildSessionContext().messages;',
    '\t\t\t\tif (yieldMessage) await persistSessionsYieldContextMessage(activeSession, yieldMessage);',
  );
  content = result.content;
  changed ||= result.changed;

  // Prompt-released entries are intentionally retained as a side branch while
  // a prompt is running. A completion announce is a sequence of separate model
  // turns, though, so once its outer delivery has fully committed the append
  // branch must become the canonical leaf before the next FIFO item starts.
  // Otherwise every announce keeps reading the original sessions_yield anchor
  // even though its Tool Calls and results were persisted to the JSONL file.
  const sessionLeafPromotionBundleBefore = `      getLeafId() {
        return this.leafId;
      }
      getLeafEntry() {`;
  const sessionLeafPromotionBundleAfter = `      getLeafId() {
        return this.leafId;
      }
      promotePromptReleasedSideBranch() {
        const branchTargetId = this.promptReleasedSideBranchParentId;
        if (!branchTargetId || branchTargetId === this.leafId) return false;
        this.branch(branchTargetId);
        const leafEntry = this.createLeafControl(branchTargetId);
        this.persistRecord(leafEntry);
        this.rememberLeafControl(leafEntry);
        return true;
      }
      getLeafEntry() {`;
  result = replaceOnce(content, sessionLeafPromotionBundleBefore, sessionLeafPromotionBundleAfter);
  content = result.content;
  changed ||= result.changed;

  const sessionLeafPromotionDistBefore = `\tgetLeafId() {
\t\treturn this.leafId;
\t}
\tgetLeafEntry() {`;
  const sessionLeafPromotionDistAfter = `\tgetLeafId() {
\t\treturn this.leafId;
\t}
\tpromotePromptReleasedSideBranch() {
\t\tconst branchTargetId = this.promptReleasedSideBranchParentId;
\t\tif (!branchTargetId || branchTargetId === this.leafId) return false;
\t\tthis.branch(branchTargetId);
\t\tconst leafEntry = this.createLeafControl(branchTargetId);
\t\tthis.persistRecord(leafEntry);
\t\tthis.rememberLeafControl(leafEntry);
\t\treturn true;
\t}
\tgetLeafEntry() {`;
  result = replaceOnce(content, sessionLeafPromotionDistBefore, sessionLeafPromotionDistAfter);
  content = result.content;
  changed ||= result.changed;

  const completionLeafPromotionBundleBefore = `        if (!beforeAgentFinalizeRevisionReason) {
          await sessionLockController.waitForSessionEvents(activeSession);
          await withOwnedSessionWriteLock(async () => {
            if (shouldPersistCompletedBootstrapTurn({`;
  const completionLeafPromotionBundleAfter = `        if (!beforeAgentFinalizeRevisionReason) {
          await sessionLockController.waitForSessionEvents(activeSession);
          await withOwnedSessionWriteLock(async () => {
            const isCompletionAnnounceTurn = params.inputProvenance?.kind === "inter_session" && params.inputProvenance?.sourceTool === "subagent_announce";
            if (isCompletionAnnounceTurn && !promptError && !aborted3 && !timedOut && !idleTimedOut && !timedOutDuringCompaction) {
              activeSessionManager.promotePromptReleasedSideBranch();
              activeSession.agent.state.messages = activeSessionManager.buildSessionContext().messages;
            }
            if (shouldPersistCompletedBootstrapTurn({`;
  result = collapseOnce(
    content,
    completionLeafPromotionBundleAfter,
    completionLeafPromotionBundleBefore,
  );
  content = result.content;
  changed ||= result.changed;

  const completionLeafPromotionDistBefore = `\t\t\t\tif (!beforeAgentFinalizeRevisionReason) {
\t\t\t\t\tawait sessionLockController.waitForSessionEvents(activeSession);
\t\t\t\t\tawait withOwnedSessionWriteLock(async () => {
\t\t\t\t\t\tif (shouldPersistCompletedBootstrapTurn({`;
  const completionLeafPromotionDistAfter = `\t\t\t\tif (!beforeAgentFinalizeRevisionReason) {
\t\t\t\t\tawait sessionLockController.waitForSessionEvents(activeSession);
\t\t\t\t\tawait withOwnedSessionWriteLock(async () => {
\t\t\t\t\t\tconst isCompletionAnnounceTurn = params.inputProvenance?.kind === "inter_session" && params.inputProvenance?.sourceTool === "subagent_announce";
\t\t\t\t\t\tif (isCompletionAnnounceTurn && !promptError && !aborted && !timedOut && !idleTimedOut && !timedOutDuringCompaction) {
\t\t\t\t\t\t\tactiveSessionManager.promotePromptReleasedSideBranch();
\t\t\t\t\t\t\tactiveSession.agent.state.messages = activeSessionManager.buildSessionContext().messages;
\t\t\t\t\t\t}
\t\t\t\t\t\tif (shouldPersistCompletedBootstrapTurn({`;
  result = collapseOnce(
    content,
    completionLeafPromotionDistAfter,
    completionLeafPromotionDistBefore,
  );
  content = result.content;
  changed ||= result.changed;

  // Strict completion delivery needs to wait for the active requester run
  // instead of steering a completion into its already-prepared prompt.
  const runsImportPattern =
    /import \{ ([^\n]*?\bi as formatEmbeddedAgentQueueFailureSummary,[^\n]*?) \} from "(\.\/runs-[^"]+\.js)";/;
  if (!content.includes('waitForEmbeddedAgentRunEnd') && runsImportPattern.test(content)) {
    content = content.replace(
      runsImportPattern,
      (_match, imports, modulePath) =>
        `import { S as waitForEmbeddedAgentRunEnd, ${imports} } from "${modulePath}";`,
    );
    changed = true;
  }

  const requesterActivityBundle =
    '    const requesterActivity = resolveRequesterSessionActivity(canonicalRequesterSessionKey);';
  const requesterActivityBundlePatched = `    let requesterActivity = resolveRequesterSessionActivity(canonicalRequesterSessionKey);
    if (params.expectsCompletionMessage && isSubagentCompletion && requesterActivity.sessionId && requesterActivity.isActive) {
      const requesterEnded = await waitForEmbeddedAgentRunEnd(requesterActivity.sessionId, announceTimeoutMs);
      if (!requesterEnded) return {
        delivered: false,
        path: "none",
        reason: "requester_busy",
        error: "requester session remained active while subagent completion waited for a fresh transcript"
      };
      requesterActivity = resolveRequesterSessionActivity(canonicalRequesterSessionKey);
      if (requesterActivity.isActive) return {
        delivered: false,
        path: "none",
        reason: "requester_busy",
        error: "requester session became active before subagent completion could start"
      };
    }`;
  result = replaceOnce(content, requesterActivityBundle, requesterActivityBundlePatched);
  content = result.content;
  changed ||= result.changed;

  const requesterActivityDist =
    '\t\tconst requesterActivity = resolveRequesterSessionActivity(canonicalRequesterSessionKey);';
  const requesterActivityDistPatched = `\t\tlet requesterActivity = resolveRequesterSessionActivity(canonicalRequesterSessionKey);
\t\tif (params.expectsCompletionMessage && isSubagentCompletion && requesterActivity.sessionId && requesterActivity.isActive) {
\t\t\tconst requesterEnded = await waitForEmbeddedAgentRunEnd(requesterActivity.sessionId, announceTimeoutMs);
\t\t\tif (!requesterEnded) return {
\t\t\t\tdelivered: false,
\t\t\t\tpath: "none",
\t\t\t\treason: "requester_busy",
\t\t\t\terror: "requester session remained active while subagent completion waited for a fresh transcript"
\t\t\t};
\t\t\trequesterActivity = resolveRequesterSessionActivity(canonicalRequesterSessionKey);
\t\t\tif (requesterActivity.isActive) return {
\t\t\t\tdelivered: false,
\t\t\t\tpath: "none",
\t\t\t\treason: "requester_busy",
\t\t\t\terror: "requester session became active before subagent completion could start"
\t\t\t};
\t\t}`;
  result = replaceOnce(content, requesterActivityDist, requesterActivityDistPatched);
  content = result.content;
  changed ||= result.changed;

  const requesterWaitHelperBundle = `async function waitForSubagentRequesterRunEnd(sessionId, timeoutMs, signal) {
  if (!signal) return await waitForEmbeddedAgentRunEnd(sessionId, timeoutMs);
  if (signal.aborted) return false;
  let onAbort;
  const aborted = new Promise((resolve) => {
    onAbort = () => resolve(false);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([
      waitForEmbeddedAgentRunEnd(sessionId, timeoutMs),
      aborted
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}`;
  const requesterWaitHelperDist = `async function waitForSubagentRequesterRunEnd(sessionId, timeoutMs, signal) {
\tif (!signal) return await waitForEmbeddedAgentRunEnd(sessionId, timeoutMs);
\tif (signal.aborted) return false;
\tlet onAbort;
\tconst aborted = new Promise((resolve) => {
\t\tonAbort = () => resolve(false);
\t\tsignal.addEventListener("abort", onAbort, { once: true });
\t});
\ttry {
\t\treturn await Promise.race([waitForEmbeddedAgentRunEnd(sessionId, timeoutMs), aborted]);
\t} finally {
\t\tif (onAbort) signal.removeEventListener("abort", onAbort);
\t}
}`;
  if (
    !content.includes('async function waitForSubagentRequesterRunEnd(') &&
    content.includes('async function deliverSubagentAnnouncement(params) {')
  ) {
    const helper = content.includes('\n\treturn await runSubagentAnnounceDispatch({')
      ? requesterWaitHelperDist
      : requesterWaitHelperBundle;
    content = content.replace(
      'async function deliverSubagentAnnouncement(params) {',
      `${helper}\nasync function deliverSubagentAnnouncement(params) {`,
    );
    changed = true;
  }

  result = replaceOnce(
    content,
    'const requesterEnded = await waitForEmbeddedAgentRunEnd(requesterActivity.sessionId, announceTimeoutMs);',
    'const requesterEnded = await waitForSubagentRequesterRunEnd(requesterActivity.sessionId, announceTimeoutMs, params.signal);',
  );
  content = result.content;
  changed ||= result.changed;
  result = replaceOnce(
    content,
    'reason: "requester_busy",\n        error: "requester session remained active while subagent completion waited for a fresh transcript"',
    'reason: params.signal?.aborted ? "aborted" : "requester_busy",\n        error: params.signal?.aborted ? "subagent completion delivery was aborted while waiting for the requester" : "requester session remained active while subagent completion waited for a fresh transcript"',
  );
  content = result.content;
  changed ||= result.changed;
  result = replaceOnce(
    content,
    'reason: "requester_busy",\n\t\t\t\terror: "requester session remained active while subagent completion waited for a fresh transcript"',
    'reason: params.signal?.aborted ? "aborted" : "requester_busy",\n\t\t\t\terror: params.signal?.aborted ? "subagent completion delivery was aborted while waiting for the requester" : "requester session remained active while subagent completion waited for a fresh transcript"',
  );
  content = result.content;
  changed ||= result.changed;

  // A direct agent call can acknowledge a non-terminal run even when
  // expectFinal was requested. Do not release the completion FIFO until that
  // requester run has ended and the idempotent command can return its terminal
  // result. Abort/timeout stays undelivered so registry recovery can retry it.
  const pendingDirectBundle = `    if (isGatewayAgentRunPending(directAnnounceResponse)) return {
      delivered: true,
      path: "direct"
    };`;
  const pendingDirectBundlePatched = `    if (isGatewayAgentRunPending(directAnnounceResponse)) {
      const pendingActivity = resolveRequesterSessionActivity(canonicalRequesterSessionKey);
      if (pendingActivity.sessionId && pendingActivity.isActive) {
        const requesterEnded = await waitForSubagentRequesterRunEnd(pendingActivity.sessionId, announceTimeoutMs, params.signal);
        if (!requesterEnded) return {
          delivered: false,
          path: "none",
          reason: params.signal?.aborted ? "aborted" : "requester_busy",
          error: params.signal?.aborted ? "subagent completion delivery was aborted while waiting for the direct requester run" : "direct requester run remained active before its transcript committed"
        };
      }
      if (params.signal?.aborted) return {
        delivered: false,
        path: "none",
        reason: "aborted",
        error: "subagent completion delivery was aborted before the direct requester result was confirmed"
      };
      directAnnounceResponse = await runAnnounceDeliveryWithRetry({
        operation: "completion direct announce terminal confirmation",
        signal: params.signal,
        run: async () => await runAnnounceAgentCall({
          agentParams: directAgentParams,
          expectFinal: true,
          timeoutMs: announceTimeoutMs
        })
      });
      if (isGatewayAgentRunPending(directAnnounceResponse)) return {
        delivered: false,
        path: "none",
        reason: "requester_busy",
        error: "direct requester run did not produce a terminal result after its transcript wait"
      };
    }`;
  result = replaceOnce(content, pendingDirectBundle, pendingDirectBundlePatched);
  content = result.content;
  changed ||= result.changed;

  const pendingDirectDist = `\t\tif (isGatewayAgentRunPending(directAnnounceResponse)) return {
\t\t\tdelivered: true,
\t\t\tpath: "direct"
\t\t};`;
  const pendingDirectDistPatched = pendingDirectBundlePatched.replaceAll('    ', '\t\t');
  result = replaceOnce(content, pendingDirectDist, pendingDirectDistPatched);
  content = result.content;
  changed ||= result.changed;

  // Delivery order must survive attempt failures and Gateway restarts. The
  // registry persists delivery.queueSequence through its payload JSON, while
  // cleanup completion already wakes deferred runs.
  const registryQueueHelpersBundle = `  const ensureCompletionDeliveryQueueSequence = (entry) => {
    const delivery = ensureDeliveryState(entry);
    if (typeof delivery.queueSequence === "number" && Number.isFinite(delivery.queueSequence)) return false;
    let next = Math.max(1, Date.now() * 1e3);
    for (const candidate of params.runs.values()) {
      const sequence = candidate.delivery?.queueSequence;
      if (typeof sequence === "number" && Number.isFinite(sequence)) next = Math.max(next, sequence + 1);
    }
    delivery.queueSequence = next;
    return true;
  };
  const compareCompletionDeliveryQueueEntries = (a, b) => {
    const aSequence = a.delivery?.queueSequence;
    const bSequence = b.delivery?.queueSequence;
    if (typeof aSequence === "number" && Number.isFinite(aSequence) && typeof bSequence === "number" && Number.isFinite(bSequence) && aSequence !== bSequence) return aSequence - bSequence;
    const aEndedAt = typeof a.endedAt === "number" ? a.endedAt : Number.MAX_SAFE_INTEGER;
    const bEndedAt = typeof b.endedAt === "number" ? b.endedAt : Number.MAX_SAFE_INTEGER;
    if (aEndedAt !== bEndedAt) return aEndedAt - bEndedAt;
    const aCreatedAt = a.delivery?.createdAt ?? a.createdAt;
    const bCreatedAt = b.delivery?.createdAt ?? b.createdAt;
    if (aCreatedAt !== bCreatedAt) return aCreatedAt - bCreatedAt;
    return a.runId.localeCompare(b.runId);
  };
  const isCompletionDeliveryQueueTerminal = (entry) => typeof entry.cleanupCompletedAt === "number" || entry.delivery?.status === "delivered" || entry.delivery?.status === "failed" || entry.delivery?.status === "discarded";
  const hasEarlierPendingCompletionDelivery = (runId, entry) => {
    for (const [candidateRunId, candidate] of params.runs.entries()) {
      if (candidateRunId === runId || candidate.requesterSessionKey !== entry.requesterSessionKey) continue;
      if (candidate.expectsCompletionMessage !== true || typeof candidate.endedAt !== "number") continue;
      if (candidate.pauseReason === "sessions_yield" || candidate.suppressAnnounceReason === "steer-restart") continue;
      if (isCompletionDeliveryQueueTerminal(candidate)) continue;
      if (compareCompletionDeliveryQueueEntries(candidate, entry) < 0) return true;
    }
    return false;
  };
`;
  const registryQueueHelpersDist = registryQueueHelpersBundle
    .replaceAll('  ', '\t')
    .replaceAll('(a, b) =>', '(a, b) =>');
  if (
    !content.includes('const ensureCompletionDeliveryQueueSequence =') &&
    content.includes('const beginSubagentCleanup = (runId) => {')
  ) {
    const helper = content.includes('\n\tconst beginSubagentCleanup = (runId) => {')
      ? registryQueueHelpersDist
      : registryQueueHelpersBundle;
    content = content.replace(
      '  const beginSubagentCleanup = (runId) => {',
      `${helper}  const beginSubagentCleanup = (runId) => {`,
    );
    content = content.replace(
      '\tconst beginSubagentCleanup = (runId) => {',
      `${helper}\tconst beginSubagentCleanup = (runId) => {`,
    );
    changed = true;
  }

  const cleanupRecoveryBundle = `  const recoverSubagentCleanupFinalizeFailure = (runId) => {
    const current = params.runs.get(runId);
    if (!current || current.cleanupCompletedAt) {
      retryDeferredCompletedAnnounces(runId);
      return;
    }
    current.cleanupHandled = false;
    params.resumedRuns.delete(runId);
    try {
      params.persist();
    } catch (persistError) {
      defaultRuntime.log(\`[warn] subagent cleanup recovery persist failed (\${runId}): \${String(persistError)}\`);
    }
    if (isCompletionDeliveryQueueTerminal(current)) retryDeferredCompletedAnnounces(runId);
    scheduleResumeSubagentRun(runId, current, resolveAnnounceRetryDelayMs(getDeliveryAttemptCount(current)));
  };
`;
  const cleanupRecoveryDist = cleanupRecoveryBundle.replaceAll('  ', '\t');
  if (
    !content.includes('const recoverSubagentCleanupFinalizeFailure =') &&
    content.includes('const beginSubagentCleanup = (runId) => {')
  ) {
    const helper = content.includes('\n\tconst beginSubagentCleanup = (runId) => {')
      ? cleanupRecoveryDist
      : cleanupRecoveryBundle;
    content = content.replace(
      '  const beginSubagentCleanup = (runId) => {',
      `${helper}  const beginSubagentCleanup = (runId) => {`,
    );
    content = content.replace(
      '\tconst beginSubagentCleanup = (runId) => {',
      `${helper}\tconst beginSubagentCleanup = (runId) => {`,
    );
    changed = true;
  }

  const endedAtBundleAnchor = `    if (entry.endedAt !== endedAt) {
      entry.endedAt = endedAt;
      entry.execution = {
        ...entry.execution,
        status: "terminal",
        startedAt: entry.startedAt,
        endedAt
      };
      mutated = true;
    }`;
  const endedAtBundlePatched = `${endedAtBundleAnchor}
    if (entry.expectsCompletionMessage === true && ensureCompletionDeliveryQueueSequence(entry)) mutated = true;`;
  result = replaceOnce(content, endedAtBundleAnchor, endedAtBundlePatched);
  content = result.content;
  changed ||= result.changed;
  const endedAtDistAnchor = `\t\tif (entry.endedAt !== endedAt) {
\t\t\tentry.endedAt = endedAt;
\t\t\tentry.execution = {
\t\t\t\t...entry.execution,
\t\t\t\tstatus: "terminal",
\t\t\t\tstartedAt: entry.startedAt,
\t\t\t\tendedAt
\t\t\t};
\t\t\tmutated = true;
\t\t}`;
  const endedAtDistPatched = `${endedAtDistAnchor}
\t\tif (entry.expectsCompletionMessage === true && ensureCompletionDeliveryQueueSequence(entry)) mutated = true;`;
  result = replaceOnce(content, endedAtDistAnchor, endedAtDistPatched);
  content = result.content;
  changed ||= result.changed;

  const queueGateBundleAnchor = `    if (!beginSubagentCleanup(runId)) return false;
    if (entry.expectsCompletionMessage === false) {`;
  const queueGateBundlePatched = `    if (entry.expectsCompletionMessage === true) {
      const sequenceChanged = ensureCompletionDeliveryQueueSequence(entry);
      if (hasEarlierPendingCompletionDelivery(runId, entry)) {
        params.resumedRuns.delete(runId);
        if (sequenceChanged) params.persist();
        return false;
      }
      if (sequenceChanged) params.persist();
    }
    if (!beginSubagentCleanup(runId)) return false;
    if (entry.expectsCompletionMessage === false) {`;
  result = replaceOnce(content, queueGateBundleAnchor, queueGateBundlePatched);
  content = result.content;
  changed ||= result.changed;
  const queueGateDistAnchor = `\t\tif (!beginSubagentCleanup(runId)) return false;
\t\tif (entry.expectsCompletionMessage === false) {`;
  const queueGateDistPatched = `\t\tif (entry.expectsCompletionMessage === true) {
\t\t\tconst sequenceChanged = ensureCompletionDeliveryQueueSequence(entry);
\t\t\tif (hasEarlierPendingCompletionDelivery(runId, entry)) {
\t\t\t\tparams.resumedRuns.delete(runId);
\t\t\t\tif (sequenceChanged) params.persist();
\t\t\t\treturn false;
\t\t\t}
\t\t\tif (sequenceChanged) params.persist();
\t\t}
\t\tif (!beginSubagentCleanup(runId)) return false;
\t\tif (entry.expectsCompletionMessage === false) {`;
  result = replaceOnce(content, queueGateDistAnchor, queueGateDistPatched);
  content = result.content;
  changed ||= result.changed;

  // Every cleanup-finalize catch delegates to one recovery helper. It wakes
  // deferred completions even when bookkeeping already removed/completed the
  // entry, and a second persistence failure cannot prevent wake or retry.
  const cleanupCatchPattern =
    /^(\s*)const current = params\.runs\.get\(runId\);\n\1if \(!current \|\| current\.cleanupCompletedAt\) return;\n\1current\.cleanupHandled = false;\n(?:\1params\.resumedRuns\.delete\(runId\);\n)?\1params\.persist\(\);(?:\n\1if \(isCompletionDeliveryQueueTerminal\(current\)\) retryDeferredCompletedAnnounces\(runId\);)?(?:\n\1scheduleResumeSubagentRun\(runId, current, resolveAnnounceRetryDelayMs\(getDeliveryAttemptCount\(current\)\)\);)?/gm;
  if (cleanupCatchPattern.test(content)) {
    content = content.replace(
      cleanupCatchPattern,
      (_match, indent) => `${indent}recoverSubagentCleanupFinalizeFailure(runId);`,
    );
    changed = true;
  }

  const announceHelperBundle = `const subagentCompletionAnnounceTails = /* @__PURE__ */ new Map();
async function withSubagentCompletionAnnounceLock(key, task) {
  const previous = subagentCompletionAnnounceTails.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => gate);
  subagentCompletionAnnounceTails.set(key, tail);
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release?.();
    if (subagentCompletionAnnounceTails.get(key) === tail) subagentCompletionAnnounceTails.delete(key);
  }
}`;
  const announceHelperDist = `const subagentCompletionAnnounceTails = new Map();
async function withSubagentCompletionAnnounceLock(key, task) {
\tconst previous = subagentCompletionAnnounceTails.get(key) ?? Promise.resolve();
\tlet release;
\tconst gate = new Promise((resolve) => {
\t\trelease = resolve;
\t});
\tconst tail = previous.catch(() => {}).then(() => gate);
\tsubagentCompletionAnnounceTails.set(key, tail);
\tawait previous.catch(() => {});
\ttry {
\t\treturn await task();
\t} finally {
\t\trelease?.();
\t\tif (subagentCompletionAnnounceTails.get(key) === tail) subagentCompletionAnnounceTails.delete(key);
\t}
}`;
  const announceLockOccurrences =
    content.split('async function withSubagentCompletionAnnounceLock(key, task) {').length - 1;
  if (announceLockOccurrences > 1 && content.includes(`${announceHelperBundle}\n`)) {
    content = content.replace(`${announceHelperBundle}\n`, '');
    changed = true;
  }
  if (!content.includes('async function withSubagentCompletionAnnounceLock(key, task) {')) {
    if (content.includes('async function deliverSubagentAnnouncement(params) {')) {
      const helper = content.includes('\n\treturn await runSubagentAnnounceDispatch({')
        ? announceHelperDist
        : announceHelperBundle;
      content = content.replace(
        'async function deliverSubagentAnnouncement(params) {',
        `${helper}\nasync function deliverSubagentAnnouncement(params) {`,
      );
      changed = true;
    }
  }

  // The embedded agent finalizer is not the completion delivery commit point:
  // the outer agent command can still append a delivery mirror/leaf control
  // afterwards. Reopen the transcript from disk and promote only after that
  // outer command reports success, while the per-requester FIFO is still held.
  if (
    path.basename(filePath) !== 'gateway-bundle.mjs' &&
    content.includes('async function deliverSubagentAnnouncement(params) {') &&
    !content.includes('import { t as SessionManager } from "./session-manager-')
  ) {
    const sessionManagerFile = fs
      .readdirSync(path.dirname(filePath))
      .find(
        name =>
          /^session-manager-[^.]+\.js$/.test(name) &&
          fs
            .readFileSync(path.join(path.dirname(filePath), name), 'utf8')
            .includes('SessionManager as t'),
      );
    if (sessionManagerFile) {
      content = `import { t as SessionManager } from "./${sessionManagerFile}";\n${content}`;
      changed = true;
    }
  }
  if (
    path.basename(filePath) !== 'gateway-bundle.mjs' &&
    content.includes('async function deliverSubagentAnnouncement(params) {') &&
    !content.includes('as acquireSessionWriteLock } from "./session-write-lock-')
  ) {
    const sessionWriteLockFile = fs.readdirSync(path.dirname(filePath)).find(name => {
      if (!/^session-write-lock-[^.]+\.js$/.test(name)) return false;
      const candidate = fs.readFileSync(path.join(path.dirname(filePath), name), 'utf8');
      return (
        candidate.includes('resolveSessionWriteLockOptions as s') &&
        candidate.includes('acquireSessionWriteLock as t')
      );
    });
    if (sessionWriteLockFile) {
      content = `import { s as resolveSessionWriteLockOptions, t as acquireSessionWriteLock } from "./${sessionWriteLockFile}";\n${content}`;
      changed = true;
    }
  }

  const completionPromotionHelperBundle = `async function promoteDeliveredSubagentCompletionBranch(canonicalRequesterSessionKey) {
  const { cfg, entry } = loadRequesterSessionEntry(canonicalRequesterSessionKey);
  const sessionFile = normalizeOptionalString(entry?.sessionFile);
  if (!sessionFile) throw new Error("subagent completion canonical promotion requires a requester transcript");
  const lock = await acquireSessionWriteLock({
    sessionFile,
    ...resolveSessionWriteLockOptions(cfg),
    allowReentrant: true
  });
  try {
    const sessionManager = SessionManager.open(sessionFile);
    sessionManager.promotePromptReleasedSideBranch();
  } finally {
    await lock.release();
  }
}`;
  const completionPromotionHelperDist = completionPromotionHelperBundle.replaceAll('  ', '\t');
  const promotionDependencyDir = path.join(
    path.dirname(filePath),
    path.basename(filePath) === 'gateway-bundle.mjs' ? 'dist' : '.',
  );
  const promotionDependencyFiles = fs.existsSync(promotionDependencyDir)
    ? fs.readdirSync(promotionDependencyDir)
    : [];
  const sessionManagerRuntimeFile = promotionDependencyFiles.find(name => {
    if (!/^session-manager-[^.]+\.js$/.test(name)) return false;
    return fs
      .readFileSync(path.join(promotionDependencyDir, name), 'utf8')
      .includes('SessionManager as t');
  });
  const sessionWriteLockRuntimeFile = promotionDependencyFiles.find(name => {
    if (!/^session-write-lock-[^.]+\.js$/.test(name)) return false;
    const candidate = fs.readFileSync(path.join(promotionDependencyDir, name), 'utf8');
    return (
      candidate.includes('resolveSessionWriteLockOptions as s') &&
      candidate.includes('acquireSessionWriteLock as t')
    );
  });
  const completionPromotionHelperGateway =
    sessionManagerRuntimeFile && sessionWriteLockRuntimeFile
      ? completionPromotionHelperBundle.replace(
          '  const { cfg, entry } = loadRequesterSessionEntry(canonicalRequesterSessionKey);',
          `  const [{ t: SessionManager }, { s: resolveSessionWriteLockOptions, t: acquireSessionWriteLock }] = await Promise.all([\n    import("./dist/${sessionManagerRuntimeFile}"),\n    import("./dist/${sessionWriteLockRuntimeFile}")\n  ]);\n  const { cfg, entry } = loadRequesterSessionEntry(canonicalRequesterSessionKey);`,
        )
      : completionPromotionHelperBundle;
  if (
    path.basename(filePath) === 'gateway-bundle.mjs' &&
    completionPromotionHelperGateway !== completionPromotionHelperBundle
  ) {
    result = replaceOnce(
      content,
      completionPromotionHelperBundle,
      completionPromotionHelperGateway,
    );
    content = result.content;
    changed ||= result.changed;
  }
  if (
    !content.includes('async function promoteDeliveredSubagentCompletionBranch(') &&
    content.includes('async function withSubagentCompletionAnnounceLock(key, task) {')
  ) {
    const helper =
      path.basename(filePath) === 'gateway-bundle.mjs'
        ? completionPromotionHelperGateway
        : completionPromotionHelperDist;
    content = content.replace(
      'async function withSubagentCompletionAnnounceLock(key, task) {',
      `${helper}\nasync function withSubagentCompletionAnnounceLock(key, task) {`,
    );
    changed = true;
  }

  const deliverStartBundle = `async function deliverSubagentAnnouncement(params) {
  return await runSubagentAnnounceDispatch({`;
  const deliverStartBundlePatched = `async function deliverSubagentAnnouncement(params) {
  const strictCompletion = params.expectsCompletionMessage === true && (normalizeOptionalLowercaseString(params.sourceTool) ?? "subagent_announce") === "subagent_announce";
  const deliver = async () => await runSubagentAnnounceDispatch({`;
  result = replaceOnce(content, deliverStartBundle, deliverStartBundlePatched);
  content = result.content;
  changed ||= result.changed;

  const deliverEndBundle = `    })
  });
}`;
  const deliverEndBundlePatched = `    })
  });
  if (!strictCompletion) return await deliver();
  const cfg = subagentAnnounceDeliveryDeps.getRuntimeConfig();
  const key = resolveRequesterStoreKey(cfg, params.targetRequesterSessionKey);
  return await withSubagentCompletionAnnounceLock(key, deliver);
}`;
  if (
    content.includes(deliverStartBundlePatched) &&
    !content.includes('return await withSubagentCompletionAnnounceLock(key,')
  ) {
    const start = content.indexOf(deliverStartBundlePatched);
    const end = content.indexOf(deliverEndBundle, start);
    if (end >= 0) {
      content = `${content.slice(0, end)}${deliverEndBundlePatched}${content.slice(end + deliverEndBundle.length)}`;
      changed = true;
    }
  }

  const deliverStartDist = `async function deliverSubagentAnnouncement(params) {
\treturn await runSubagentAnnounceDispatch({`;
  const deliverStartDistPatched = `async function deliverSubagentAnnouncement(params) {
\tconst strictCompletion = params.expectsCompletionMessage === true && (normalizeOptionalLowercaseString(params.sourceTool) ?? "subagent_announce") === "subagent_announce";
\tconst deliver = async () => await runSubagentAnnounceDispatch({`;
  result = replaceOnce(content, deliverStartDist, deliverStartDistPatched);
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    'const strictCompletion = params.expectsCompletionMessage === true && normalizeOptionalLowercaseString(params.sourceTool) === "subagent_announce";',
    'const strictCompletion = params.expectsCompletionMessage === true && (normalizeOptionalLowercaseString(params.sourceTool) ?? "subagent_announce") === "subagent_announce";',
  );
  content = result.content;
  changed ||= result.changed;

  const deliverEndDist = `\t\t})
\t});
}`;
  const deliverEndDistPatched = `\t\t})
\t});
\tif (!strictCompletion) return await deliver();
\tconst cfg = subagentAnnounceDeliveryDeps.getRuntimeConfig();
\tconst key = resolveRequesterStoreKey(cfg, params.targetRequesterSessionKey);
\treturn await withSubagentCompletionAnnounceLock(key, deliver);
}`;
  if (
    content.includes(deliverStartDistPatched) &&
    !content.includes('return await withSubagentCompletionAnnounceLock(key,')
  ) {
    const start = content.indexOf(deliverStartDistPatched);
    const end = content.indexOf(deliverEndDist, start);
    if (end >= 0) {
      content = `${content.slice(0, end)}${deliverEndDistPatched}${content.slice(end + deliverEndDist.length)}`;
      changed = true;
    }
  }

  result = replaceOnce(
    content,
    '  return await withSubagentCompletionAnnounceLock(key, deliver);',
    `  return await withSubagentCompletionAnnounceLock(key, async () => {
    const delivery = await deliver();
    if (delivery.delivered) await promoteDeliveredSubagentCompletionBranch(key);
    return delivery;
  });`,
  );
  content = result.content;
  changed ||= result.changed;

  const detachedStaleCompletionLockBundle = `  if (!strictCompletion) return await deliver();
  const cfg = subagentAnnounceDeliveryDeps.getRuntimeConfig();
  const key = resolveRequesterStoreKey(cfg, params.targetRequesterSessionKey);
  return await withSubagentCompletionAnnounceLock(key, deliver);
}`;
  if (
    content.includes(
      'if (delivery.delivered) await promoteDeliveredSubagentCompletionBranch(key);',
    ) &&
    content.includes(detachedStaleCompletionLockBundle)
  ) {
    content = content.replace(detachedStaleCompletionLockBundle, '}');
    changed = true;
  }
  result = replaceOnce(
    content,
    '\treturn await withSubagentCompletionAnnounceLock(key, deliver);',
    `\treturn await withSubagentCompletionAnnounceLock(key, async () => {
\t\tconst delivery = await deliver();
\t\tif (delivery.delivered) await promoteDeliveredSubagentCompletionBranch(key);
\t\treturn delivery;
\t});`,
  );
  content = result.content;
  changed ||= result.changed;
  const detachedStaleCompletionLockDist = `\tif (!strictCompletion) return await deliver();
\tconst cfg = subagentAnnounceDeliveryDeps.getRuntimeConfig();
\tconst key = resolveRequesterStoreKey(cfg, params.targetRequesterSessionKey);
\treturn await withSubagentCompletionAnnounceLock(key, deliver);
}`;
  if (
    content.includes(
      'if (delivery.delivered) await promoteDeliveredSubagentCompletionBranch(key);',
    ) &&
    content.includes(detachedStaleCompletionLockDist)
  ) {
    content = content.replace(detachedStaleCompletionLockDist, '}');
    changed = true;
  }

  // Strict completion failures must remain undelivered for registry recovery;
  // never fall back to steering the same event into a stale active prompt.
  result = replaceOnce(
    content,
    '    steer: async () => await maybeSteerSubagentAnnounce({',
    '    steer: strictCompletion ? async () => ({ status: "dropped" }) : async () => await maybeSteerSubagentAnnounce({',
  );
  content = result.content;
  changed ||= result.changed;
  result = replaceOnce(
    content,
    '\t\tsteer: async () => await maybeSteerSubagentAnnounce({',
    '\t\tsteer: strictCompletion ? async () => ({ status: "dropped" }) : async () => await maybeSteerSubagentAnnounce({',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    'function hasAssistantNonTextContent(message) {\n\tif (!message || typeof message !== "object") return false;\n\tconst content = message.content;\n\tif (!Array.isArray(content)) return false;\n\treturn content.some((block) => block && typeof block === "object" && !isAssistantTextContentType(block.type));\n}',
    'function isAssistantReasoningContentType(type) {\n\treturn type === "thinking" || type === "reasoning" || type === "redacted_thinking";\n}\nfunction hasAssistantNonTextContent(message) {\n\tif (!message || typeof message !== "object") return false;\n\tconst content = message.content;\n\tif (!Array.isArray(content)) return false;\n\treturn content.some((block) => block && typeof block === "object" && !isAssistantTextContentType(block.type) && !isAssistantReasoningContentType(block.type));\n}',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    'function hasAssistantNonTextContent(message2) {\n  if (!message2 || typeof message2 !== "object") return false;\n  const content = message2.content;\n  if (!Array.isArray(content)) return false;\n  return content.some((block3) => block3 && typeof block3 === "object" && !isAssistantTextContentType(block3.type));\n}',
    'function isAssistantReasoningContentType(type) {\n  return type === "thinking" || type === "reasoning" || type === "redacted_thinking";\n}\nfunction hasAssistantNonTextContent(message2) {\n  if (!message2 || typeof message2 !== "object") return false;\n  const content = message2.content;\n  if (!Array.isArray(content)) return false;\n  return content.some((block3) => block3 && typeof block3 === "object" && !isAssistantTextContentType(block3.type) && !isAssistantReasoningContentType(block3.type));\n}',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    '\t\tif (isAssistantTextContentType(entry.type) && typeof entry.text === "string" && entry.text.trim()) hasText = true;',
    '\t\tif (isAssistantTextContentType(entry.type) && typeof entry.text === "string" && entry.text.trim()) hasText = true;\n\t\tif (isAssistantReasoningContentType(entry.type) && typeof entry.thinking === "string" && entry.thinking.trim()) hasText = true;',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    '    if (isAssistantTextContentType(entry.type) && typeof entry.text === "string" && entry.text.trim()) hasText = true;',
    '    if (isAssistantTextContentType(entry.type) && typeof entry.text === "string" && entry.text.trim()) hasText = true;\n    if (isAssistantReasoningContentType(entry.type) && typeof entry.thinking === "string" && entry.thinking.trim()) hasText = true;',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    '\treturn text !== void 0 && !isSuppressedControlReplyText(text);',
    '\tif (text !== void 0) return !isSuppressedControlReplyText(text);\n\tconst content = message.content;\n\treturn Array.isArray(content) && content.some((block) => block && typeof block === "object" && isAssistantReasoningContentType(block.type) && typeof block.thinking === "string" && block.thinking.trim());',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    '  return text !== void 0 && !isSuppressedControlReplyText(text);',
    '  if (text !== void 0) return !isSuppressedControlReplyText(text);\n  const content = message2.content;\n  return Array.isArray(content) && content.some((block3) => block3 && typeof block3 === "object" && isAssistantReasoningContentType(block3.type) && typeof block3.thinking === "string" && block3.thinking.trim());',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    '\t\treturn type !== "thinking" && type !== "reasoning" && type !== "redacted_thinking";',
    '\t\treturn true;',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    '    return type !== "thinking" && type !== "reasoning" && type !== "redacted_thinking";',
    '    return true;',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    'function isZeroUsageEmptyStopAssistantTurn(message2) {\n  return Boolean(message2 && message2.stopReason === "stop" && Array.isArray(message2.content) && message2.content.length === 0 && hasZeroTokenUsageSnapshot(message2.usage));\n}',
    'function isZeroUsageEmptyStopAssistantTurn(message2) {\n  return Boolean(message2 && message2.stopReason === "stop" && Array.isArray(message2.content) && (message2.content.length === 0 || hasOnlyAssistantReasoningContent(message2)) && hasZeroTokenUsageSnapshot(message2.usage));\n}\nfunction isZeroUsageVisibleStopAssistantTurn(message2) {\n  return false;\n}',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    'function isZeroOrMissingUsageSnapshot(usage) {\n  return usage == null || hasZeroTokenUsageSnapshot(usage);\n}\nfunction isZeroUsageEmptyStopAssistantTurn(message2) {\n  return Boolean(message2 && message2.stopReason === "stop" && Array.isArray(message2.content) && (message2.content.length === 0 || hasOnlyAssistantReasoningContent(message2)) && hasZeroTokenUsageSnapshot(message2.usage));\n}\nfunction isZeroUsageVisibleStopAssistantTurn(message2) {\n  return Boolean(message2 && message2.stopReason === "stop" && Array.isArray(message2.content) && message2.content.some((block3) => block3 && typeof block3 === "object" && isAssistantTextContentType(block3.type) && typeof block3.text === "string" && block3.text.trim()) && isZeroOrMissingUsageSnapshot(message2.usage));\n}',
    'function isZeroUsageEmptyStopAssistantTurn(message2) {\n  return Boolean(message2 && message2.stopReason === "stop" && Array.isArray(message2.content) && (message2.content.length === 0 || hasOnlyAssistantReasoningContent(message2)) && hasZeroTokenUsageSnapshot(message2.usage));\n}\nfunction isZeroUsageVisibleStopAssistantTurn(message2) {\n  return false;\n}',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    'function isZeroUsageEmptyStopAssistantTurn(message2) {\n  return Boolean(message2 && message2.stopReason === "stop" && Array.isArray(message2.content) && (message2.content.length === 0 || hasOnlyAssistantReasoningContent(message2)) && hasZeroTokenUsageSnapshot(message2.usage));\n}\nfunction isZeroUsageVisibleStopAssistantTurn(message2) {\n  return Boolean(message2 && message2.stopReason === "stop" && Array.isArray(message2.content) && message2.content.some((block3) => block3 && typeof block3 === "object" && isAssistantTextContentType(block3.type) && typeof block3.text === "string" && block3.text.trim()) && hasZeroTokenUsageSnapshot(message2.usage));\n}',
    'function isZeroUsageEmptyStopAssistantTurn(message2) {\n  return Boolean(message2 && message2.stopReason === "stop" && Array.isArray(message2.content) && (message2.content.length === 0 || hasOnlyAssistantReasoningContent(message2)) && hasZeroTokenUsageSnapshot(message2.usage));\n}\nfunction isZeroUsageVisibleStopAssistantTurn(message2) {\n  return false;\n}',
  );
  content = result.content;
  changed ||= result.changed;

  if (!content.includes('function resolveZeroUsageVisibleStopRetryInstruction(params) {')) {
    result = replaceOnce(
      content,
      'function resolveEmptyResponseRetryInstruction(params) {\n  if (shouldSkipNonVisibleTurnRetry(params)) return null;\n  if (!isEmptyResponseAssistantTurn({\n    payloadCount: params.payloadCount,\n    attempt: params.attempt\n  })) return null;\n  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant ?? null;\n  if (assistant?.stopReason === "stop" && OLLAMA_INCOMPLETE_TURN_PROVIDER_ID_PATTERN.test(normalizeLowercaseStringOrEmpty(params.provider ?? "")) && !hasPositiveOutputTokenUsage(assistant)) return null;\n  if (shouldApplyNonVisibleTurnRetryGuard({\n    provider: params.provider,\n    modelId: params.modelId,\n    modelApi: params.modelApi,\n    executionContract: params.executionContract\n  }) || isZeroUsageEmptyStopAssistantTurn(assistant)) return EMPTY_RESPONSE_RETRY_INSTRUCTION;\n  return null;\n}',
      'function resolveEmptyResponseRetryInstruction(params) {\n  if (shouldSkipNonVisibleTurnRetry(params)) return null;\n  if (!isEmptyResponseAssistantTurn({\n    payloadCount: params.payloadCount,\n    attempt: params.attempt\n  })) return null;\n  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant ?? null;\n  if (assistant?.stopReason === "stop" && OLLAMA_INCOMPLETE_TURN_PROVIDER_ID_PATTERN.test(normalizeLowercaseStringOrEmpty(params.provider ?? "")) && !hasPositiveOutputTokenUsage(assistant)) return null;\n  if (shouldApplyNonVisibleTurnRetryGuard({\n    provider: params.provider,\n    modelId: params.modelId,\n    modelApi: params.modelApi,\n    executionContract: params.executionContract\n  }) || isZeroUsageEmptyStopAssistantTurn(assistant)) return EMPTY_RESPONSE_RETRY_INSTRUCTION;\n  return null;\n}\nfunction resolveZeroUsageVisibleStopRetryInstruction(params) {\n  if (params.timedOut) return null;\n  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant ?? null;\n  if (!isZeroUsageVisibleStopAssistantTurn(assistant)) return null;\n  if (hasOnlySilentAssistantReply(params.attempt.assistantTexts)) return null;\n  if (hasCommittedMessagingToolDeliveryEvidence(params.attempt)) return null;\n  if (hasAcceptedSessionSpawn(params.attempt.acceptedSessionSpawns)) return null;\n  if (params.attempt.clientToolCalls || params.attempt.yieldDetected || params.attempt.didSendDeterministicApprovalPrompt || params.attempt.lastToolError || resolveAttemptReplayMetadata(params.attempt).hadPotentialSideEffects) return null;\n  if (!shouldApplyNonVisibleTurnRetryGuard({\n    provider: params.provider,\n    modelId: params.modelId,\n    modelApi: params.modelApi,\n    executionContract: params.executionContract\n  })) return null;\n  return "The previous attempt recorded a partial assistant sentence with zero model token usage before taking the next action. Continue from the current state and perform the promised next action now. Do not restart from scratch, repeat completed work, or summarize instead of acting.";\n}',
    );
    content = result.content;
    changed ||= result.changed;
  }

  result = replaceOnce(
    content,
    'function resolveZeroUsageVisibleStopRetryInstruction(params) {\n  if (params.aborted || params.timedOut) return null;\n  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant ?? null;\n  if (!isZeroUsageVisibleStopAssistantTurn(assistant)) return null;\n  if (hasOnlySilentAssistantReply(params.attempt.assistantTexts)) return null;\n  if (hasCommittedMessagingToolDeliveryEvidence(params.attempt)) return null;\n  if (hasAcceptedSessionSpawn(params.attempt.acceptedSessionSpawns)) return null;\n  if (!shouldApplyNonVisibleTurnRetryGuard({\n    provider: params.provider,\n    modelId: params.modelId,\n    modelApi: params.modelApi,\n    executionContract: params.executionContract\n  })) return null;\n  return "The previous attempt recorded a partial assistant sentence with zero model token usage. Continue from the current state and perform the promised next action now. Do not restart from scratch, repeat completed work, or summarize instead of acting.";\n}',
    'function resolveZeroUsageVisibleStopRetryInstruction(params) {\n  if (params.timedOut) return null;\n  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant ?? null;\n  if (!isZeroUsageVisibleStopAssistantTurn(assistant)) return null;\n  if (hasOnlySilentAssistantReply(params.attempt.assistantTexts)) return null;\n  if (hasCommittedMessagingToolDeliveryEvidence(params.attempt)) return null;\n  if (hasAcceptedSessionSpawn(params.attempt.acceptedSessionSpawns)) return null;\n  if (params.attempt.clientToolCalls || params.attempt.yieldDetected || params.attempt.didSendDeterministicApprovalPrompt || params.attempt.lastToolError || resolveAttemptReplayMetadata(params.attempt).hadPotentialSideEffects) return null;\n  if (!shouldApplyNonVisibleTurnRetryGuard({\n    provider: params.provider,\n    modelId: params.modelId,\n    modelApi: params.modelApi,\n    executionContract: params.executionContract\n  })) return null;\n  return "The previous attempt recorded a partial assistant sentence with zero or missing model token usage before taking the next action. Continue from the current state and perform the promised next action now. Do not restart from scratch, repeat completed work, or summarize instead of acting.";\n}',
  );
  content = result.content;
  changed ||= result.changed;

  result = collapseOnce(
    content,
    'function resolveZeroUsageVisibleStopRetryInstruction(params) {\n  if (params.timedOut) return null;\n  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant ?? null;\n  if (!isZeroUsageVisibleStopAssistantTurn(assistant)) return null;\n  if (hasOnlySilentAssistantReply(params.attempt.assistantTexts)) return null;\n  if (hasCommittedMessagingToolDeliveryEvidence(params.attempt)) return null;\n  if (hasAcceptedSessionSpawn(params.attempt.acceptedSessionSpawns)) return null;\n  if (params.attempt.clientToolCalls || params.attempt.yieldDetected || params.attempt.didSendDeterministicApprovalPrompt || params.attempt.lastToolError || resolveAttemptReplayMetadata(params.attempt).hadPotentialSideEffects) return null;\n  if (!shouldApplyNonVisibleTurnRetryGuard({\n    provider: params.provider,\n    modelId: params.modelId,\n    modelApi: params.modelApi,\n    executionContract: params.executionContract\n  })) return null;\n  return "The previous attempt recorded a partial assistant sentence with zero or missing model token usage before taking the next action. Continue from the current state and perform the promised next action now. Do not restart from scratch, repeat completed work, or summarize instead of acting.";\n}\nfunction resolveZeroUsageVisibleStopRetryInstruction(params) {\n  if (params.aborted || params.timedOut) return null;\n  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant ?? null;\n  if (!isZeroUsageVisibleStopAssistantTurn(assistant)) return null;\n  if (hasOnlySilentAssistantReply(params.attempt.assistantTexts)) return null;\n  if (hasCommittedMessagingToolDeliveryEvidence(params.attempt)) return null;\n  if (hasAcceptedSessionSpawn(params.attempt.acceptedSessionSpawns)) return null;\n  if (!shouldApplyNonVisibleTurnRetryGuard({\n    provider: params.provider,\n    modelId: params.modelId,\n    modelApi: params.modelApi,\n    executionContract: params.executionContract\n  })) return null;\n  return "The previous attempt recorded a partial assistant sentence with zero model token usage. Continue from the current state and perform the promised next action now. Do not restart from scratch, repeat completed work, or summarize instead of acting.";\n}',
    'function resolveZeroUsageVisibleStopRetryInstruction(params) {\n  if (params.timedOut) return null;\n  const assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant ?? null;\n  if (!isZeroUsageVisibleStopAssistantTurn(assistant)) return null;\n  if (hasOnlySilentAssistantReply(params.attempt.assistantTexts)) return null;\n  if (hasCommittedMessagingToolDeliveryEvidence(params.attempt)) return null;\n  if (hasAcceptedSessionSpawn(params.attempt.acceptedSessionSpawns)) return null;\n  if (params.attempt.clientToolCalls || params.attempt.yieldDetected || params.attempt.didSendDeterministicApprovalPrompt || params.attempt.lastToolError || resolveAttemptReplayMetadata(params.attempt).hadPotentialSideEffects) return null;\n  if (!shouldApplyNonVisibleTurnRetryGuard({\n    provider: params.provider,\n    modelId: params.modelId,\n    modelApi: params.modelApi,\n    executionContract: params.executionContract\n  })) return null;\n  return "The previous attempt recorded a partial assistant sentence with zero or missing model token usage before taking the next action. Continue from the current state and perform the promised next action now. Do not restart from scratch, repeat completed work, or summarize instead of acting.";\n}',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    '          if (!nextReasoningOnlyRetryInstruction && nextEmptyResponseRetryInstruction && emptyResponseRetryAttempts < maxEmptyResponseRetryAttempts) {\n            emptyResponseRetryAttempts += 1;\n            emptyResponseRetryInstruction = nextEmptyResponseRetryInstruction;\n            log41.warn(`empty response detected: runId=${params.runId} sessionId=${params.sessionId} provider=${activeErrorContext.provider}/${activeErrorContext.model} — retrying ${emptyResponseRetryAttempts}/${maxEmptyResponseRetryAttempts} with visible-answer continuation`);\n            continue;\n          }',
    '          const zeroUsageVisibleStopRetryInstruction = emptyAssistantReplyIsSilent ? null : resolveZeroUsageVisibleStopRetryInstruction({\n            provider: activeErrorContext.provider,\n            modelId: activeErrorContext.model,\n            modelApi: effectiveModel.api,\n            executionContract,\n            aborted: aborted3,\n            timedOut,\n            attempt\n          });\n          const emptyOrZeroUsageRetryInstruction = nextEmptyResponseRetryInstruction || zeroUsageVisibleStopRetryInstruction;\n          if (!nextReasoningOnlyRetryInstruction && emptyOrZeroUsageRetryInstruction && emptyResponseRetryAttempts < maxEmptyResponseRetryAttempts) {\n            emptyResponseRetryAttempts += 1;\n            emptyResponseRetryInstruction = emptyOrZeroUsageRetryInstruction;\n            log41.warn(`${zeroUsageVisibleStopRetryInstruction ? "zero/missing-usage visible stop" : "empty response"} detected: runId=${params.runId} sessionId=${params.sessionId} provider=${activeErrorContext.provider}/${activeErrorContext.model} — retrying ${emptyResponseRetryAttempts}/${maxEmptyResponseRetryAttempts} with visible-answer continuation`);\n            continue;\n          }',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    '          if (!nextReasoningOnlyRetryInstruction && nextEmptyResponseRetryInstruction && emptyResponseRetryAttempts < maxEmptyResponseRetryAttempts) {\n            emptyResponseRetryAttempts += 1;\n            emptyResponseRetryInstruction = nextEmptyResponseRetryInstruction;\n            log41.warn(`empty response detected: runId=${params.runId} sessionId=${params.sessionId} provider=${activeErrorContext.provider}/${activeErrorContext.model} \\u2014 retrying ${emptyResponseRetryAttempts}/${maxEmptyResponseRetryAttempts} with visible-answer continuation`);\n            continue;\n          }',
    '          const zeroUsageVisibleStopRetryInstruction = emptyAssistantReplyIsSilent ? null : resolveZeroUsageVisibleStopRetryInstruction({\n            provider: activeErrorContext.provider,\n            modelId: activeErrorContext.model,\n            modelApi: effectiveModel.api,\n            executionContract,\n            aborted: aborted3,\n            timedOut,\n            attempt\n          });\n          const emptyOrZeroUsageRetryInstruction = nextEmptyResponseRetryInstruction || zeroUsageVisibleStopRetryInstruction;\n          if (!nextReasoningOnlyRetryInstruction && emptyOrZeroUsageRetryInstruction && emptyResponseRetryAttempts < maxEmptyResponseRetryAttempts) {\n            emptyResponseRetryAttempts += 1;\n            emptyResponseRetryInstruction = emptyOrZeroUsageRetryInstruction;\n            log41.warn(`${zeroUsageVisibleStopRetryInstruction ? "zero/missing-usage visible stop" : "empty response"} detected: runId=${params.runId} sessionId=${params.sessionId} provider=${activeErrorContext.provider}/${activeErrorContext.model} \\u2014 retrying ${emptyResponseRetryAttempts}/${maxEmptyResponseRetryAttempts} with visible-answer continuation`);\n            continue;\n          }',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    '          if (\n            !nextReasoningOnlyRetryInstruction &&\n            nextEmptyResponseRetryInstruction &&\n            emptyResponseRetryAttempts < maxEmptyResponseRetryAttempts\n          ) {\n            emptyResponseRetryAttempts += 1;\n            emptyResponseRetryInstruction = nextEmptyResponseRetryInstruction;\n            log.warn(\n              `empty response detected: runId=${params.runId} sessionId=${params.sessionId} ` +\n                `provider=${activeErrorContext.provider}/${activeErrorContext.model} — retrying ${emptyResponseRetryAttempts}/${maxEmptyResponseRetryAttempts} ` +\n                `with visible-answer continuation`,\n            );\n            continue;\n          }',
    '          const zeroUsageVisibleStopRetryInstruction = emptyAssistantReplyIsSilent\n            ? null\n            : resolveZeroUsageVisibleStopRetryInstruction({\n                provider: activeErrorContext.provider,\n                modelId: activeErrorContext.model,\n                modelApi: effectiveModel.api,\n                executionContract,\n                aborted,\n                timedOut,\n                attempt,\n              });\n          const emptyOrZeroUsageRetryInstruction =\n            nextEmptyResponseRetryInstruction || zeroUsageVisibleStopRetryInstruction;\n          if (\n            !nextReasoningOnlyRetryInstruction &&\n            emptyOrZeroUsageRetryInstruction &&\n            emptyResponseRetryAttempts < maxEmptyResponseRetryAttempts\n          ) {\n            emptyResponseRetryAttempts += 1;\n            emptyResponseRetryInstruction = emptyOrZeroUsageRetryInstruction;\n            log.warn(\n              `${zeroUsageVisibleStopRetryInstruction ? "zero/missing-usage visible stop" : "empty response"} detected: runId=${params.runId} sessionId=${params.sessionId} ` +\n                `provider=${activeErrorContext.provider}/${activeErrorContext.model} — retrying ${emptyResponseRetryAttempts}/${maxEmptyResponseRetryAttempts} ` +\n                `with visible-answer continuation`,\n            );\n            continue;\n          }',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    '	return hasMessagingToolDeliveryEvidence(result) || Array.isArray(result.acceptedSessionSpawns) && hasAcceptedSessionSpawn(result.acceptedSessionSpawns) || hasPositiveNumber(result.successfulCronAdds);',
    '	return hasMessagingToolDeliveryEvidence(result) || Array.isArray(result.acceptedSessionSpawns) && hasAcceptedSessionSpawn(result.acceptedSessionSpawns) || hasPositiveNumber(result.successfulCronAdds) || Array.isArray(result.meta?.toolSummary?.tools) && result.meta.toolSummary.tools.includes("sessions_yield");',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    '  return hasMessagingToolDeliveryEvidence(result) || Array.isArray(result.acceptedSessionSpawns) && hasAcceptedSessionSpawn(result.acceptedSessionSpawns) || hasPositiveDeliveryCount(result.successfulCronAdds);',
    '  return hasMessagingToolDeliveryEvidence(result) || Array.isArray(result.acceptedSessionSpawns) && hasAcceptedSessionSpawn(result.acceptedSessionSpawns) || hasPositiveDeliveryCount(result.successfulCronAdds) || Array.isArray(result.meta?.toolSummary?.tools) && result.meta.toolSummary.tools.includes("sessions_yield");',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    '	return hasMessagingToolDeliveryEvidence(result) || Array.isArray(result.acceptedSessionSpawns) && hasAcceptedSessionSpawn(result.acceptedSessionSpawns) || hasPositiveDeliveryCount(result.successfulCronAdds);',
    '	return hasMessagingToolDeliveryEvidence(result) || Array.isArray(result.acceptedSessionSpawns) && hasAcceptedSessionSpawn(result.acceptedSessionSpawns) || hasPositiveDeliveryCount(result.successfulCronAdds) || Array.isArray(result.meta?.toolSummary?.tools) && result.meta.toolSummary.tools.includes("sessions_yield");',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    'function getGatewayAgentCommandDeliveryFailure(response) {\n  const result = getGatewayAgentResult(response);\n  return result ? getAgentCommandDeliveryFailure(result) : void 0;\n}',
    'function getGatewayAgentCommandDeliveryFailure(response) {\n  if (hasIntentionalSilentGatewayAgentPayload(response)) return void 0;\n  const result = getGatewayAgentResult(response);\n  return result ? getAgentCommandDeliveryFailure(result) : void 0;\n}',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    'function getGatewayAgentCommandDeliveryFailure(response: unknown): string | undefined {\n  const result = getGatewayAgentResult(response);\n  return result ? getAgentCommandDeliveryFailure(result) : undefined;\n}',
    'function getGatewayAgentCommandDeliveryFailure(response: unknown): string | undefined {\n  if (hasIntentionalSilentGatewayAgentPayload(response)) return undefined;\n  const result = getGatewayAgentResult(response);\n  return result ? getAgentCommandDeliveryFailure(result) : undefined;\n}',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    '    const acceptsIntentionalSilentCompletion = hasIntentionalSilentGatewayAgentPayload(directAnnounceResponse) && !isSubagentCompletion;',
    '    const acceptsIntentionalSilentCompletion = hasIntentionalSilentGatewayAgentPayload(directAnnounceResponse);',
  );
  content = result.content;
  changed ||= result.changed;

  result = replaceOnce(
    content,
    '		const acceptsIntentionalSilentCompletion = hasIntentionalSilentGatewayAgentPayload(directAnnounceResponse) && !isSubagentCompletion;',
    '		const acceptsIntentionalSilentCompletion = hasIntentionalSilentGatewayAgentPayload(directAnnounceResponse);',
  );
  content = result.content;
  changed ||= result.changed;

  // An embedded run that reaches sessions_yield has already persisted every
  // visible assistant block before the tool call. Its finalAssistantVisibleText
  // points back to that same block, while the transcript tail is now a tool
  // result/custom yield marker. Upstream mistakes that tail for a missing entry
  // and appends an identical api="cli" transcript mirror.
  const yieldedGapFillBundleBefore = `  const gapFill = params.embeddedAssistantGapFill ?? false;
  return await persistTextTurnTranscript({
    body: gapFill ? "" : params.body,
    transcriptBody: gapFill ? void 0 : params.transcriptBody,
    ...!gapFill && params.userMessage ? { userMessage: params.userMessage } : {},
    finalText: replyText,`;
  const yieldedGapFillBundleAfter = `  const gapFill = params.embeddedAssistantGapFill ?? false;
  const suppressYieldedGapFill = gapFill && params.result.meta.yielded === true;
  return await persistTextTurnTranscript({
    body: gapFill ? "" : params.body,
    transcriptBody: gapFill ? void 0 : params.transcriptBody,
    ...!gapFill && params.userMessage ? { userMessage: params.userMessage } : {},
    finalText: suppressYieldedGapFill ? "" : replyText,`;
  result = replaceOnce(content, yieldedGapFillBundleBefore, yieldedGapFillBundleAfter);
  content = result.content;
  changed ||= result.changed;

  const yieldedGapFillDistBefore = `\tconst gapFill = params.embeddedAssistantGapFill ?? false;
\treturn await persistTextTurnTranscript({
\t\tbody: gapFill ? "" : params.body,
\t\ttranscriptBody: gapFill ? void 0 : params.transcriptBody,
\t\t...!gapFill && params.userMessage ? { userMessage: params.userMessage } : {},
\t\tfinalText: replyText,`;
  const yieldedGapFillDistAfter = `\tconst gapFill = params.embeddedAssistantGapFill ?? false;
\tconst suppressYieldedGapFill = gapFill && params.result.meta.yielded === true;
\treturn await persistTextTurnTranscript({
\t\tbody: gapFill ? "" : params.body,
\t\ttranscriptBody: gapFill ? void 0 : params.transcriptBody,
\t\t...!gapFill && params.userMessage ? { userMessage: params.userMessage } : {},
\t\tfinalText: suppressYieldedGapFill ? "" : replyText,`;
  result = replaceOnce(content, yieldedGapFillDistBefore, yieldedGapFillDistAfter);
  content = result.content;
  changed ||= result.changed;

  // Older revisions of this patch treated absent usage as proof of a partial
  // stream. Normalize every generated variant after the compatibility
  // replacements above so OpenAI-compatible providers may omit usage without
  // causing a second model turn.
  const usageNormalized = content
    .replaceAll('zero/missing-usage visible stop', 'zero-usage visible stop')
    .replaceAll('zero or missing model token usage', 'zero model token usage');
  changed ||= usageNormalized !== content;
  content = usageNormalized;

  if (!changed) return false;
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function applyPatch(runtimeDir, options = {}) {
  const candidates = [
    path.join(runtimeDir, 'gateway-bundle.mjs'),
    ...walkJsFiles(path.join(runtimeDir, 'dist')),
  ].filter((filePath, index, arr) => fs.existsSync(filePath) && arr.indexOf(filePath) === index);

  const patched = [];
  for (const filePath of candidates) {
    if (patchFile(filePath)) patched.push(path.relative(runtimeDir, filePath));
  }

  const label = options.label || 'patch-openclaw-history-thinking-and-subagent-yield';
  if (patched.length > 0) {
    console.log(`[${label}] Patched history thinking/subagent yield: ${patched.join(', ')}`);
  } else if (options.verbose) {
    console.log(`[${label}] No history thinking/subagent yield patch needed.`);
  }

  return patched;
}

function verifyPatch(runtimeDir) {
  const content = fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8');
  const required = [
    'function isAssistantReasoningContentType(type)',
    'entry.type === "thinking" || entry.type === "reasoning" || entry.type === "redacted_thinking"',
    'isAssistantReasoningContentType(block3.type) && typeof block3.thinking === "string"',
    'function isZeroUsageVisibleStopAssistantTurn(message2) {\n  return false;',
    'result.meta?.toolSummary?.tools) && result.meta.toolSummary.tools.includes("sessions_yield")',
    'if (hasIntentionalSilentGatewayAgentPayload(response)) return void 0;',
    'const acceptsIntentionalSilentCompletion = hasIntentionalSilentGatewayAgentPayload(directAnnounceResponse);',
    'const suppressYieldedGapFill = gapFill && params.result.meta.yielded === true;',
    'if (isToolHistoryBlockType(entry.type)) {',
    'return hasToolHistoryBlock;',
    'promotePromptReleasedSideBranch() {',
    'async function promoteDeliveredSubagentCompletionBranch(canonicalRequesterSessionKey)',
    'if (delivery.delivered) await promoteDeliveredSubagentCompletionBranch(key);',
    'async function withSubagentCompletionAnnounceLock(key, task)',
    'async function waitForSubagentRequesterRunEnd(sessionId, timeoutMs, signal)',
    'const ensureCompletionDeliveryQueueSequence = (entry) => {',
    'const recoverSubagentCleanupFinalizeFailure = (runId) => {',
    'subagent cleanup recovery persist failed',
    'if (hasEarlierPendingCompletionDelivery(runId, entry)) {',
    '(normalizeOptionalLowercaseString(params.sourceTool) ?? "subagent_announce") === "subagent_announce"',
    'return await withSubagentCompletionAnnounceLock(key, async () => {',
    'reason: "requester_busy"',
    'steer: strictCompletion ? async () => ({ status: "dropped" })',
    'operation: "completion direct announce terminal confirmation"',
    'if (isCompletionDeliveryQueueTerminal(current)) retryDeferredCompletedAnnounces(runId)',
    'scheduleResumeSubagentRun(runId, current, resolveAnnounceRetryDelayMs(getDeliveryAttemptCount(current)))',
  ];
  const missing = required.filter(marker => !content.includes(marker));
  const distContents = walkJsFiles(path.join(runtimeDir, 'dist')).map(filePath => ({
    filePath,
    content: fs.readFileSync(filePath, 'utf8'),
  }));
  const distRequirements = [
    {
      name: 'history tool-call projection',
      marker: 'return hasToolHistoryBlock;',
    },
    {
      name: 'yielded embedded transcript gap-fill suppression',
      marker: 'const suppressYieldedGapFill = gapFill && params.result.meta.yielded === true;',
    },
    {
      name: 'completion side-branch leaf promotion',
      marker: 'promotePromptReleasedSideBranch() {',
    },
    {
      name: 'completion outer-delivery leaf promotion',
      marker: 'if (delivery.delivered) await promoteDeliveredSubagentCompletionBranch(key);',
    },
    {
      name: 'completion announce FIFO/abort',
      marker: 'async function waitForSubagentRequesterRunEnd(sessionId, timeoutMs, signal)',
    },
    {
      name: 'persistent completion delivery queue',
      marker: 'const ensureCompletionDeliveryQueueSequence = (entry) => {',
    },
    {
      name: 'cleanup recovery helper',
      marker: 'const recoverSubagentCleanupFinalizeFailure = (runId) => {',
    },
    {
      name: 'non-terminal direct announce confirmation',
      marker: 'operation: "completion direct announce terminal confirmation"',
    },
    {
      name: 'cleanup failure rescheduling',
      marker:
        'scheduleResumeSubagentRun(runId, current, resolveAnnounceRetryDelayMs(getDeliveryAttemptCount(current)))',
    },
    {
      name: 'cleanup failure deferred wake',
      marker:
        'if (isCompletionDeliveryQueueTerminal(current)) retryDeferredCompletedAnnounces(runId)',
    },
  ];
  for (const requirement of distRequirements) {
    if (!distContents.some(entry => entry.content.includes(requirement.marker))) {
      missing.push(`dist ${requirement.name}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `History thinking and subagent yield patch is incomplete: ${missing.join(', ')}`,
    );
  }
  return true;
}

module.exports = { applyPatch, verifyPatch };
