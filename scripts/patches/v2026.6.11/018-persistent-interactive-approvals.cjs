'use strict';

// Purpose: Keep user-facing approvals pending until the user decides, and
// detach webchat exec approvals from the originating agent run so approval
// latency cannot consume that run's provider lifetime. The detached completion
// prompt drives the resumed turn without being persisted as a user message.
// Affected OpenClaw version: v2026.6.11.
// Risk: Interactive approvals can remain in memory for the lifetime of the
// Gateway process, and approved webchat exec commands resume in a fresh turn.
// Remove when: OpenClaw supports non-expiring interactive approvals and
// suspends/resumes agent turns across approval decisions without consuming the
// originating run timeout.
// Upstream tracking: TODO(openclaw): file an upstream approval suspension issue.
// Temporary: yes.

const fs = require('fs');
const path = require('path');

const PATCH_MARKER = 'JUSTDO_PERSISTENT_INTERACTIVE_APPROVALS';
const PATCH_REVISION_MARKER = 'JUSTDO_PERSISTENT_INTERACTIVE_APPROVALS_V2';
const PATCH_SOURCE_GUARD_MARKER = 'JUSTDO_PERSISTENT_INTERACTIVE_APPROVALS_V3';
const PATCH_ABORT_SEMANTICS_MARKER = 'JUSTDO_PERSISTENT_INTERACTIVE_APPROVALS_V4';
const PATCH_ABORT_RACE_GUARD_MARKER = 'JUSTDO_PERSISTENT_INTERACTIVE_APPROVALS_V5';
const PATCH_HIDDEN_FOLLOWUP_PROMPT_MARKER = 'JUSTDO_PERSISTENT_INTERACTIVE_APPROVALS_V6';
const PATCH_SUSPENDED_ORIGINAL_REPLY_MARKER = 'JUSTDO_PERSISTENT_INTERACTIVE_APPROVALS_V7';
const PATCH_RUN_SCOPED_SUSPENSION_MARKER = 'JUSTDO_PERSISTENT_INTERACTIVE_APPROVALS_V8';
const PATCH_LIVE_SUSPENSION_MARKER = 'JUSTDO_PERSISTENT_INTERACTIVE_APPROVALS_V9';
const PATCH_CROSS_ATTEMPT_SUSPENSION_MARKER = 'JUSTDO_PERSISTENT_INTERACTIVE_APPROVALS_V10';
const PATCH_GUARD_RUN_ID_FORWARD_MARKER = 'JUSTDO_PERSISTENT_INTERACTIVE_APPROVALS_V11';
const PATCH_FORWARDING_TIMER_MARKER = 'JUSTDO_PERSISTENT_INTERACTIVE_APPROVALS_V12';
const PATCH_STOP_CANCEL_MARKER = 'JUSTDO_PERSISTENT_INTERACTIVE_APPROVALS_V13';
const PATCH_NODE_FAILURE_GUARD_MARKER = 'JUSTDO_PERSISTENT_NODE_APPROVAL_FAILURE_GUARD';

const ORIGINAL_GATEWAY_TOOL_TIMEOUT = `  const timeoutMs = typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) ? Math.max(1, Math.floor(opts.timeoutMs)) : 3e4;`;
const PATCHED_GATEWAY_TOOL_TIMEOUT = `  // ${PATCH_REVISION_MARKER}
  const timeoutMs = opts?.timeoutMs === null
    ? null
    : typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs)
      ? Math.max(1, Math.floor(opts.timeoutMs))
      : 3e4;`;

const ORIGINAL_GATEWAY_TIMEOUT_RESOLVER = `function resolveGatewayCallTimeout(timeoutValue, configuredHandshakeTimeoutMs) {
  const hasConfiguredHandshakeTimeout = typeof configuredHandshakeTimeoutMs === "number" && Number.isFinite(configuredHandshakeTimeoutMs) && configuredHandshakeTimeoutMs > 0;`;
const PATCHED_GATEWAY_TIMEOUT_RESOLVER = `function resolveGatewayCallTimeout(timeoutValue, configuredHandshakeTimeoutMs) {
  if (timeoutValue === null) return {
    timeoutMs: null,
    safeTimerTimeoutMs: null
  };
  const hasConfiguredHandshakeTimeout = typeof configuredHandshakeTimeoutMs === "number" && Number.isFinite(configuredHandshakeTimeoutMs) && configuredHandshakeTimeoutMs > 0;`;

const ORIGINAL_GATEWAY_OUTER_TIMER = `    const timer3 = setTimeout(() => {
      ignoreClose = true;
      stop3(createGatewayTimeoutTransportError({
        timeoutMs,
        connectionDetails: params.connectionDetails
      }));
    }, safeTimerTimeoutMs);
    startGatewayClientWhenEventLoopReady(client, {
      timeoutMs: safeTimerTimeoutMs,`;
const PATCHED_GATEWAY_OUTER_TIMER = `    const timer3 = safeTimerTimeoutMs === null ? null : setTimeout(() => {
      ignoreClose = true;
      stop3(createGatewayTimeoutTransportError({
        timeoutMs,
        connectionDetails: params.connectionDetails
      }));
    }, safeTimerTimeoutMs);
    const readinessTimeoutMs = safeTimerTimeoutMs === null
      ? resolveSafeTimeoutDelayMs(preauthHandshakeTimeoutMs ?? 1e4)
      : safeTimerTimeoutMs;
    startGatewayClientWhenEventLoopReady(client, {
      timeoutMs: readinessTimeoutMs,`;

const ORIGINAL_APPROVAL_TIMEOUT_HELPER = `function resolveApprovalTimeoutMs(timeoutMs) {
  return resolveTimerTimeoutMs(timeoutMs, 1);
}`;
const V2_PATCHED_APPROVAL_TIMEOUT_HELPER = `// ${PATCH_MARKER}
const JUSTDO_PERSISTENT_APPROVAL_EXPIRES_AT_MS = Number.MAX_SAFE_INTEGER;
function isJustDoPersistentInteractiveApprovalRequest(request) {
  const sessionKey = normalizeOptionalString(request?.sessionKey);
  if (!sessionKey || isCronSessionKey(sessionKey)) return false;
  const channel = normalizeLowercaseStringOrEmpty(request?.turnSourceChannel);
  return channel === "" || channel === "webchat" || channel === "justdo";
}
function isJustDoPersistentInteractiveApprovalRecord(record) {
  return isJustDoPersistentInteractiveApprovalRequest(record?.request);
}
function resolveApprovalTimeoutMs(timeoutMs) {
  return resolveTimerTimeoutMs(timeoutMs, 1);
}`;
const V3_PATCHED_APPROVAL_TIMEOUT_HELPER = `// ${PATCH_MARKER}
// ${PATCH_SOURCE_GUARD_MARKER}
const JUSTDO_PERSISTENT_APPROVAL_EXPIRES_AT_MS = Number.MAX_SAFE_INTEGER;
function isJustDoPersistentInteractiveSessionKey(sessionKey) {
  const normalized = normalizeOptionalString(sessionKey);
  return Boolean(normalized && !isCronSessionKey(normalized) && normalized.toLowerCase().includes(":justdo:"));
}
function isJustDoPersistentInteractiveApprovalRequest(request) {
  const sessionKey = normalizeOptionalString(request?.sessionKey);
  if (!sessionKey || isCronSessionKey(sessionKey)) return false;
  const channel = normalizeLowercaseStringOrEmpty(request?.turnSourceChannel);
  return channel === "webchat" || channel === "justdo" || channel === "" && isJustDoPersistentInteractiveSessionKey(sessionKey);
}
function isJustDoPersistentInteractiveApprovalRecord(record) {
  return isJustDoPersistentInteractiveApprovalRequest(record?.request);
}
function resolveApprovalTimeoutMs(timeoutMs) {
  return resolveTimerTimeoutMs(timeoutMs, 1);
}`;
const PATCHED_APPROVAL_TIMEOUT_HELPER = `// ${PATCH_MARKER}
// ${PATCH_SOURCE_GUARD_MARKER}
// ${PATCH_ABORT_SEMANTICS_MARKER}
const JUSTDO_PERSISTENT_APPROVAL_EXPIRES_AT_MS = Number.MAX_SAFE_INTEGER;
function isJustDoPersistentInteractiveSessionKey(sessionKey) {
  const normalized = normalizeOptionalString(sessionKey);
  return Boolean(normalized && !isCronSessionKey(normalized) && normalized.toLowerCase().includes(":justdo:"));
}
function isJustDoAutomaticRunTimeoutAbortReason(reason) {
  return reason instanceof Error && reason.name === "TimeoutError" && reason.message === "chat run timed out";
}
function isJustDoPersistentInteractiveApprovalRequest(request) {
  const sessionKey = normalizeOptionalString(request?.sessionKey);
  if (!sessionKey || isCronSessionKey(sessionKey)) return false;
  const channel = normalizeLowercaseStringOrEmpty(request?.turnSourceChannel);
  return channel === "webchat" || channel === "justdo" || channel === "" && isJustDoPersistentInteractiveSessionKey(sessionKey);
}
function isJustDoPersistentInteractiveApprovalRecord(record) {
  return isJustDoPersistentInteractiveApprovalRequest(record?.request);
}
function resolveApprovalTimeoutMs(timeoutMs) {
  return resolveTimerTimeoutMs(timeoutMs, 1);
}`;

const ORIGINAL_APPROVAL_CREATE = `      create(request5, timeoutMs, id) {
        const now = Date.now();
        const expiresAtMs = resolveExpiresAtMsFromDurationMs(resolveApprovalTimeoutMs(timeoutMs), { nowMs: now });
        if (expiresAtMs === void 0) throw new Error("approval expiry is unavailable");`;
const PATCHED_APPROVAL_CREATE = `      create(request5, timeoutMs, id) {
        const now = Date.now();
        const expiresAtMs = isJustDoPersistentInteractiveApprovalRequest(request5)
          ? JUSTDO_PERSISTENT_APPROVAL_EXPIRES_AT_MS
          : resolveExpiresAtMsFromDurationMs(resolveApprovalTimeoutMs(timeoutMs), { nowMs: now });
        if (expiresAtMs === void 0) throw new Error("approval expiry is unavailable");`;

const ORIGINAL_APPROVAL_REGISTER_TIMER = `        const timerDelayMs = resolveApprovalTimeoutMs(timeoutMs);
        entry.timer = setTimeout(() => {
          this.expire(record3.id);
        }, timerDelayMs);`;
const PATCHED_APPROVAL_REGISTER_TIMER = `        if (!isJustDoPersistentInteractiveApprovalRecord(record3)) {
          const timerDelayMs = resolveApprovalTimeoutMs(timeoutMs);
          entry.timer = setTimeout(() => {
            this.expire(record3.id);
          }, timerDelayMs);
        }`;

const ORIGINAL_EXEC_WAIT = `return parseDecision(await callGatewayTool("exec.approval.waitDecision", { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS }, { id: params.approvalId })).value;`;
const PATCHED_EXEC_WAIT = `return parseDecision(await callGatewayTool("exec.approval.waitDecision", { timeoutMs: null }, { id: params.approvalId })).value;`;

const ORIGINAL_PLUGIN_TOOL_WAIT = `const waitPromise = callGatewayTool("plugin.approval.waitDecision", { timeoutMs: gatewayTimeoutMs }, { id });`;
const V2_PATCHED_PLUGIN_TOOL_WAIT = `const waitPromise = callGatewayTool("plugin.approval.waitDecision", {
        timeoutMs: params.ctx?.sessionKey && !isCronSessionKey(params.ctx.sessionKey) ? null : gatewayTimeoutMs
      }, { id });`;
const PATCHED_PLUGIN_TOOL_WAIT = `const waitPromise = callGatewayTool("plugin.approval.waitDecision", {
        timeoutMs: isJustDoPersistentInteractiveSessionKey(params.ctx?.sessionKey) ? null : gatewayTimeoutMs
      }, { id });`;

const ORIGINAL_NATIVE_HOOK_WAIT = `const waitPromise = callGatewayTool("plugin.approval.waitDecision", { timeoutMs: params.timeoutMs + 1e4 }, { id: params.approvalId });`;
const V2_PATCHED_NATIVE_HOOK_WAIT = `const waitPromise = callGatewayTool("plugin.approval.waitDecision", {
    timeoutMs: params.sessionKey && !isCronSessionKey(params.sessionKey) ? null : params.timeoutMs + 1e4
  }, { id: params.approvalId });`;
const PATCHED_NATIVE_HOOK_WAIT = `const waitPromise = callGatewayTool("plugin.approval.waitDecision", {
    timeoutMs: isJustDoPersistentInteractiveSessionKey(params.sessionKey) ? null : params.timeoutMs + 1e4
  }, { id: params.approvalId });`;

const ORIGINAL_NATIVE_HOOK_SIGNAL_WAIT = `  if (!params.signal) return waitPromise;`;
const V3_PATCHED_NATIVE_HOOK_SIGNAL_WAIT = `  if (isJustDoPersistentInteractiveSessionKey(params.sessionKey) || !params.signal) return waitPromise;`;
const ORIGINAL_NATIVE_HOOK_ABORT_BLOCK = `    if (params.signal.aborted) {
      reject(toErrorObject(params.signal.reason, "Non-Error rejection"));
      return;
    }
    onAbort = () => reject(toErrorObject(params.signal.reason, "Non-Error rejection"));`;
const V4_PATCHED_NATIVE_HOOK_ABORT_BLOCK = `    if (params.signal.aborted) {
      if (!isJustDoAutomaticRunTimeoutAbortReason(params.signal.reason)) {
        void callGatewayTool("plugin.approval.resolve", { timeoutMs: 15e3 }, {
          id: params.approvalId,
          decision: PluginApprovalResolutions.DENY
        }).catch(() => reject(toErrorObject(params.signal.reason, "Non-Error rejection")));
      }
      return;
    }
    onAbort = () => {
      if (isJustDoAutomaticRunTimeoutAbortReason(params.signal.reason)) return;
      void callGatewayTool("plugin.approval.resolve", { timeoutMs: 15e3 }, {
        id: params.approvalId,
        decision: PluginApprovalResolutions.DENY
      }).catch(() => reject(toErrorObject(params.signal.reason, "Non-Error rejection")));
    };`;
const PATCHED_NATIVE_HOOK_ABORT_BLOCK = `    const rejectForExplicitAbort = () => {
      // ${PATCH_ABORT_RACE_GUARD_MARKER}
      reject(toErrorObject(params.signal.reason, "Non-Error rejection"));
      void callGatewayTool("plugin.approval.resolve", { timeoutMs: 15e3 }, {
        id: params.approvalId,
        decision: PluginApprovalResolutions.DENY
      }).catch(() => void 0);
    };
    if (params.signal.aborted) {
      if (!isJustDoAutomaticRunTimeoutAbortReason(params.signal.reason)) rejectForExplicitAbort();
      return;
    }
    onAbort = () => {
      if (isJustDoAutomaticRunTimeoutAbortReason(params.signal.reason)) return;
      rejectForExplicitAbort();
    };`;

const ORIGINAL_NATIVE_HOOK_WAIT_ARGS = `    approvalId,
    signal: request5.signal,
    timeoutMs`;
const PATCHED_NATIVE_HOOK_WAIT_ARGS = `    approvalId,
    signal: request5.signal,
    sessionKey: request5.sessionKey,
    timeoutMs`;

const ORIGINAL_INLINE_EXEC_APPROVAL = `function shouldAwaitGatewayApprovalInline(params) {
  if (params.approvalFollowupMode !== void 0) return false;
  return isNativeApprovalChannel(normalizeMessageChannel2(params.turnSourceChannel));
}`;
const PATCHED_INLINE_EXEC_APPROVAL = `function shouldAwaitGatewayApprovalInline(params) {
  if (params.approvalFollowupMode !== void 0) return false;
  const channel = normalizeMessageChannel2(params.turnSourceChannel);
  if (channel === "webchat") return false;
  return isNativeApprovalChannel(channel);
}`;

const ORIGINAL_ASYNC_APPROVAL_FAILURE_FOLLOWUP = `const approvalDecision = await resolveApprovalForExecution(() => void sendExecApprovalFollowupResult(followupTarget, \`Exec denied (gateway id=\${approvalId}, approval-request-failed): \${params.command}\`));`;
const PATCHED_ASYNC_APPROVAL_FAILURE_FOLLOWUP = `const approvalDecision = await resolveApprovalForExecution(() => void 0);`;

const ORIGINAL_ASYNC_NODE_APPROVAL_FAILURE_FOLLOWUP = `onFailure: () => void sendExecApprovalFollowupResult(followupTarget, \`Exec denied (node=\${target.nodeId} id=\${approvalId}, approval-request-failed): \${params.command}\`)`;
const PATCHED_ASYNC_NODE_APPROVAL_FAILURE_FOLLOWUP = `onFailure: () => {
              // ${PATCH_NODE_FAILURE_GUARD_MARKER}
            }`;

const ORIGINAL_AGENT_FOLLOWUP_ARGS = `  return {
    sessionKey: params.sessionKey,
    message: buildExecApprovalFollowupPrompt(params.resultText),`;
const PATCHED_AGENT_FOLLOWUP_ARGS = `  return {
    // ${PATCH_HIDDEN_FOLLOWUP_PROMPT_MARKER}
    sessionKey: params.sessionKey,
    message: buildExecApprovalFollowupPrompt(params.resultText),
    suppressPromptPersistence: true,`;

const ORIGINAL_ASSISTANT_PERSISTENCE = `    if (finalRole === "assistant" && toolCalls.length === 0 && opts?.suppressTranscriptOnlyAssistantPersistence === true) return;`;
const PATCHED_ASSISTANT_PERSISTENCE = `    const suppressSuspendedJustDoOriginalReply = (() => {
      // ${PATCH_SUSPENDED_ORIGINAL_REPLY_MARKER}
      if (opts?.suppressNextUserMessagePersistence === true) return false;
      const sessionKey = typeof opts?.sessionKey === "string" ? opts.sessionKey.toLowerCase() : "";
      if (!sessionKey.includes(":justdo:")) return false;
      const leafMessage = sessionManager.getLeafEntry?.()?.message;
      return leafMessage?.role === "toolResult" && leafMessage.details?.status === "approval-pending";
    })();
    if (finalRole === "assistant" && toolCalls.length === 0 && suppressSuspendedJustDoOriginalReply) return;
    if (finalRole === "assistant" && toolCalls.length === 0 && opts?.suppressTranscriptOnlyAssistantPersistence === true) return;`;

const ORIGINAL_SUSPENSION_STATE = `  let suppressNextUserMessagePersistence = opts?.suppressNextUserMessagePersistence === true;`;
const PATCHED_SUSPENSION_STATE = `  let suppressNextUserMessagePersistence = opts?.suppressNextUserMessagePersistence === true;
  // ${PATCH_RUN_SCOPED_SUSPENSION_MARKER}
  let suppressSuspendedJustDoOriginalReply = false;`;

const ORIGINAL_APPROVAL_PENDING_LATCH = `    if (nextRole === "toolResult") {
      const id = extractToolResultId(nextMessage);
      const toolName3 = id ? pendingState.getToolName(id) : void 0;`;
const PATCHED_APPROVAL_PENDING_LATCH = `    if (nextRole === "toolResult") {
      const id = extractToolResultId(nextMessage);
      const toolName3 = id ? pendingState.getToolName(id) : void 0;
      const sessionKey = typeof opts?.sessionKey === "string" ? opts.sessionKey.toLowerCase() : "";
      if (sessionKey.includes(":justdo:") && nextMessage.details?.status === "approval-pending") {
        suppressSuspendedJustDoOriginalReply = true;
      }`;

const PATCHED_RUN_SCOPED_ASSISTANT_PERSISTENCE = `    // ${PATCH_SUSPENDED_ORIGINAL_REPLY_MARKER}
    if (finalRole === "assistant" && toolCalls.length === 0 && suppressSuspendedJustDoOriginalReply) return;
    if (finalRole === "assistant" && toolCalls.length === 0 && opts?.suppressTranscriptOnlyAssistantPersistence === true) return;`;

const ORIGINAL_LIVE_APPROVAL_PENDING_LATCH = `  if (!isToolError && approvalPending) {
    if (!ctx.params.onToolResult) return;`;
const PATCHED_LIVE_APPROVAL_PENDING_LATCH = `  if (!isToolError && approvalPending) {
    // ${PATCH_LIVE_SUSPENSION_MARKER}
    const sessionKey = typeof ctx.params.sessionKey === "string" ? ctx.params.sessionKey.toLowerCase() : "";
    if (sessionKey.includes(":justdo:")) ctx.state.justDoApprovalSuspended = true;
    if (!ctx.params.onToolResult) return;`;

const ORIGINAL_LIVE_ASSISTANT_SUPPRESSION = `function shouldSuppressDeterministicApprovalOutput(state5) {
  return state5.deterministicApprovalPromptPending || state5.deterministicApprovalPromptSent;
}`;
const PATCHED_LIVE_ASSISTANT_SUPPRESSION = `function shouldSuppressDeterministicApprovalOutput(state5) {
  return state5.justDoApprovalSuspended === true || state5.deterministicApprovalPromptPending || state5.deterministicApprovalPromptSent;
}`;

const ORIGINAL_SUSPENDED_RUN_HELPERS = `function installSessionToolResultGuard(sessionManager, opts) {`;
const PATCHED_SUSPENDED_RUN_HELPERS = `// ${PATCH_CROSS_ATTEMPT_SUSPENSION_MARKER}
const JUSTDO_SUSPENDED_APPROVAL_RUN_TTL_MS = 2 * 60 * 60 * 1e3;
const justDoSuspendedApprovalRunTimers = new Map();
function markJustDoSuspendedApprovalRun(runId) {
  if (typeof runId !== "string" || !runId.trim()) return;
  const normalized = runId.trim();
  const previous = justDoSuspendedApprovalRunTimers.get(normalized);
  if (previous) clearTimeout(previous);
  const timer3 = setTimeout(() => justDoSuspendedApprovalRunTimers.delete(normalized), JUSTDO_SUSPENDED_APPROVAL_RUN_TTL_MS);
  timer3.unref?.();
  justDoSuspendedApprovalRunTimers.set(normalized, timer3);
}
function isJustDoSuspendedApprovalRun(runId) {
  return typeof runId === "string" && justDoSuspendedApprovalRunTimers.has(runId.trim());
}
function installSessionToolResultGuard(sessionManager, opts) {`;
const PATCHED_CROSS_ATTEMPT_SUSPENSION_STATE = `  let suppressNextUserMessagePersistence = opts?.suppressNextUserMessagePersistence === true;
  // ${PATCH_RUN_SCOPED_SUSPENSION_MARKER}`;
const PATCHED_CROSS_ATTEMPT_APPROVAL_PENDING_LATCH = `    if (nextRole === "toolResult") {
      const id = extractToolResultId(nextMessage);
      const toolName3 = id ? pendingState.getToolName(id) : void 0;
      const sessionKey = typeof opts?.sessionKey === "string" ? opts.sessionKey.toLowerCase() : "";
      if (sessionKey.includes(":justdo:") && nextMessage.details?.status === "approval-pending") {
        markJustDoSuspendedApprovalRun(opts?.runId);
      }`;
const PATCHED_CROSS_ATTEMPT_ASSISTANT_PERSISTENCE = `    // ${PATCH_SUSPENDED_ORIGINAL_REPLY_MARKER}
    if (finalRole === "assistant" && toolCalls.length === 0 && isJustDoSuspendedApprovalRun(opts?.runId)) return;
    if (finalRole === "assistant" && toolCalls.length === 0 && opts?.suppressTranscriptOnlyAssistantPersistence === true) return;`;
const ORIGINAL_GUARD_RUN_ID = `        suppressNextUserMessagePersistence: params.suppressNextUserMessagePersistence,`;
const PATCHED_GUARD_RUN_ID = `        runId: params.runId,
        suppressNextUserMessagePersistence: params.suppressNextUserMessagePersistence,`;
const PATCHED_CROSS_ATTEMPT_LIVE_LATCH = `  if (!isToolError && approvalPending) {
    // ${PATCH_LIVE_SUSPENSION_MARKER}
    const sessionKey = typeof ctx.params.sessionKey === "string" ? ctx.params.sessionKey.toLowerCase() : "";
    if (sessionKey.includes(":justdo:")) {
      markJustDoSuspendedApprovalRun(ctx.params.runId);
      ctx.state.justDoApprovalSuspended = true;
    }
    if (!ctx.params.onToolResult) return;`;
const ORIGINAL_LIVE_STATE_INIT = `    deterministicApprovalPromptSent: false`;
const PATCHED_LIVE_STATE_INIT = `    deterministicApprovalPromptSent: false,
    justDoApprovalSuspended: isJustDoSuspendedApprovalRun(params.runId)`;
const ORIGINAL_TERMINAL_APPROVAL_SUPPRESSION = `        didDeliverSourceReplyViaMessageTool,
        didSendDeterministicApprovalPrompt: didSendDeterministicApprovalPromptNow,
        messagingToolSentTexts: getMessagingToolSentTexts(),`;
const PATCHED_TERMINAL_APPROVAL_SUPPRESSION = `        didDeliverSourceReplyViaMessageTool,
        didSendDeterministicApprovalPrompt: didSendDeterministicApprovalPromptNow || isJustDoSuspendedApprovalRun(params.runId),
        messagingToolSentTexts: getMessagingToolSentTexts(),`;
const ORIGINAL_REASONING_SUSPENSION = `  const emitReasoningStream = (text2) => {
    if (params.silentExpected) return;`;
const PATCHED_REASONING_SUSPENSION = `  const emitReasoningStream = (text2) => {
    if (params.silentExpected || state5.justDoApprovalSuspended === true) return;`;
const ORIGINAL_INSTALL_GUARD_RUN_ID = `  const guard = installSessionToolResultGuard(sessionManager, {
    sessionKey: opts?.sessionKey,`;
const PATCHED_INSTALL_GUARD_RUN_ID = `  const guard = installSessionToolResultGuard(sessionManager, {
    // ${PATCH_GUARD_RUN_ID_FORWARD_MARKER}
    runId: opts?.runId,
    sessionKey: opts?.sessionKey,`;
const ORIGINAL_GATEWAY_APPROVAL_FORWARD_TIMER = `    const timeoutMs = Math.max(0, request5.expiresAtMs - nowMs4());
    const timeoutId = setTimeout(() => {
      spawn40("error handling approval expiration", handleExpired(request5.id));
    }, timeoutMs);
    timeoutId.unref?.();
    entry.timeoutId = timeoutId;`;
const PATCHED_GATEWAY_APPROVAL_FORWARD_TIMER = `    // ${PATCH_FORWARDING_TIMER_MARKER}
    if (request5.expiresAtMs !== Number.MAX_SAFE_INTEGER) {
      const timeoutMs = Math.max(0, request5.expiresAtMs - nowMs4());
      const timeoutId = setTimeout(() => {
        spawn40("error handling approval expiration", handleExpired(request5.id));
      }, timeoutMs);
      timeoutId.unref?.();
      entry.timeoutId = timeoutId;
    }`;
const ORIGINAL_APPROVAL_FORWARDER_TIMER = `    const expiresInMs = Math.max(0, params.strategy.getExpiresAtMs(request5) - params.nowMs());
    const timeoutId = setTimeout(() => {
      (async () => {
        const entry = pending.get(requestId);
        if (!entry) return;
        pending.delete(requestId);
        await deliverToTargets({
          cfg,
          targets: entry.targets,
          buildPayload: () => ({ text: params.strategy.buildExpiredText(request5) }),
          deliver: params.deliver
        });
      })().catch((err3) => {
        log90.error(\`\${params.strategy.kind} approvals: failed to deliver expiry notification for \${requestId}: \${String(err3)}\`);
      });
    }, expiresInMs);
    timeoutId.unref?.();
    const pendingEntry = {
      routeRequest,
      targets: filteredTargets,
      timeoutId
    };`;
const PATCHED_APPROVAL_FORWARDER_TIMER = `    const expiresAtMs = params.strategy.getExpiresAtMs(request5);
    const timeoutId = expiresAtMs === Number.MAX_SAFE_INTEGER ? null : setTimeout(() => {
      (async () => {
        const entry = pending.get(requestId);
        if (!entry) return;
        pending.delete(requestId);
        await deliverToTargets({
          cfg,
          targets: entry.targets,
          buildPayload: () => ({ text: params.strategy.buildExpiredText(request5) }),
          deliver: params.deliver
        });
      })().catch((err3) => {
        log90.error(\`\${params.strategy.kind} approvals: failed to deliver expiry notification for \${requestId}: \${String(err3)}\`);
      });
    }, Math.max(0, expiresAtMs - params.nowMs()));
    timeoutId?.unref?.();
    const pendingEntry = {
      // ${PATCH_FORWARDING_TIMER_MARKER}
      routeRequest,
      targets: filteredTargets,
      timeoutId
    };`;
const ORIGINAL_EXEC_APPROVAL_FOLLOWUP_SENDER = `async function sendExecApprovalFollowupResult(target, resultText, deps2 = {}) {
  const send = deps2.sendExecApprovalFollowup ?? sendExecApprovalFollowup;`;
const PATCHED_EXEC_APPROVAL_FOLLOWUP_SENDER = `const justDoStopCancelledExecApprovals = new Map();
function markJustDoStopCancelledExecApproval(approvalId) {
  const now = Date.now();
  for (const [id, expiresAtMs] of justDoStopCancelledExecApprovals) {
    if (expiresAtMs <= now) justDoStopCancelledExecApprovals.delete(id);
  }
  justDoStopCancelledExecApprovals.set(approvalId, now + 6e5);
}
function consumeJustDoStopCancelledExecApproval(approvalId) {
  const expiresAtMs = justDoStopCancelledExecApprovals.get(approvalId);
  if (expiresAtMs === void 0) return false;
  justDoStopCancelledExecApprovals.delete(approvalId);
  return expiresAtMs > Date.now();
}
async function sendExecApprovalFollowupResult(target, resultText, deps2 = {}) {
  // ${PATCH_STOP_CANCEL_MARKER}
  if (isExecDeniedResultText(resultText) && consumeJustDoStopCancelledExecApproval(target.approvalId)) return;
  const send = deps2.sendExecApprovalFollowup ?? sendExecApprovalFollowup;`;
const ORIGINAL_EXEC_APPROVAL_RESOLVE_DECISION = `    "exec.approval.resolve": async ({ params, respond, client, context }) => {
      const resolveParams = resolveApprovalDecisionParams({
        rawParams: params,
        validate: validateExecApprovalResolveParams,
        methodName: "exec.approval.resolve",
        respond
      });
      if (!resolveParams) return;
      const { inputId, decision } = resolveParams;
      await handleApprovalResolve({`;
const PATCHED_EXEC_APPROVAL_RESOLVE_DECISION = `    "exec.approval.resolve": async ({ params, respond, client, context }) => {
      const resolveParams = resolveApprovalDecisionParams({
        rawParams: params,
        validate: validateExecApprovalResolveParams,
        methodName: "exec.approval.resolve",
        respond
      });
      if (!resolveParams) return;
      const { inputId, decision: rawDecision } = resolveParams;
      const stopCancelled = rawDecision === "deny-justdo-stop";
      const decision = stopCancelled ? "deny" : rawDecision;
      if (stopCancelled) markJustDoStopCancelledExecApproval(inputId);
      await handleApprovalResolve({`;

function replaceExactlyOnce(content, original, replacement, description, filePath) {
  const firstIndex = content.indexOf(original);
  if (firstIndex === -1) {
    throw new Error(`OpenClaw ${description} patch target not found: ${filePath}`);
  }
  if (content.indexOf(original, firstIndex + original.length) !== -1) {
    throw new Error(`OpenClaw ${description} patch target is ambiguous: ${filePath}`);
  }
  return content.replace(original, replacement);
}

function patchFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  if (
    content.includes(PATCH_REVISION_MARKER) &&
    content.includes(PATCH_SOURCE_GUARD_MARKER) &&
    content.includes(PATCH_ABORT_SEMANTICS_MARKER) &&
    content.includes(PATCH_ABORT_RACE_GUARD_MARKER) &&
    content.includes(PATCH_HIDDEN_FOLLOWUP_PROMPT_MARKER) &&
    content.includes(PATCH_SUSPENDED_ORIGINAL_REPLY_MARKER) &&
    content.includes(PATCH_RUN_SCOPED_SUSPENSION_MARKER) &&
    content.includes(PATCH_LIVE_SUSPENSION_MARKER) &&
    content.includes(PATCH_CROSS_ATTEMPT_SUSPENSION_MARKER) &&
    content.includes(PATCH_GUARD_RUN_ID_FORWARD_MARKER) &&
    content.includes(PATCH_FORWARDING_TIMER_MARKER) &&
    content.includes(PATCH_STOP_CANCEL_MARKER) &&
    content.includes(PATCH_NODE_FAILURE_GUARD_MARKER)
  ) {
    return false;
  }

  const replacements = [];
  if (!content.includes(PATCH_MARKER)) {
    replacements.push(
      [
        ORIGINAL_GATEWAY_TIMEOUT_RESOLVER,
        PATCHED_GATEWAY_TIMEOUT_RESOLVER,
        'nullable gateway timeout resolver',
      ],
      [ORIGINAL_GATEWAY_OUTER_TIMER, PATCHED_GATEWAY_OUTER_TIMER, 'nullable gateway outer timer'],
      [ORIGINAL_APPROVAL_CREATE, PATCHED_APPROVAL_CREATE, 'persistent approval creation'],
      [
        ORIGINAL_APPROVAL_REGISTER_TIMER,
        PATCHED_APPROVAL_REGISTER_TIMER,
        'persistent approval registration',
      ],
      [ORIGINAL_EXEC_WAIT, PATCHED_EXEC_WAIT, 'exec approval wait'],
      [
        ORIGINAL_NATIVE_HOOK_WAIT_ARGS,
        PATCHED_NATIVE_HOOK_WAIT_ARGS,
        'native hook approval context',
      ],
      [
        ORIGINAL_INLINE_EXEC_APPROVAL,
        PATCHED_INLINE_EXEC_APPROVAL,
        'webchat exec approval suspension',
      ],
    );
  }
  if (!content.includes(PATCH_SOURCE_GUARD_MARKER)) {
    const upgradingV2 = content.includes(PATCH_MARKER);
    replacements.push(
      [
        upgradingV2 ? V2_PATCHED_APPROVAL_TIMEOUT_HELPER : ORIGINAL_APPROVAL_TIMEOUT_HELPER,
        V3_PATCHED_APPROVAL_TIMEOUT_HELPER,
        'persistent approval source helper',
      ],
      [
        upgradingV2 ? V2_PATCHED_PLUGIN_TOOL_WAIT : ORIGINAL_PLUGIN_TOOL_WAIT,
        PATCHED_PLUGIN_TOOL_WAIT,
        'plugin tool approval wait',
      ],
      [
        upgradingV2 ? V2_PATCHED_NATIVE_HOOK_WAIT : ORIGINAL_NATIVE_HOOK_WAIT,
        PATCHED_NATIVE_HOOK_WAIT,
        'native hook approval wait',
      ],
      [
        ORIGINAL_NATIVE_HOOK_SIGNAL_WAIT,
        V3_PATCHED_NATIVE_HOOK_SIGNAL_WAIT,
        'persistent native hook signal wait',
      ],
    );
  }
  if (!content.includes(PATCH_ABORT_SEMANTICS_MARKER)) {
    replacements.push(
      [
        V3_PATCHED_APPROVAL_TIMEOUT_HELPER,
        PATCHED_APPROVAL_TIMEOUT_HELPER,
        'persistent approval abort semantics helper',
      ],
      [
        V3_PATCHED_NATIVE_HOOK_SIGNAL_WAIT,
        ORIGINAL_NATIVE_HOOK_SIGNAL_WAIT,
        'restore cancellable native hook signal wait',
      ],
      [
        ORIGINAL_NATIVE_HOOK_ABORT_BLOCK,
        V4_PATCHED_NATIVE_HOOK_ABORT_BLOCK,
        'native hook automatic timeout guard',
      ],
    );
  }
  if (!content.includes(PATCH_ABORT_RACE_GUARD_MARKER)) {
    replacements.push([
      V4_PATCHED_NATIVE_HOOK_ABORT_BLOCK,
      PATCHED_NATIVE_HOOK_ABORT_BLOCK,
      'native hook explicit abort race guard',
    ]);
  }
  if (!content.includes(PATCH_REVISION_MARKER)) {
    replacements.push(
      [
        ORIGINAL_GATEWAY_TOOL_TIMEOUT,
        PATCHED_GATEWAY_TOOL_TIMEOUT,
        'nullable gateway tool timeout',
      ],
      [
        ORIGINAL_ASYNC_APPROVAL_FAILURE_FOLLOWUP,
        PATCHED_ASYNC_APPROVAL_FAILURE_FOLLOWUP,
        'approval transport failure follow-up guard',
      ],
    );
  }
  if (!content.includes(PATCH_NODE_FAILURE_GUARD_MARKER)) {
    replacements.push([
      ORIGINAL_ASYNC_NODE_APPROVAL_FAILURE_FOLLOWUP,
      PATCHED_ASYNC_NODE_APPROVAL_FAILURE_FOLLOWUP,
      'node approval transport failure follow-up guard',
    ]);
  }
  if (!content.includes(PATCH_HIDDEN_FOLLOWUP_PROMPT_MARKER)) {
    replacements.push([
      ORIGINAL_AGENT_FOLLOWUP_ARGS,
      PATCHED_AGENT_FOLLOWUP_ARGS,
      'hidden exec approval follow-up prompt',
    ]);
  }
  if (!content.includes(PATCH_SUSPENDED_ORIGINAL_REPLY_MARKER)) {
    replacements.push([
      ORIGINAL_ASSISTANT_PERSISTENCE,
      PATCHED_ASSISTANT_PERSISTENCE,
      'suspended original turn assistant persistence',
    ]);
  }
  if (!content.includes(PATCH_RUN_SCOPED_SUSPENSION_MARKER)) {
    replacements.push(
      [ORIGINAL_SUSPENSION_STATE, PATCHED_SUSPENSION_STATE, 'run-scoped approval suspension state'],
      [
        ORIGINAL_APPROVAL_PENDING_LATCH,
        PATCHED_APPROVAL_PENDING_LATCH,
        'run-scoped approval suspension latch',
      ],
      [
        PATCHED_ASSISTANT_PERSISTENCE,
        PATCHED_RUN_SCOPED_ASSISTANT_PERSISTENCE,
        'run-scoped suspended original turn assistant persistence',
      ],
    );
  }
  if (!content.includes(PATCH_LIVE_SUSPENSION_MARKER)) {
    replacements.push(
      [
        ORIGINAL_LIVE_APPROVAL_PENDING_LATCH,
        PATCHED_LIVE_APPROVAL_PENDING_LATCH,
        'live approval suspension latch',
      ],
      [
        ORIGINAL_LIVE_ASSISTANT_SUPPRESSION,
        PATCHED_LIVE_ASSISTANT_SUPPRESSION,
        'live suspended original turn assistant suppression',
      ],
    );
  }
  if (!content.includes(PATCH_CROSS_ATTEMPT_SUSPENSION_MARKER)) {
    replacements.push(
      [
        ORIGINAL_SUSPENDED_RUN_HELPERS,
        PATCHED_SUSPENDED_RUN_HELPERS,
        'cross-attempt suspended run helpers',
      ],
      [
        PATCHED_SUSPENSION_STATE,
        PATCHED_CROSS_ATTEMPT_SUSPENSION_STATE,
        'cross-attempt approval suspension state',
      ],
      [
        PATCHED_APPROVAL_PENDING_LATCH,
        PATCHED_CROSS_ATTEMPT_APPROVAL_PENDING_LATCH,
        'cross-attempt approval suspension latch',
      ],
      [
        PATCHED_RUN_SCOPED_ASSISTANT_PERSISTENCE,
        PATCHED_CROSS_ATTEMPT_ASSISTANT_PERSISTENCE,
        'cross-attempt suspended original turn assistant persistence',
      ],
      [ORIGINAL_GUARD_RUN_ID, PATCHED_GUARD_RUN_ID, 'session guard run id'],
      [
        PATCHED_LIVE_APPROVAL_PENDING_LATCH,
        PATCHED_CROSS_ATTEMPT_LIVE_LATCH,
        'cross-attempt live approval suspension latch',
      ],
      [ORIGINAL_LIVE_STATE_INIT, PATCHED_LIVE_STATE_INIT, 'live suspension state restore'],
      [
        ORIGINAL_TERMINAL_APPROVAL_SUPPRESSION,
        PATCHED_TERMINAL_APPROVAL_SUPPRESSION,
        'terminal suspended run suppression',
      ],
      [
        ORIGINAL_REASONING_SUSPENSION,
        PATCHED_REASONING_SUSPENSION,
        'suspended run reasoning suppression',
      ],
    );
  }
  if (!content.includes(PATCH_GUARD_RUN_ID_FORWARD_MARKER)) {
    replacements.push([
      ORIGINAL_INSTALL_GUARD_RUN_ID,
      PATCHED_INSTALL_GUARD_RUN_ID,
      'session guard run id forwarding',
    ]);
  }
  if (!content.includes(PATCH_FORWARDING_TIMER_MARKER)) {
    replacements.push(
      [
        ORIGINAL_GATEWAY_APPROVAL_FORWARD_TIMER,
        PATCHED_GATEWAY_APPROVAL_FORWARD_TIMER,
        'gateway approval forwarding timer',
      ],
      [
        ORIGINAL_APPROVAL_FORWARDER_TIMER,
        PATCHED_APPROVAL_FORWARDER_TIMER,
        'approval forwarder timer',
      ],
    );
  }
  if (!content.includes(PATCH_STOP_CANCEL_MARKER)) {
    replacements.push(
      [
        ORIGINAL_EXEC_APPROVAL_FOLLOWUP_SENDER,
        PATCHED_EXEC_APPROVAL_FOLLOWUP_SENDER,
        'stop-cancelled exec follow-up suppression',
      ],
      [
        ORIGINAL_EXEC_APPROVAL_RESOLVE_DECISION,
        PATCHED_EXEC_APPROVAL_RESOLVE_DECISION,
        'stop-cancelled exec resolve decision',
      ],
    );
  }

  for (const [original, replacement, description] of replacements) {
    content = replaceExactlyOnce(content, original, replacement, description, filePath);
  }

  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function applyPatch(runtimeDir, options = {}) {
  const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
  const label = options.label || 'patch-openclaw-persistent-interactive-approvals';
  if (!fs.existsSync(bundlePath)) {
    if (options.verbose) {
      console.log(`[${label}] Gateway bundle not generated yet; deferring approval patch.`);
    }
    return [];
  }

  const patched = patchFile(bundlePath) ? ['gateway-bundle.mjs'] : [];
  if (patched.length > 0) {
    console.log(`[${label}] Enabled persistent interactive approval suspension.`);
  } else if (options.verbose) {
    console.log(`[${label}] Persistent interactive approval suspension already applied.`);
  }
  return patched;
}

module.exports = {
  applyPatch,
  __testing: {
    PATCH_MARKER,
    PATCH_REVISION_MARKER,
    PATCH_SOURCE_GUARD_MARKER,
    PATCH_ABORT_SEMANTICS_MARKER,
    PATCH_ABORT_RACE_GUARD_MARKER,
    PATCH_HIDDEN_FOLLOWUP_PROMPT_MARKER,
    PATCH_SUSPENDED_ORIGINAL_REPLY_MARKER,
    PATCH_RUN_SCOPED_SUSPENSION_MARKER,
    PATCH_LIVE_SUSPENSION_MARKER,
    PATCH_CROSS_ATTEMPT_SUSPENSION_MARKER,
    PATCH_GUARD_RUN_ID_FORWARD_MARKER,
    PATCH_FORWARDING_TIMER_MARKER,
    PATCH_STOP_CANCEL_MARKER,
    PATCH_NODE_FAILURE_GUARD_MARKER,
    PATCHED_GATEWAY_TOOL_TIMEOUT,
    PATCHED_APPROVAL_TIMEOUT_HELPER,
    PATCHED_APPROVAL_CREATE,
    PATCHED_APPROVAL_REGISTER_TIMER,
    PATCHED_GATEWAY_TIMEOUT_RESOLVER,
    PATCHED_GATEWAY_OUTER_TIMER,
    PATCHED_EXEC_WAIT,
    PATCHED_PLUGIN_TOOL_WAIT,
    PATCHED_NATIVE_HOOK_WAIT,
    PATCHED_NATIVE_HOOK_ABORT_BLOCK,
    PATCHED_NATIVE_HOOK_WAIT_ARGS,
    PATCHED_INLINE_EXEC_APPROVAL,
    PATCHED_ASYNC_APPROVAL_FAILURE_FOLLOWUP,
    PATCHED_ASYNC_NODE_APPROVAL_FAILURE_FOLLOWUP,
    ORIGINAL_AGENT_FOLLOWUP_ARGS,
    PATCHED_AGENT_FOLLOWUP_ARGS,
    ORIGINAL_ASSISTANT_PERSISTENCE,
    PATCHED_ASSISTANT_PERSISTENCE,
    ORIGINAL_SUSPENSION_STATE,
    PATCHED_SUSPENSION_STATE,
    ORIGINAL_APPROVAL_PENDING_LATCH,
    PATCHED_APPROVAL_PENDING_LATCH,
    PATCHED_RUN_SCOPED_ASSISTANT_PERSISTENCE,
    ORIGINAL_LIVE_APPROVAL_PENDING_LATCH,
    PATCHED_LIVE_APPROVAL_PENDING_LATCH,
    ORIGINAL_LIVE_ASSISTANT_SUPPRESSION,
    PATCHED_LIVE_ASSISTANT_SUPPRESSION,
    ORIGINAL_SUSPENDED_RUN_HELPERS,
    PATCHED_SUSPENDED_RUN_HELPERS,
    PATCHED_CROSS_ATTEMPT_SUSPENSION_STATE,
    PATCHED_CROSS_ATTEMPT_APPROVAL_PENDING_LATCH,
    PATCHED_CROSS_ATTEMPT_ASSISTANT_PERSISTENCE,
    ORIGINAL_GUARD_RUN_ID,
    PATCHED_GUARD_RUN_ID,
    PATCHED_CROSS_ATTEMPT_LIVE_LATCH,
    ORIGINAL_LIVE_STATE_INIT,
    PATCHED_LIVE_STATE_INIT,
    ORIGINAL_TERMINAL_APPROVAL_SUPPRESSION,
    PATCHED_TERMINAL_APPROVAL_SUPPRESSION,
    ORIGINAL_REASONING_SUSPENSION,
    PATCHED_REASONING_SUSPENSION,
    ORIGINAL_INSTALL_GUARD_RUN_ID,
    PATCHED_INSTALL_GUARD_RUN_ID,
    ORIGINAL_GATEWAY_APPROVAL_FORWARD_TIMER,
    PATCHED_GATEWAY_APPROVAL_FORWARD_TIMER,
    ORIGINAL_APPROVAL_FORWARDER_TIMER,
    PATCHED_APPROVAL_FORWARDER_TIMER,
    ORIGINAL_EXEC_APPROVAL_FOLLOWUP_SENDER,
    PATCHED_EXEC_APPROVAL_FOLLOWUP_SENDER,
    ORIGINAL_EXEC_APPROVAL_RESOLVE_DECISION,
    PATCHED_EXEC_APPROVAL_RESOLVE_DECISION,
  },
};
