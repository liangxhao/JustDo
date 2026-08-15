import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

const { applyPatch, verifyPatch } =
  require('../scripts/patches/v2026.6.11/023-managed-subagent-join.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
    verifyPatch: (runtimeDir: string) => boolean;
  };

const FIXTURE = `
function resolveSession(opts) {
  const sessionKey = opts.sessionKey;
  const sessionEntry = opts.sessionEntry;
  const sessionCfg = opts.sessionCfg;
  const sessionAgentId = opts.agentId;
  const storePath = opts.storePath;
  const requestedSessionId = opts.sessionId?.trim() || void 0;
  const terminalMainTranscriptNewerThanRegistry = sessionEntry && !requestedSessionId ? hasTerminalMainSessionTranscriptNewerThanRegistrySync({
    entry: sessionEntry
  }) : false;
  const fresh = opts.fresh;
  const sessionId = requestedSessionId || (fresh ? sessionEntry?.sessionId : void 0) || crypto31.randomUUID();
  const isNewSession = !fresh && !requestedSessionId;
  const resolvedSessionEntry = terminalMainTranscriptNewerThanRegistry ? clearRotatedTerminalMainSessionMetadata(sessionEntry) : sessionEntry;
  return { sessionId, isNewSession, resolvedSessionEntry };
}
function resolveSubagentSpawnAcceptedNote(params) {
  if (params.spawnMode === "session") return SUBAGENT_SPAWN_SESSION_ACCEPTED_NOTE;
  return isCronSessionKey(params.agentSessionKey) ? void 0 : SUBAGENT_SPAWN_ACCEPTED_NOTE;
}
function fixtureRegisterSubagentRun(registerParams) {
  return {
      cleanup: registerParams.cleanup,
      expectsCompletionMessage: registerParams.expectsCompletionMessage,
  };
}
function fixtureNativeRegistration(requesterAgentId, cleanup, label2, requesterInternalKey) {
  return {
      requesterAgentId,
      cleanup,
      label: label2 || void 0,
  };
}
function fixtureAcpRegistration(result, expectsCompletionMessage, ownership, trackedCleanup, opts, label2) {
  const shouldExpectCompletionMessage = result.inlineDelivery ? false : expectsCompletionMessage;
  try {
    return {
              requesterAgentId: opts?.requesterAgentIdOverride,
              cleanup: trackedCleanup,
              label: label2 || void 0,
    };
  } catch {}
}
function createSessionsSpawnTool(opts) {
  return {
    execute: async (_toolCallId, args2) => {
      const params = args2;
      const expectsCompletionMessage = params.expectsCompletionMessage !== false;
      return { expectsCompletionMessage };
    }
  };
}
function createSessionsYieldTool(opts) {
  return {
    label: "Yield",
    name: "sessions_yield",
    description: "End current turn. Use after spawning subagents; results arrive as next message.",
    parameters: SessionsYieldToolSchema,
    execute: async (_toolCallId, args2) => {
      const message2 = readStringParam(args2, "message") || "Turn yielded.";
      if (!opts?.sessionId) return jsonResult({ status: "error", error: "No session context" });
      if (!opts?.onYield) return jsonResult({
        status: "error",
        error: "Yield not supported in this context"
      });
      await opts.onYield(message2);
      return jsonResult({ status: "yielded", message: message2 });
    }
  };
}
function createTools(options2) {
  return [createSessionsYieldTool({
      sessionId: options2?.sessionId,
      agentSessionKey: options2?.agentSessionKey,
      runId: options2?.runId,
      onYield: options2?.onYield
    })];
}
async function resolveAgentSession() {
            const failedSessionTranscriptMissing = false;
            const terminalMainTranscriptNewerThanRegistry = false;
            const freshness = { fresh: false };
            const entry = { sessionId: "stable" };
            const canonicalKey = "agent:main:justdo:local";
            const canReuseSession = Boolean(entry?.sessionId) && (freshness?.fresh ?? false) && !failedSessionTranscriptMissing && !terminalMainTranscriptNewerThanRegistry;
            const requestedSessionId = "stale";
            let usableRequestedSessionId = requestedSessionId && (!entry?.sessionId || canReuseSession) ? requestedSessionId : void 0;
            const sessionId = usableRequestedSessionId ? usableRequestedSessionId : (canReuseSession ? entry?.sessionId : void 0) ?? randomUUID49();
            return { canReuseSession, sessionId };
}
async function sendSubagentAnnounceDirectly(params) {
    const shouldDeliverAgentFinal = false;
    const deliveryTarget = {};
    const sessionOnlyOriginChannel = false;
    const sessionOnlyOrigin = {};
    const directAgentThreadId = shouldDeliverAgentFinal ? stringifyRouteThreadId(deliveryTarget.threadId) : sessionOnlyOriginChannel ? stringifyRouteThreadId(sessionOnlyOrigin?.threadId) : void 0;
    return directAgentThreadId;
}
function installSessionToolResultGuard(opts) {
  const persistToolResult = (message2) => message2;
  const capToolResultForPersistence = (message2) => message2;
  const appendMessageAndCacheTranscriptSeq = () => ({ entryId: "entry-1" });
  const persistedToolResult = {};
  const normalizedToolResult = {};
  const toolResultTransformerMayMutate = false;
  const redactionConfig = {};
  const maxToolResultChars = 1000;
  const callerInvalidatesCache = false;
  const persisted = { message: {}, changed: false };
  const id = "yield-call";
  const toolName3 = "sessions_yield";
  if (!persisted) return;
  return appendMessageAndCacheTranscriptSeq(capToolResultForPersistence(persisted.message, maxToolResultChars, redactionConfig), { invalidateSerializedPrefixCache: callerInvalidatesCache || persistedToolResult !== normalizedToolResult || toolResultTransformerMayMutate || persisted.changed }).entryId;
  const finalMessage = {};
  const finalRole = "assistant";
  const transformedMessage = finalMessage;
  const nextMessage = finalMessage;
  const finalWrite = { changed: false };
  const { entryId: result, messageSeq, sessionFile } = appendMessageAndCacheTranscriptSeq(finalMessage, { invalidateSerializedPrefixCache: callerInvalidatesCache || transformedMessage !== nextMessage || finalWrite.changed });
  return { result, messageSeq, sessionFile, toolName3 };
}
function fixtureLifecycleController(removeInternalSessionEffectsTranscript) {
  const completeCleanupBookkeeping2 = (cleanupParams) => {
    removeInternalSessionEffectsTranscript(cleanupParams.entry.execution?.transcriptFile);
    return cleanupParams;
  };
  return completeCleanupBookkeeping2;
}
function restoreSubagentRunsOnce() {
  if (restoreAttempted2) return;
  restoreAttempted2 = true;
  try {
    if (subagentRegistryDeps.restoreSubagentRunsFromDisk({
      runs: subagentRuns,
      mergeOnly: true
    }) === 0) return;
    if (reconcileOrphanedRestoredRuns({
      runs: subagentRuns,
      resumedRuns
    })) persistSubagentRuns();
    if (subagentRuns.size === 0) return;
  } catch (err3) {}
}
`;

test('incrementally joins managed subagents in the original tool call and pins session ids', async () => {
  vi.useFakeTimers();
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-managed-join-'));
  try {
    fs.writeFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), FIXTURE, 'utf8');
    expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    expect(verifyPatch(runtimeDir)).toBe(true);
    expect(applyPatch(runtimeDir)).toEqual([]);

    const patched = fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8');
    expect(patched).toContain('JUSTDO_MANAGED_SUBAGENT_JOIN_V1');
    expect(patched).toContain('JUSTDO_MANAGED_SUBAGENT_INCREMENTAL_JOIN_V1');
    expect(patched).toContain('JUSTDO_MANAGED_SUBAGENT_RELIABLE_JOIN_V1');
    expect(patched).toContain('JUSTDO_MANAGED_JOIN_TOOL_RESULT_COMMIT_V1');
    expect(patched).toContain('JUSTDO_MANAGED_JOIN_CONTINUATION_COMMIT_V1');
    expect(patched).not.toContain('JUSTDO_MANAGED_JOIN_TOOL_BATCH_COMMIT_V1');
    expect(patched).toContain(
      'if (finalRole === "assistant" && finalMessage.stopReason === "stop" && toolCalls.length === 0) commitJustDoManagedSubagentJoinContinuation(opts?.sessionKey);',
    );
    expect(patched).toContain('JUSTDO_MANAGED_SUBAGENT_DELETE_RETENTION_V1');
    expect(patched).toContain('JUSTDO_MANAGED_SESSION_ID_STABILITY_V1');
    expect(patched).toContain('JUSTDO_MANAGED_SUBAGENT_RECOVERY_V1');
    expect(patched).toContain('JUSTDO_MANAGED_JOIN_ANNOUNCE_SUPPRESSION_V1');
    expect(patched).toContain('entry.justDoJoinStartedAt = joinStartedAt');
    expect(patched).toContain('justDoManagedSession || (freshness?.fresh ?? false)');
    expect(patched).toContain(
      '(justDoManagedSession ? sessionEntry?.sessionId : void 0) || requestedSessionId',
    );
    expect(patched).toContain('entry.sessionId.trim() === requestedSessionId');

    const lifecycleSource = patched.slice(
      patched.indexOf('function fixtureLifecycleController('),
      patched.indexOf('\nfunction restoreSubagentRunsOnce()'),
    );
    expect(lifecycleSource).toBeTruthy();
    const createCleanupBookkeeping = new Function(
      `${lifecycleSource}; return fixtureLifecycleController;`,
    )() as (removeEffects: () => void) => (params: Record<string, unknown>) => unknown;
    const cleanupParams = {
      cleanup: 'keep',
      entry: {
        cleanup: 'keep',
        justDoJoinOriginalCleanup: 'delete',
        execution: {},
      },
    };
    createCleanupBookkeeping(() => undefined)(cleanupParams);
    expect(cleanupParams).toMatchObject({ cleanup: 'delete', entry: { cleanup: 'delete' } });

    const resolveSessionSource = patched.match(
      /function resolveSession\(opts\) \{[\s\S]*?\n\}/,
    )?.[0];
    expect(resolveSessionSource).toBeTruthy();
    const resolveSession = new Function(
      'hasTerminalMainSessionTranscriptNewerThanRegistrySync',
      'clearRotatedTerminalMainSessionMetadata',
      'crypto31',
      `${resolveSessionSource}; return resolveSession;`,
    )(
      () => true,
      () => ({ rotated: true }),
      { randomUUID: () => 'generated' },
    ) as (opts: Record<string, unknown>) => { sessionId: string; isNewSession: boolean };
    expect(
      resolveSession({
        sessionKey: 'agent:main:justdo:local',
        sessionEntry: { sessionId: 'sid-stable' },
        sessionId: 'sid-stale-request',
        fresh: false,
      }),
    ).toMatchObject({ sessionId: 'sid-stable', isNewSession: false });

    const resolveAgentSessionSource = patched.match(
      /async function resolveAgentSession\(\) \{[\s\S]*?\n\}/,
    )?.[0];
    expect(resolveAgentSessionSource).toBeTruthy();
    const resolveAgentSession = new Function(
      'randomUUID49',
      `${resolveAgentSessionSource}; return resolveAgentSession;`,
    )(() => 'generated') as () => Promise<{ canReuseSession: boolean; sessionId: string }>;
    await expect(resolveAgentSession()).resolves.toEqual({
      canReuseSession: true,
      sessionId: 'stable',
    });

    const recoverySource = patched.slice(
      patched.indexOf('// JUSTDO_MANAGED_SUBAGENT_RECOVERY_V1'),
      patched.indexOf('\nfunction restoreSubagentRunsOnce()'),
    );
    const promoteRecoveredJoins = new Function(
      'restoreJustDoManagedSubagentCleanup',
      `${recoverySource}; return promoteUnconsumedJustDoJoinsForRecovery;`,
    )((entry: Record<string, unknown>) => {
      if (entry.justDoJoinOriginalCleanup === 'delete') entry.cleanup = 'delete';
      entry.justDoJoinOriginalCleanup = undefined;
    }) as (runs: Map<string, Record<string, unknown>>) => boolean;
    const restoredRuns = new Map<string, Record<string, unknown>>([
      [
        'pending-run',
        {
          runId: 'pending-run',
          requesterSessionKey: 'agent:main:justdo:local',
          expectsCompletionMessage: false,
          justDoJoinStartedAt: 10,
          cleanupCompletedAt: 20,
          cleanupHandled: true,
        },
      ],
      [
        'consumed-run',
        {
          runId: 'consumed-run',
          requesterSessionKey: 'agent:main:justdo:local',
          expectsCompletionMessage: false,
          justDoJoinConsumedAt: 10,
        },
      ],
      [
        'fire-and-forget-run',
        {
          runId: 'fire-and-forget-run',
          requesterSessionKey: 'agent:main:justdo:local',
          expectsCompletionMessage: false,
        },
      ],
      [
        'persisted-result-run',
        {
          runId: 'persisted-result-run',
          requesterSessionKey: 'agent:main:justdo:local',
          expectsCompletionMessage: false,
          justDoJoinStartedAt: 10,
          justDoJoinPresentedAt: 20,
          justDoJoinToolCallId: 'call-persisted',
          justDoJoinTranscriptCommittedAt: 30,
          cleanup: 'keep',
          justDoJoinOriginalCleanup: 'delete',
        },
      ],
    ]);
    expect(promoteRecoveredJoins(restoredRuns)).toBe(true);
    expect(restoredRuns.get('pending-run')).toMatchObject({
      expectsCompletionMessage: true,
      delivery: { status: 'pending' },
      cleanupHandled: false,
    });
    expect(restoredRuns.get('pending-run')?.cleanupCompletedAt).toBeUndefined();
    expect(restoredRuns.get('consumed-run')?.expectsCompletionMessage).toBe(false);
    expect(restoredRuns.get('fire-and-forget-run')).not.toHaveProperty('delivery');
    expect(restoredRuns.get('persisted-result-run')).not.toHaveProperty('justDoJoinConsumedAt');
    expect(restoredRuns.get('persisted-result-run')).toMatchObject({
      expectsCompletionMessage: true,
      delivery: { status: 'pending' },
      cleanup: 'delete',
    });

    const sendAnnounceSource = patched.match(
      /async function sendSubagentAnnounceDirectly\(params\) \{[\s\S]*?\n\}/,
    )?.[0];
    expect(sendAnnounceSource).toBeTruthy();
    const sendAnnounce = new Function(
      'getSubagentRunByChildSessionKey2',
      'stringifyRouteThreadId',
      `${sendAnnounceSource}; return sendSubagentAnnounceDirectly;`,
    )(
      () => ({ expectsCompletionMessage: false, justDoJoinStartedAt: 1 }),
      () => undefined,
    ) as (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
    await expect(sendAnnounce({ sourceSessionKey: 'child-1' })).resolves.toMatchObject({
      delivered: true,
      path: 'none',
    });

    const helperAndTool = patched
      .match(/\/\/ JUSTDO_MANAGED_SUBAGENT_JOIN_V1[\s\S]*?\nfunction createSkillWorkshopTool/)?.[0]
      .replace('\nfunction createSkillWorkshopTool', '');
    const source =
      helperAndTool ??
      patched.slice(
        patched.indexOf('// JUSTDO_MANAGED_SUBAGENT_JOIN_V1'),
        patched.indexOf('\nfunction createTools'),
      );
    const childEntry: Record<string, unknown> = {
      runId: 'child-1',
      childSessionKey: 'agent:main:subagent:child-1',
      requesterSessionKey: 'agent:main:justdo:local',
      cleanup: 'delete',
    };
    const slowChildEntry: Record<string, unknown> = {
      runId: 'child-2',
      childSessionKey: 'agent:main:subagent:child-2',
      requesterSessionKey: 'agent:main:justdo:local',
    };
    const runs: Array<Record<string, unknown>> = [childEntry, slowChildEntry];
    const registry = new Map(runs.map(entry => [entry.runId as string, entry]));
    const persistSubagentRunsOrThrow = vi.fn();
    const completeCleanupBookkeeping = vi.fn(
      ({ runId }: { runId: string }) => void registry.delete(runId),
    );
    const joinRuntime = new Function(
      'SessionsYieldToolSchema',
      'readStringParam',
      'jsonResult',
      'listControlledSubagentRuns',
      'getSubagentRunByChildSessionKey2',
      'persistSubagentRunsOrThrow',
      'subagentRuns',
      'completeCleanupBookkeeping',
      `${source}; return { createSessionsYieldTool, markJustDoManagedSubagentJoinToolResultPersisted, commitJustDoManagedSubagentJoinContinuation };`,
    )(
      {},
      (args: Record<string, unknown>, key: string) => args[key],
      (value: unknown) => value,
      () => runs,
      () => undefined,
      persistSubagentRunsOrThrow,
      registry,
      completeCleanupBookkeeping,
    ) as {
      createSessionsYieldTool: (opts: Record<string, unknown>) => {
        execute: (
          toolCallId: string,
          args: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      };
      markJustDoManagedSubagentJoinToolResultPersisted: (
        controllerSessionKey: string,
        toolCallId: string,
      ) => void;
      commitJustDoManagedSubagentJoinContinuation: (controllerSessionKey: string) => void;
    };
    const createTool = joinRuntime.createSessionsYieldTool;
    const markToolResultPersisted = joinRuntime.markJustDoManagedSubagentJoinToolResultPersisted;
    const commitContinuation = joinRuntime.commitJustDoManagedSubagentJoinContinuation;

    const onYield = vi.fn();
    const tool = createTool({
      sessionId: 'stable',
      agentSessionKey: 'agent:main:justdo:local',
      onYield,
    });
    const firstJoin = tool.execute('call-1', { message: 'wait' });
    let firstJoinSettled = false;
    void firstJoin.then(() => {
      firstJoinSettled = true;
    });
    Object.assign(childEntry, {
      endedAt: 20,
      outcome: { status: 'ok' },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(firstJoinSettled).toBe(false);
    Object.assign(childEntry, {
      completion: { resultText: 'done', capturedAt: 30 },
    });
    await vi.advanceTimersByTimeAsync(100);
    await expect(firstJoin).resolves.toMatchObject({
      status: 'partial',
      pending: 1,
      results: [{ runId: 'child-1', status: 'ok', result: 'done' }],
    });
    expect(onYield).not.toHaveBeenCalled();
    expect(runs[0]).toMatchObject({
      expectsCompletionMessage: false,
      delivery: { status: 'not_required' },
      justDoJoinToolCallId: 'call-1',
    });
    expect(runs[0]).toHaveProperty('justDoJoinPresentedAt');
    expect(runs[0]).not.toHaveProperty('justDoJoinConsumedAt');
    expect(runs[0]).toMatchObject({ cleanup: 'keep', justDoJoinOriginalCleanup: 'delete' });
    markToolResultPersisted('agent:main:justdo:local', 'call-1');
    expect(runs[0]).toHaveProperty('justDoJoinTranscriptCommittedAt');
    expect(runs[0]).not.toHaveProperty('justDoJoinConsumedAt');
    commitContinuation('agent:main:justdo:local');
    expect(runs[0]).toHaveProperty('justDoJoinConsumedAt');
    expect(completeCleanupBookkeeping).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'child-1', cleanup: 'delete' }),
    );
    expect(registry.has('child-1')).toBe(false);
    expect(runs[1]).not.toHaveProperty('justDoJoinConsumedAt');

    const secondJoin = tool.execute('call-2', { message: 'wait again' });
    const concurrentJoin = tool.execute('call-concurrent', { message: 'wait concurrently' });
    Object.assign(slowChildEntry, {
      endedAt: 40,
      outcome: { status: 'ok' },
      completion: { resultText: 'slow done', capturedAt: 50 },
    });
    await vi.advanceTimersByTimeAsync(100);
    await expect(secondJoin).resolves.toMatchObject({
      status: 'completed',
      pending: 0,
      results: [{ runId: 'child-2', status: 'ok', result: 'slow done' }],
    });
    await expect(concurrentJoin).resolves.toMatchObject({
      status: 'no_active_subagents',
      results: [],
    });
    expect(runs[1]).not.toHaveProperty('justDoJoinConsumedAt');
    markToolResultPersisted('agent:main:justdo:local', 'call-2');
    commitContinuation('agent:main:justdo:local');
    expect(runs[1]).toHaveProperty('justDoJoinConsumedAt');
    expect(persistSubagentRunsOrThrow).toHaveBeenCalled();
    await expect(tool.execute('call-3', { message: 'nothing left' })).resolves.toMatchObject({
      status: 'no_active_subagents',
      results: [],
    });
  } finally {
    vi.useRealTimers();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('restores completion delivery when a managed join is aborted', async () => {
  vi.useFakeTimers();
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-managed-join-abort-'));
  try {
    fs.writeFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), FIXTURE, 'utf8');
    applyPatch(runtimeDir);
    const patched = fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8');
    const source = patched.slice(
      patched.indexOf('// JUSTDO_MANAGED_SUBAGENT_JOIN_V1'),
      patched.indexOf('\nfunction createTools'),
    );
    const childEntry: Record<string, unknown> = {
      runId: 'child-abort',
      childSessionKey: 'agent:main:subagent:child-abort',
      requesterSessionKey: 'agent:main:justdo:local',
    };
    const runs = [childEntry];
    const registry = new Map([['child-abort', childEntry]]);
    const persistSubagentRunsOrThrow = vi.fn();
    const createTool = new Function(
      'SessionsYieldToolSchema',
      'readStringParam',
      'jsonResult',
      'listControlledSubagentRuns',
      'getSubagentRunByChildSessionKey2',
      'persistSubagentRunsOrThrow',
      'subagentRuns',
      `${source}; return createSessionsYieldTool;`,
    )(
      {},
      (args: Record<string, unknown>, key: string) => args[key],
      (value: unknown) => value,
      () => runs,
      () => undefined,
      persistSubagentRunsOrThrow,
      registry,
    ) as (opts: Record<string, unknown>) => {
      execute: (
        toolCallId: string,
        args: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
    };

    const abortController = new AbortController();
    const result = createTool({
      sessionId: 'stable',
      agentSessionKey: 'agent:main:justdo:local',
      abortSignal: abortController.signal,
    }).execute('call-abort', { message: 'wait' });
    abortController.abort();
    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toMatchObject({ status: 'aborted' });
    expect(childEntry).toMatchObject({
      expectsCompletionMessage: true,
      delivery: { status: 'pending' },
    });
    expect(childEntry.justDoJoinStartedAt).toBeUndefined();

    const persistenceFailureEntry: Record<string, unknown> = {
      runId: 'child-persistence-failure',
      childSessionKey: 'agent:main:subagent:child-persistence-failure',
      requesterSessionKey: 'agent:main:justdo:local',
    };
    runs.splice(0, runs.length, persistenceFailureEntry);
    registry.clear();
    registry.set('child-persistence-failure', persistenceFailureEntry);
    persistSubagentRunsOrThrow.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    await expect(
      createTool({
        sessionId: 'stable',
        agentSessionKey: 'agent:main:justdo:local',
      }).execute('call-persistence-failure', { message: 'wait' }),
    ).resolves.toMatchObject({
      status: 'error',
      error: expect.stringContaining('disk full'),
    });
    expect(persistenceFailureEntry).toMatchObject({
      expectsCompletionMessage: true,
      delivery: { status: 'pending' },
    });
  } finally {
    vi.useRealTimers();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('upgrades an already patched legacy managed join bundle', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-managed-join-upgrade-'));
  try {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    fs.writeFileSync(bundlePath, FIXTURE, 'utf8');
    applyPatch(runtimeDir);
    let legacy = fs
      .readFileSync(bundlePath, 'utf8')
      .replace('// JUSTDO_MANAGED_SUBAGENT_RELIABLE_JOIN_V1\n', '')
      .replace(
        'if (finalRole === "assistant" && finalMessage.stopReason === "stop" && toolCalls.length === 0) commitJustDoManagedSubagentJoinContinuation(opts?.sessionKey);',
        'if (finalRole === "assistant" && toolCalls.length === 0) commitJustDoManagedSubagentJoinContinuation(opts?.sessionKey);',
      )
      .replace(
        '// JUSTDO_MANAGED_JOIN_TOOL_RESULT_COMMIT_V1\n      if (id)',
        '// JUSTDO_MANAGED_JOIN_TOOL_RESULT_COMMIT_V1\n      // JUSTDO_MANAGED_JOIN_TOOL_BATCH_COMMIT_V1\n      if (pendingState.size() === 0) commitJustDoManagedSubagentJoinContinuation(opts?.sessionKey);\n      if (id)',
      );

    const commitStart = legacy.indexOf('const appendedToolResult =');
    const commitEndMarker = 'return appendedToolResult.entryId;';
    const commitEnd = legacy.indexOf(commitEndMarker, commitStart) + commitEndMarker.length;
    expect(commitStart).toBeGreaterThanOrEqual(0);
    expect(commitEnd).toBeGreaterThan(commitStart);
    legacy = `${legacy.slice(0, commitStart)}return appendMessageAndCacheTranscriptSeq(capToolResultForPersistence(persisted.message, maxToolResultChars, redactionConfig), { invalidateSerializedPrefixCache: callerInvalidatesCache || persistedToolResult !== normalizedToolResult || toolResultTransformerMayMutate || persisted.changed }).entryId;${legacy.slice(commitEnd)}`;

    const recoveryStart = legacy.indexOf('// JUSTDO_MANAGED_SUBAGENT_RECOVERY_V1');
    const restoreStart = legacy.indexOf('function restoreSubagentRunsOnce()', recoveryStart);
    expect(recoveryStart).toBeGreaterThanOrEqual(0);
    expect(restoreStart).toBeGreaterThan(recoveryStart);
    const legacyRecovery = `// JUSTDO_MANAGED_SUBAGENT_RECOVERY_V1
function promoteUnconsumedJustDoJoinsForRecovery(runs) {
  let changed = false;
  for (const entry of runs.values()) {
    if (entry?.expectsCompletionMessage !== false || typeof entry?.justDoJoinConsumedAt === "number") continue;
    entry.expectsCompletionMessage = true;
    entry.delivery = { status: "pending" };
    changed = true;
  }
  return changed;
}
`;
    legacy = `${legacy.slice(0, recoveryStart)}${legacyRecovery}${legacy.slice(restoreStart)}`;
    fs.writeFileSync(bundlePath, legacy, 'utf8');

    expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    expect(verifyPatch(runtimeDir)).toBe(true);
    expect(applyPatch(runtimeDir)).toEqual([]);
    const upgraded = fs.readFileSync(bundlePath, 'utf8');
    expect(upgraded).toContain('JUSTDO_MANAGED_SUBAGENT_RELIABLE_JOIN_V1');
    expect(upgraded).toContain('JUSTDO_MANAGED_JOIN_TOOL_RESULT_COMMIT_V1');
    expect(upgraded).toContain('JUSTDO_MANAGED_JOIN_CONTINUATION_COMMIT_V1');
    expect(upgraded).toContain('finalMessage.stopReason === "stop"');
    expect(upgraded).not.toContain('JUSTDO_MANAGED_JOIN_TOOL_BATCH_COMMIT_V1');
    expect(upgraded).toContain('JUSTDO_MANAGED_SUBAGENT_RECOVERY_V2');
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
