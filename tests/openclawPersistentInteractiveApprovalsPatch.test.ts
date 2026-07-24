import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, expect, test, vi } from 'vitest';

const { applyPatch, __testing } =
  require('../scripts/patches/v2026.6.11/018-persistent-interactive-approvals.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
    __testing: Record<string, string>;
  };

const BUNDLE_FIXTURE = `function resolveGatewayCallTimeout(timeoutValue, configuredHandshakeTimeoutMs) {
  const hasConfiguredHandshakeTimeout = typeof configuredHandshakeTimeoutMs === "number" && Number.isFinite(configuredHandshakeTimeoutMs) && configuredHandshakeTimeoutMs > 0;
}
function normalizeOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function normalizeLowercaseStringOrEmpty(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
function isCronSessionKey(value) {
  return value.includes(":cron:");
}
function toErrorObject(value) {
  return value instanceof Error ? value : new Error(String(value));
}
const PluginApprovalResolutions = { DENY: "deny" };
let resolveGatewayDecision;
let lastGatewayResolution;
function callGatewayTool(method, _options, params) {
  if (method === "plugin.approval.resolve") {
    lastGatewayResolution = params.decision;
    resolveGatewayDecision?.({ decision: params.decision });
    return Promise.resolve({ ok: true });
  }
  return new Promise(resolve => { resolveGatewayDecision = resolve; });
}
function resolvePendingGatewayDecision(value) {
  resolveGatewayDecision?.(value);
}
function getLastGatewayResolution() {
  return lastGatewayResolution;
}
function buildExecApprovalFollowupPrompt(value) {
  return value;
}
function isExecDeniedResultText(value) {
  return value.startsWith("Exec denied");
}
async function sendExecApprovalFollowupResult(target, resultText, deps2 = {}) {
  const send = deps2.sendExecApprovalFollowup ?? sendExecApprovalFollowup;
  await send({ approvalId: target.approvalId, resultText });
}
const handlers = {
    "exec.approval.resolve": async ({ params, respond, client, context }) => {
      const resolveParams = resolveApprovalDecisionParams({
        rawParams: params,
        validate: validateExecApprovalResolveParams,
        methodName: "exec.approval.resolve",
        respond
      });
      if (!resolveParams) return;
      const { inputId, decision } = resolveParams;
      await handleApprovalResolve({
        manager,
        inputId,
        decision,
        respond,
        context,
        client,
        exposeAmbiguousPrefixError: true
      });
    }
};
function extractToolResultId() {
  return undefined;
}
function nowMs4() {
  return Date.now();
}
function installSessionToolResultGuard(sessionManager, opts) {
  return { sessionManager, opts };
}
function guardSessionManagerForHarness(sessionManager, opts) {
  const guard = installSessionToolResultGuard(sessionManager, {
    sessionKey: opts?.sessionKey,
  });
  return guard;
}
function shouldSuppressDeterministicApprovalOutput(state5) {
  return state5.deterministicApprovalPromptPending || state5.deterministicApprovalPromptSent;
}
function latchLiveApprovalForHarness(ctx, isToolError, approvalPending) {
  if (!isToolError && approvalPending) {
    if (!ctx.params.onToolResult) return;
  }
}
function simulateLiveApprovalForHarness(params) {
  const ctx = {
    params: { runId: params.runId, sessionKey: params.sessionKey },
    state: {
    deterministicApprovalPromptSent: false
    }
  };
  latchLiveApprovalForHarness(
    ctx,
    false,
    params.approvalPending === false ? null : { approvalId: "approval-1" }
  );
  return shouldSuppressDeterministicApprovalOutput(ctx.state);
}
function terminalSuppressionForHarness(params, didSendDeterministicApprovalPromptNow) {
  const didDeliverSourceReplyViaMessageTool = false;
  const getMessagingToolSentTexts = () => [];
  return {
        didDeliverSourceReplyViaMessageTool,
        didSendDeterministicApprovalPrompt: didSendDeterministicApprovalPromptNow,
        messagingToolSentTexts: getMessagingToolSentTexts(),
  }.didSendDeterministicApprovalPrompt;
}
  const emitReasoningStream = (text2) => {
    if (params.silentExpected) return;
  return text2;
};
function resolveGatewayOptions2(opts) {
  const timeoutMs = typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) ? Math.max(1, Math.floor(opts.timeoutMs)) : 3e4;
  return { timeoutMs };
}
function gatewayCall() {
    const timer3 = setTimeout(() => {
      ignoreClose = true;
      stop3(createGatewayTimeoutTransportError({
        timeoutMs,
        connectionDetails: params.connectionDetails
      }));
    }, safeTimerTimeoutMs);
    startGatewayClientWhenEventLoopReady(client, {
      timeoutMs: safeTimerTimeoutMs,
      signal: startAbort.signal
    });
}
function resolveApprovalTimeoutMs(timeoutMs) {
  return resolveTimerTimeoutMs(timeoutMs, 1);
}
class ExecApprovalManager {
      create(request5, timeoutMs, id) {
        const now = Date.now();
        const expiresAtMs = resolveExpiresAtMsFromDurationMs(resolveApprovalTimeoutMs(timeoutMs), { nowMs: now });
        if (expiresAtMs === void 0) throw new Error("approval expiry is unavailable");
        return { id, request: request5, expiresAtMs };
      }
      register(record3, timeoutMs) {
        const entry = { timer: null };
        const timerDelayMs = resolveApprovalTimeoutMs(timeoutMs);
        entry.timer = setTimeout(() => {
          this.expire(record3.id);
        }, timerDelayMs);
        return entry;
      }
}
async function resolveRegisteredExecApprovalDecision(params) {
  return parseDecision(await callGatewayTool("exec.approval.waitDecision", { timeoutMs: DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS }, { id: params.approvalId })).value;
}
async function requestPluginToolApproval(params) {
  const gatewayTimeoutMs = 1000;
  const id = "approval";
  const waitPromise = callGatewayTool("plugin.approval.waitDecision", { timeoutMs: gatewayTimeoutMs }, { id });
  return waitPromise;
}
async function waitForNativeHookRelayApprovalDecision(params) {
  const waitPromise = callGatewayTool("plugin.approval.waitDecision", { timeoutMs: params.timeoutMs + 1e4 }, { id: params.approvalId });
  if (!params.signal) return waitPromise;
  let onAbort;
  const abortPromise = new Promise((_4, reject) => {
    if (params.signal.aborted) {
      reject(toErrorObject(params.signal.reason, "Non-Error rejection"));
      return;
    }
    onAbort = () => reject(toErrorObject(params.signal.reason, "Non-Error rejection"));
    params.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([waitPromise, abortPromise]);
  } finally {
    if (onAbort) params.signal.removeEventListener("abort", onAbort);
  }
}
function requestNativeHook(request5, approvalId, timeoutMs) {
  return waitForNativeHookRelayApprovalDecision({
    approvalId,
    signal: request5.signal,
    timeoutMs
  });
}
function shouldAwaitGatewayApprovalInline(params) {
  if (params.approvalFollowupMode !== void 0) return false;
  return isNativeApprovalChannel(normalizeMessageChannel2(params.turnSourceChannel));
}
async function waitForAsyncApproval(resolveApprovalForExecution, sendExecApprovalFollowupResult, followupTarget, approvalId, params) {
  const approvalDecision = await resolveApprovalForExecution(() => void sendExecApprovalFollowupResult(followupTarget, \`Exec denied (gateway id=\${approvalId}, approval-request-failed): \${params.command}\`));
  return approvalDecision;
}
async function waitForAsyncNodeApproval(resolveApprovalDecisionOrUndefined, sendExecApprovalFollowupResult, followupTarget, approvalId, params, target) {
  return resolveApprovalDecisionOrUndefined({
    approvalId,
    onFailure: () => void sendExecApprovalFollowupResult(followupTarget, \`Exec denied (node=\${target.nodeId} id=\${approvalId}, approval-request-failed): \${params.command}\`)
  });
}
function buildAgentFollowupArgs(params) {
  const { deliveryTarget, sessionOnlyOriginChannel } = params;
  const fallbackChannel = sessionOnlyOriginChannel ?? params.turnSourceChannel;
  return {
    sessionKey: params.sessionKey,
    message: buildExecApprovalFollowupPrompt(params.resultText),
    deliver: deliveryTarget.deliver,
    channel: deliveryTarget.deliver ? deliveryTarget.channel : fallbackChannel
  };
}
function persistRunForHarness(params) {
  const opts = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    suppressNextUserMessagePersistence: params.suppressNextUserMessagePersistence
  };
  let suppressNextUserMessagePersistence = opts?.suppressNextUserMessagePersistence === true;
  const persisted = [];
  const pendingState = { getToolName: () => undefined, delete: () => undefined };
  const append = nextMessage => {
    const nextRole = nextMessage.role;
    if (nextRole === "toolResult") {
      const id = extractToolResultId(nextMessage);
      const toolName3 = id ? pendingState.getToolName(id) : void 0;
      if (id) pendingState.delete(id);
      persisted.push(nextMessage);
      return toolName3;
    }
    const toolCalls = nextRole === "assistant" ? nextMessage.toolCalls ?? [] : [];
    const finalMessage = nextMessage;
    const finalRole = finalMessage.role;
    if (finalRole === "assistant" && toolCalls.length === 0 && opts?.suppressTranscriptOnlyAssistantPersistence === true) return;
    if (finalRole === "user" && suppressNextUserMessagePersistence) {
      suppressNextUserMessagePersistence = false;
      return;
    }
    persisted.push(finalMessage);
  };
  for (const message of params.messages) append(message);
  return persisted;
}
function createGuardOptionsForHarness(params) {
  return {
        suppressNextUserMessagePersistence: params.suppressNextUserMessagePersistence,
  };
}
function gatewayApprovalForwardTimerForHarness(request5, entry) {
    const timeoutMs = Math.max(0, request5.expiresAtMs - nowMs4());
    const timeoutId = setTimeout(() => {
      spawn40("error handling approval expiration", handleExpired(request5.id));
    }, timeoutMs);
    timeoutId.unref?.();
    entry.timeoutId = timeoutId;
}
function approvalForwarderTimerForHarness(params, request5, requestId, routeRequest, filteredTargets, cfg, pending) {
    const expiresInMs = Math.max(0, params.strategy.getExpiresAtMs(request5) - params.nowMs());
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
    };
    return pendingEntry;
}
function simulatePinnedTranscriptEffects(agentArgs, assistantText) {
  const persisted = [];
  const sessionMessages = [];
  let suppressNextUserMessagePersistence = agentArgs.suppressPromptPersistence === true;
  const appendMessage = message => {
    if (message.role === "user" && suppressNextUserMessagePersistence) {
      suppressNextUserMessagePersistence = false;
      return;
    }
    persisted.push(message);
    sessionMessages.push(message);
  };
  appendMessage({ role: "user", content: agentArgs.message });
  appendMessage({ role: "assistant", content: assistantText });
  return { persisted, sessionMessages };
}
export { approvalForwarderTimerForHarness, buildAgentFollowupArgs, gatewayApprovalForwardTimerForHarness, getLastGatewayResolution, guardSessionManagerForHarness, markJustDoStopCancelledExecApproval, persistRunForHarness, resolvePendingGatewayDecision, sendExecApprovalFollowupResult, simulateLiveApprovalForHarness, simulatePinnedTranscriptEffects, terminalSuppressionForHarness, waitForNativeHookRelayApprovalDecision };`;

afterEach(() => {
  vi.useRealTimers();
});

test('patches persistent approval behavior idempotently', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-persistent-approvals-'));
  try {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    fs.writeFileSync(bundlePath, BUNDLE_FIXTURE, 'utf8');

    expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    const patched = fs.readFileSync(bundlePath, 'utf8');
    expect(patched).toContain('JUSTDO_PERSISTENT_INTERACTIVE_APPROVALS');
    expect(patched).toContain('JUSTDO_PERSISTENT_INTERACTIVE_APPROVALS_V2');
    expect(patched).toContain('JUSTDO_PERSISTENT_INTERACTIVE_APPROVALS_V3');
    expect(patched).toContain('JUSTDO_PERSISTENT_INTERACTIVE_APPROVALS_V4');
    expect(patched).toContain('JUSTDO_PERSISTENT_INTERACTIVE_APPROVALS_V5');
    expect(patched).toContain('JUSTDO_PERSISTENT_INTERACTIVE_APPROVALS_V6');
    expect(patched).toContain('JUSTDO_PERSISTENT_INTERACTIVE_APPROVALS_V7');
    expect(patched).toContain('JUSTDO_PERSISTENT_INTERACTIVE_APPROVALS_V8');
    expect(patched).toContain('JUSTDO_PERSISTENT_INTERACTIVE_APPROVALS_V9');
    expect(patched).toContain('JUSTDO_PERSISTENT_INTERACTIVE_APPROVALS_V10');
    expect(patched).toContain('JUSTDO_PERSISTENT_INTERACTIVE_APPROVALS_V11');
    expect(patched).toContain('JUSTDO_PERSISTENT_INTERACTIVE_APPROVALS_V12');
    expect(patched).toContain('JUSTDO_PERSISTENT_INTERACTIVE_APPROVALS_V13');
    expect(patched).toContain('JUSTDO_PERSISTENT_NODE_APPROVAL_FAILURE_GUARD');
    expect(patched).toContain('timeoutMs: null');
    expect(patched).toContain('JUSTDO_PERSISTENT_APPROVAL_EXPIRES_AT_MS');
    expect(patched).toContain('if (channel === "webchat") return false;');
    expect(patched).toContain('suppressPromptPersistence: true');
    expect(applyPatch(runtimeDir)).toEqual([]);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('upgrades a V5 bundle to the latest revision idempotently', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-v5-approval-upgrade-'));
  try {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    fs.writeFileSync(bundlePath, BUNDLE_FIXTURE, 'utf8');
    applyPatch(runtimeDir);
    const latestBundle = fs.readFileSync(bundlePath, 'utf8');
    const v5Bundle = latestBundle
      .replace(__testing.PATCHED_AGENT_FOLLOWUP_ARGS, __testing.ORIGINAL_AGENT_FOLLOWUP_ARGS)
      .replace(
        __testing.PATCHED_TERMINAL_APPROVAL_SUPPRESSION,
        __testing.ORIGINAL_TERMINAL_APPROVAL_SUPPRESSION,
      )
      .replace(__testing.PATCHED_REASONING_SUSPENSION, __testing.ORIGINAL_REASONING_SUSPENSION)
      .replace(__testing.PATCHED_INSTALL_GUARD_RUN_ID, __testing.ORIGINAL_INSTALL_GUARD_RUN_ID)
      .replace(
        __testing.PATCHED_GATEWAY_APPROVAL_FORWARD_TIMER,
        __testing.ORIGINAL_GATEWAY_APPROVAL_FORWARD_TIMER,
      )
      .replace(
        __testing.PATCHED_APPROVAL_FORWARDER_TIMER,
        __testing.ORIGINAL_APPROVAL_FORWARDER_TIMER,
      )
      .replace(
        __testing.PATCHED_EXEC_APPROVAL_FOLLOWUP_SENDER,
        __testing.ORIGINAL_EXEC_APPROVAL_FOLLOWUP_SENDER,
      )
      .replace(
        __testing.PATCHED_EXEC_APPROVAL_RESOLVE_DECISION,
        __testing.ORIGINAL_EXEC_APPROVAL_RESOLVE_DECISION,
      )
      .replace(__testing.PATCHED_LIVE_STATE_INIT, __testing.ORIGINAL_LIVE_STATE_INIT)
      .replace(
        __testing.PATCHED_CROSS_ATTEMPT_LIVE_LATCH,
        __testing.PATCHED_LIVE_APPROVAL_PENDING_LATCH,
      )
      .replace(__testing.PATCHED_GUARD_RUN_ID, __testing.ORIGINAL_GUARD_RUN_ID)
      .replace(
        __testing.PATCHED_CROSS_ATTEMPT_ASSISTANT_PERSISTENCE,
        __testing.PATCHED_RUN_SCOPED_ASSISTANT_PERSISTENCE,
      )
      .replace(
        __testing.PATCHED_CROSS_ATTEMPT_APPROVAL_PENDING_LATCH,
        __testing.PATCHED_APPROVAL_PENDING_LATCH,
      )
      .replace(__testing.PATCHED_CROSS_ATTEMPT_SUSPENSION_STATE, __testing.PATCHED_SUSPENSION_STATE)
      .replace(__testing.PATCHED_SUSPENDED_RUN_HELPERS, __testing.ORIGINAL_SUSPENDED_RUN_HELPERS)
      .replace(__testing.PATCHED_ASSISTANT_PERSISTENCE, __testing.ORIGINAL_ASSISTANT_PERSISTENCE)
      .replace(__testing.PATCHED_SUSPENSION_STATE, __testing.ORIGINAL_SUSPENSION_STATE)
      .replace(__testing.PATCHED_APPROVAL_PENDING_LATCH, __testing.ORIGINAL_APPROVAL_PENDING_LATCH)
      .replace(
        __testing.PATCHED_RUN_SCOPED_ASSISTANT_PERSISTENCE,
        __testing.ORIGINAL_ASSISTANT_PERSISTENCE,
      )
      .replace(
        __testing.PATCHED_LIVE_APPROVAL_PENDING_LATCH,
        __testing.ORIGINAL_LIVE_APPROVAL_PENDING_LATCH,
      )
      .replace(
        __testing.PATCHED_LIVE_ASSISTANT_SUPPRESSION,
        __testing.ORIGINAL_LIVE_ASSISTANT_SUPPRESSION,
      );
    fs.writeFileSync(bundlePath, v5Bundle, 'utf8');

    expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    const upgraded = fs.readFileSync(bundlePath, 'utf8');
    expect(upgraded).toContain('JUSTDO_PERSISTENT_INTERACTIVE_APPROVALS_V6');
    expect(upgraded).toContain('JUSTDO_PERSISTENT_INTERACTIVE_APPROVALS_V7');
    expect(upgraded).toContain('JUSTDO_PERSISTENT_INTERACTIVE_APPROVALS_V8');
    expect(upgraded).toContain('JUSTDO_PERSISTENT_INTERACTIVE_APPROVALS_V9');
    expect(upgraded).toContain('JUSTDO_PERSISTENT_INTERACTIVE_APPROVALS_V10');
    expect(upgraded).toContain('JUSTDO_PERSISTENT_INTERACTIVE_APPROVALS_V11');
    expect(upgraded).toContain('JUSTDO_PERSISTENT_INTERACTIVE_APPROVALS_V12');
    expect(upgraded).toContain('JUSTDO_PERSISTENT_INTERACTIVE_APPROVALS_V13');
    expect(upgraded).toContain('suppressPromptPersistence: true');
    expect(applyPatch(runtimeDir)).toEqual([]);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('persistent approvals skip both forwarding expiry timers', async () => {
  vi.useFakeTimers();
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-forward-timers-'));
  try {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    fs.writeFileSync(bundlePath, BUNDLE_FIXTURE, 'utf8');
    applyPatch(runtimeDir);
    const { approvalForwarderTimerForHarness, gatewayApprovalForwardTimerForHarness } =
      (await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`)) as {
        approvalForwarderTimerForHarness: (
          params: Record<string, unknown>,
          request: Record<string, unknown>,
          requestId: string,
          routeRequest: Record<string, unknown>,
          targets: unknown[],
          cfg: Record<string, unknown>,
          pending: Map<string, unknown>,
        ) => { timeoutId: unknown };
        gatewayApprovalForwardTimerForHarness: (
          request: Record<string, unknown>,
          entry: Record<string, unknown>,
        ) => void;
      };
    const persistentEntry: Record<string, unknown> = { timeoutId: null };
    gatewayApprovalForwardTimerForHarness(
      { id: 'persistent', expiresAtMs: Number.MAX_SAFE_INTEGER },
      persistentEntry,
    );
    const forwarderParams = {
      strategy: {
        kind: 'exec',
        getExpiresAtMs: (request: { expiresAtMs: number }) => request.expiresAtMs,
      },
      nowMs: () => 100,
    };
    const persistentForwarder = approvalForwarderTimerForHarness(
      forwarderParams,
      { expiresAtMs: Number.MAX_SAFE_INTEGER },
      'persistent',
      {},
      [],
      {},
      new Map(),
    );

    expect(persistentEntry.timeoutId).toBeNull();
    expect(persistentForwarder.timeoutId).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    const finiteEntry: Record<string, unknown> = { timeoutId: null };
    gatewayApprovalForwardTimerForHarness(
      { id: 'finite', expiresAtMs: Date.now() + 1_000 },
      finiteEntry,
    );
    const finiteForwarder = approvalForwarderTimerForHarness(
      forwarderParams,
      { expiresAtMs: 1_100 },
      'finite',
      {},
      [],
      {},
      new Map(),
    );
    expect(finiteEntry.timeoutId).not.toBeNull();
    expect(finiteForwarder.timeoutId).not.toBeNull();
    expect(vi.getTimerCount()).toBe(2);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('a stop-cancelled exec denial is consumed without a follow-up reply', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-stop-cancel-'));
  try {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    fs.writeFileSync(bundlePath, BUNDLE_FIXTURE, 'utf8');
    applyPatch(runtimeDir);
    const { markJustDoStopCancelledExecApproval, sendExecApprovalFollowupResult } = (await import(
      `${pathToFileURL(bundlePath).href}?test=${Date.now()}`
    )) as {
      markJustDoStopCancelledExecApproval: (approvalId: string) => void;
      sendExecApprovalFollowupResult: (
        target: { approvalId: string },
        resultText: string,
        deps: { sendExecApprovalFollowup: (params: unknown) => Promise<void> },
      ) => Promise<void>;
    };
    const send = vi.fn().mockResolvedValue(undefined);
    markJustDoStopCancelledExecApproval('approval-stop');

    await sendExecApprovalFollowupResult(
      { approvalId: 'approval-stop' },
      'Exec denied (gateway id=approval-stop, denied-by-user): npm test',
      { sendExecApprovalFollowup: send },
    );
    expect(send).not.toHaveBeenCalled();

    await sendExecApprovalFollowupResult(
      { approvalId: 'approval-stop' },
      'Exec denied (gateway id=approval-stop, denied-by-user): npm test',
      { sendExecApprovalFollowup: send },
    );
    expect(send).toHaveBeenCalledTimes(1);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('suppresses live assistant output only for the suspended JustDo run', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-live-suspension-'));
  try {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    fs.writeFileSync(bundlePath, BUNDLE_FIXTURE, 'utf8');
    applyPatch(runtimeDir);
    const { simulateLiveApprovalForHarness, terminalSuppressionForHarness } = (await import(
      `${pathToFileURL(bundlePath).href}?test=${Date.now()}`
    )) as {
      simulateLiveApprovalForHarness: (params: Record<string, unknown>) => boolean;
      terminalSuppressionForHarness: (
        params: Record<string, unknown>,
        didSendDeterministicApprovalPromptNow: boolean,
      ) => boolean;
    };

    expect(
      simulateLiveApprovalForHarness({
        runId: 'live-original-run-1',
        sessionKey: 'agent:main:justdo:session-1',
      }),
    ).toBe(true);
    expect(terminalSuppressionForHarness({ runId: 'live-original-run-1' }, false)).toBe(true);
    expect(
      simulateLiveApprovalForHarness({
        runId: 'live-api-run-1',
        sessionKey: 'agent:main:api:session-1',
      }),
    ).toBeFalsy();
    expect(
      simulateLiveApprovalForHarness({
        sessionKey: 'agent:main:justdo:follow-up-new-run',
        runId: 'live-follow-up-run-1',
        approvalPending: false,
      }),
    ).toBeFalsy();
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('suppresses only the original assistant reply after a JustDo approval suspension', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-suspended-reply-'));
  try {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    fs.writeFileSync(bundlePath, BUNDLE_FIXTURE, 'utf8');
    applyPatch(runtimeDir);
    const { guardSessionManagerForHarness, persistRunForHarness } = (await import(
      `${pathToFileURL(bundlePath).href}?test=${Date.now()}`
    )) as {
      persistRunForHarness: (params: Record<string, unknown>) => Array<Record<string, unknown>>;
      guardSessionManagerForHarness: (
        sessionManager: unknown,
        opts: Record<string, unknown>,
      ) => { opts: Record<string, unknown> };
    };
    const approvalPending = {
      role: 'toolResult',
      details: { status: 'approval-pending' },
    };

    expect(
      guardSessionManagerForHarness(
        {},
        {
          runId: 'forwarded-run-1',
          sessionKey: 'agent:main:justdo:session-1',
        },
      ).opts.runId,
    ).toBe('forwarded-run-1');

    expect(
      persistRunForHarness({
        runId: 'original-run-1',
        sessionKey: 'agent:main:justdo:session-1',
        messages: [approvalPending, { role: 'assistant', content: 'duplicate original reply' }],
      }),
    ).toEqual([approvalPending]);
    expect(
      persistRunForHarness({
        runId: 'original-run-1',
        sessionKey: 'agent:main:justdo:session-1',
        messages: [{ role: 'assistant', content: 'fallback duplicate reply' }],
      }),
    ).toEqual([]);
    expect(
      persistRunForHarness({
        runId: 'follow-up-run-1',
        sessionKey: 'agent:main:justdo:session-1',
        suppressNextUserMessagePersistence: true,
        messages: [
          { role: 'user', content: 'hidden follow-up prompt' },
          { role: 'assistant', content: 'follow-up reply' },
        ],
      }),
    ).toEqual([{ role: 'assistant', content: 'follow-up reply' }]);
    expect(
      persistRunForHarness({
        runId: 'api-run-1',
        sessionKey: 'agent:main:api:session-1',
        messages: [approvalPending, { role: 'assistant', content: 'non-JustDo reply' }],
      }),
    ).toEqual([approvalPending, { role: 'assistant', content: 'non-JustDo reply' }]);
    expect(
      persistRunForHarness({
        runId: 'original-run-2',
        sessionKey: 'agent:main:justdo:session-1',
        messages: [
          approvalPending,
          { role: 'assistant', toolCalls: [{ name: 'read' }] },
          { role: 'toolResult', details: { status: 'completed' } },
          { role: 'assistant', content: 'late duplicate reply' },
        ],
      }),
    ).toEqual([
      approvalPending,
      { role: 'assistant', toolCalls: [{ name: 'read' }] },
      { role: 'toolResult', details: { status: 'completed' } },
    ]);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('preserves an explicit null gateway tool timeout', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-null-tool-timeout-'));
  try {
    const harnessPath = path.join(runtimeDir, 'gateway-options.mjs');
    fs.writeFileSync(
      harnessPath,
      `function resolveTimeout(opts) {
${__testing.PATCHED_GATEWAY_TOOL_TIMEOUT}
  return timeoutMs;
}
export { resolveTimeout };`,
      'utf8',
    );

    const { resolveTimeout } = (await import(
      `${pathToFileURL(harnessPath).href}?test=${Date.now()}`
    )) as {
      resolveTimeout: (opts: { timeoutMs?: number | null }) => number | null;
    };

    expect(resolveTimeout({ timeoutMs: null })).toBeNull();
    expect(resolveTimeout({ timeoutMs: 1234 })).toBe(1234);
    expect(resolveTimeout({})).toBe(30_000);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('does not synthesize an exec follow-up when approval transport fails', () => {
  expect(__testing.PATCHED_ASYNC_APPROVAL_FAILURE_FOLLOWUP).toBe(
    'const approvalDecision = await resolveApprovalForExecution(() => void 0);',
  );
  expect(__testing.PATCHED_ASYNC_NODE_APPROVAL_FAILURE_FOLLOWUP).not.toContain(
    'sendExecApprovalFollowupResult',
  );
});

test('keeps the approval completion prompt out of user-visible history', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-hidden-followup-'));
  try {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    fs.writeFileSync(bundlePath, BUNDLE_FIXTURE, 'utf8');
    applyPatch(runtimeDir);
    const { buildAgentFollowupArgs, simulatePinnedTranscriptEffects } = (await import(
      `${pathToFileURL(bundlePath).href}?test=${Date.now()}`
    )) as {
      buildAgentFollowupArgs: (params: Record<string, unknown>) => Record<string, unknown>;
      simulatePinnedTranscriptEffects: (
        agentArgs: Record<string, unknown>,
        assistantText: string,
      ) => {
        persisted: Array<{ role: string; content: string }>;
        sessionMessages: Array<{ role: string; content: string }>;
      };
    };

    const args = buildAgentFollowupArgs({
      sessionKey: 'agent:main:justdo:session-1',
      resultText: 'Exec finished (code 0)',
      deliveryTarget: { deliver: false },
      turnSourceChannel: 'webchat',
    });

    expect(args.suppressPromptPersistence).toBe(true);
    expect(args.sessionEffects).toBeUndefined();
    expect(args.message).toBe('Exec finished (code 0)');
    const effects = simulatePinnedTranscriptEffects(args, 'The command completed successfully.');
    expect(effects.persisted).toEqual([
      { role: 'assistant', content: 'The command completed successfully.' },
    ]);
    expect(effects.sessionMessages).toEqual(effects.persisted);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('interactive approval records do not expire while cron approvals retain a timer', async () => {
  vi.useFakeTimers();
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-approval-helper-'));
  try {
    const harnessPath = path.join(runtimeDir, 'helper.mjs');
    fs.writeFileSync(
      harnessPath,
      `function normalizeOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function normalizeLowercaseStringOrEmpty(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
function isCronSessionKey(value) {
  return value.includes(":cron:");
}
function resolveTimerTimeoutMs(value) {
  return value;
}
function resolveExpiresAtMsFromDurationMs(value, options) {
  return options.nowMs + value;
}
${__testing.PATCHED_APPROVAL_TIMEOUT_HELPER}
class ApprovalManager {
  constructor() { this.pending = new Map(); }
${__testing.PATCHED_APPROVAL_CREATE}
        return { id, request: request5, createdAtMs: now, expiresAtMs };
      }
  register(record3, timeoutMs) {
    let resolvePromise;
    const promise = new Promise(resolve => { resolvePromise = resolve; });
    const entry = { record: record3, resolve: resolvePromise, timer: null, promise };
${__testing.PATCHED_APPROVAL_REGISTER_TIMER}
    this.pending.set(record3.id, entry);
    return promise;
  }
  expire(id) {
    const entry = this.pending.get(id);
    if (!entry) return;
    entry.resolve(null);
    this.pending.delete(id);
  }
  resolve(id, decision) {
    const entry = this.pending.get(id);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(decision);
    this.pending.delete(id);
  }
}
export { ApprovalManager };
`,
      'utf8',
    );
    const { ApprovalManager } = (await import(
      `${pathToFileURL(harnessPath).href}?test=${Date.now()}`
    )) as {
      ApprovalManager: new () => {
        create: (
          request: Record<string, unknown>,
          timeoutMs: number,
          id: string,
        ) => {
          expiresAtMs: number;
        };
        register: (record: unknown, timeoutMs: number) => Promise<unknown>;
        resolve: (id: string, decision: string) => void;
      };
    };

    const manager = new ApprovalManager();
    const interactive = manager.create(
      { sessionKey: 'agent:main:justdo:session-1', turnSourceChannel: 'webchat' },
      100,
      'interactive',
    );
    const cron = manager.create(
      { sessionKey: 'agent:main:cron:job-1', turnSourceChannel: 'webchat' },
      100,
      'cron',
    );
    const headless = manager.create({ sessionKey: 'agent:main:api:job-1' }, 100, 'headless');
    const interactiveDecision = manager.register(interactive, 100);
    const cronDecision = manager.register(cron, 100);
    const headlessDecision = manager.register(headless, 100);

    expect(interactive.expiresAtMs).toBe(Number.MAX_SAFE_INTEGER);
    expect(cron.expiresAtMs).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(headless.expiresAtMs).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(vi.getTimerCount()).toBe(2);

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(cronDecision).resolves.toBeNull();
    await expect(headlessDecision).resolves.toBeNull();

    let interactiveSettled = false;
    void interactiveDecision.finally(() => {
      interactiveSettled = true;
    });
    await Promise.resolve();
    expect(interactiveSettled).toBe(false);

    manager.resolve('interactive', 'allow-once');
    await expect(interactiveDecision).resolves.toBe('allow-once');

    const denied = manager.create(
      { sessionKey: 'agent:main:justdo:session-2', turnSourceChannel: 'webchat' },
      100,
      'denied',
    );
    const deniedDecision = manager.register(denied, 100);
    expect(vi.getTimerCount()).toBe(0);
    manager.resolve('denied', 'deny');
    await expect(deniedDecision).resolves.toBe('deny');
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('interactive native hook approval survives the automatic run timeout', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-approval-signal-'));
  try {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    fs.writeFileSync(bundlePath, BUNDLE_FIXTURE, 'utf8');
    applyPatch(runtimeDir);
    const bundle = (await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`)) as {
      resolvePendingGatewayDecision: (value: unknown) => void;
      waitForNativeHookRelayApprovalDecision: (params: {
        approvalId: string;
        sessionKey: string;
        signal: AbortSignal;
        timeoutMs: number;
      }) => Promise<unknown>;
    };
    const controller = new AbortController();
    const decision = bundle.waitForNativeHookRelayApprovalDecision({
      approvalId: 'approval-1',
      sessionKey: 'agent:main:justdo:session-1',
      signal: controller.signal,
      timeoutMs: 100,
    });

    const timeoutError = new Error('chat run timed out');
    timeoutError.name = 'TimeoutError';
    controller.abort(timeoutError);
    let settled = false;
    void decision.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    bundle.resolvePendingGatewayDecision({ decision: 'allow-once' });
    await expect(decision).resolves.toEqual({ decision: 'allow-once' });
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('explicit stop immediately aborts locally and denies the Gateway approval', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-approval-stop-'));
  try {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    fs.writeFileSync(bundlePath, BUNDLE_FIXTURE, 'utf8');
    applyPatch(runtimeDir);
    const bundle = (await import(`${pathToFileURL(bundlePath).href}?test=${Date.now()}`)) as {
      getLastGatewayResolution: () => string | undefined;
      waitForNativeHookRelayApprovalDecision: (params: {
        approvalId: string;
        sessionKey: string;
        signal: AbortSignal;
        timeoutMs: number;
      }) => Promise<unknown>;
    };
    const controller = new AbortController();
    const decision = bundle.waitForNativeHookRelayApprovalDecision({
      approvalId: 'approval-1',
      sessionKey: 'agent:main:justdo:session-1',
      signal: controller.signal,
      timeoutMs: 100,
    });

    controller.abort();

    await expect(decision).rejects.toMatchObject({ name: 'AbortError' });
    expect(bundle.getLastGatewayResolution()).toBe('deny');
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('webchat exec approvals use async follow-up while other native channels stay inline', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-approval-routing-'));
  try {
    const harnessPath = path.join(runtimeDir, 'routing.mjs');
    fs.writeFileSync(
      harnessPath,
      `function normalizeMessageChannel2(value) { return value; }
function isNativeApprovalChannel(value) { return value === "webchat" || value === "terminal"; }
${__testing.PATCHED_INLINE_EXEC_APPROVAL}
export { shouldAwaitGatewayApprovalInline };
`,
      'utf8',
    );
    const { shouldAwaitGatewayApprovalInline } = (await import(
      `${pathToFileURL(harnessPath).href}?test=${Date.now()}`
    )) as {
      shouldAwaitGatewayApprovalInline: (params: Record<string, unknown>) => boolean;
    };

    expect(shouldAwaitGatewayApprovalInline({ turnSourceChannel: 'webchat' })).toBe(false);
    expect(shouldAwaitGatewayApprovalInline({ turnSourceChannel: 'terminal' })).toBe(true);
    expect(
      shouldAwaitGatewayApprovalInline({
        turnSourceChannel: 'terminal',
        approvalFollowupMode: 'direct',
      }),
    ).toBe(false);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('fails loudly when an upstream patch point changes', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-approval-mismatch-'));
  try {
    fs.writeFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'function changed() {}', 'utf8');
    expect(() => applyPatch(runtimeDir)).toThrow(/patch target not found/i);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
