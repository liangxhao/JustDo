import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

const { applyPatch } =
  require('../scripts/patches/v2026.6.11/005-history-thinking-and-subagent-yield.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
  };

const HISTORY_PROJECTION = `function projectAssistantTextFromMixedToolContent(content, maxChars) {
\tif (!content.some((block) => {
\t\tif (!block || typeof block !== "object") return false;
\t\treturn isToolHistoryBlockType(block.type);
\t})) return null;
\tconst textBlocks = [];
\tfor (const block of content) {
\t\tif (!block || typeof block !== "object") continue;
\t\tconst entry = block;
\t\tif (entry.type !== "text" || typeof entry.text !== "string" || !entry.text.trim()) continue;
\t\tconst truncated = truncateChatHistoryText(stripInlineDirectiveTagsForDisplay(entry.text).text, maxChars);
\t\tif (truncated.text.trim()) textBlocks.push({
\t\t\ttype: "text",
\t\t\ttext: truncated.text
\t\t});
\t}
\treturn textBlocks.length > 0 ? {
\t\tcontent: textBlocks,
\t\tchanged: true
\t} : null;
}`;

const DELIVERY_EVIDENCE = `function hasCommittedOutboundDeliveryEvidence(result) {
\treturn hasMessagingToolDeliveryEvidence(result) || Array.isArray(result.acceptedSessionSpawns) && hasAcceptedSessionSpawn(result.acceptedSessionSpawns) || hasPositiveNumber(result.successfulCronAdds);
}`;

test('preserves history thinking blocks and treats sessions_yield as delivery evidence', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-history-patch-'));
  try {
    fs.mkdirSync(path.join(runtimeDir, 'dist'));
    fs.writeFileSync(
      path.join(runtimeDir, 'dist', 'runtime.js'),
      `${HISTORY_PROJECTION}\n${DELIVERY_EVIDENCE}`,
      'utf8',
    );

    expect(applyPatch(runtimeDir)).toEqual([path.join('dist', 'runtime.js')]);
    const patched = fs.readFileSync(path.join(runtimeDir, 'dist', 'runtime.js'), 'utf8');

    expect(patched).toContain('const displayBlocks = []');
    expect(patched).toContain('entry.type === "thinking"');
    expect(patched).toContain('isToolHistoryBlockType(entry.type)');
    expect(patched).toContain('result.meta.toolSummary.tools.includes("sessions_yield")');
    expect(applyPatch(runtimeDir)).toEqual([]);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

const BUNDLE_HISTORY_PROJECTION = `function projectAssistantTextFromMixedToolContent(content, maxChars) {
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

const COMMENTARY_TOOL_VISIBILITY = `function hasAssistantMixedToolVisibleText(message2) {
  if (!message2 || typeof message2 !== "object") return false;
  const content = message2.content;
  if (!Array.isArray(content)) return false;
  let hasToolHistoryBlock = false;
  let hasText = false;
  for (const block3 of content) {
    if (!block3 || typeof block3 !== "object") continue;
    const entry = block3;
    if (isToolHistoryBlockType(entry.type)) hasToolHistoryBlock = true;
    if (isAssistantTextContentType(entry.type) && typeof entry.text === "string" && entry.text.trim()) hasText = true;
    if (isAssistantReasoningContentType(entry.type) && typeof entry.thinking === "string" && entry.thinking.trim()) hasText = true;
  }
  return hasToolHistoryBlock && hasText;
}`;

const YIELD_REFRESH = `async function settleYield(activeSession, activeSessionManager, yieldMessage) {
            await withOwnedSessionWriteLock(async () => {
              stripSessionsYieldArtifacts(activeSession);
              if (yieldMessage) await persistSessionsYieldContextMessage(activeSession, yieldMessage);
            });
}
class SessionManager {
      getLeafId() {
        return this.leafId;
      }
      getLeafEntry() {
        return this.leafId ? this.getEntry(this.leafId) : void 0;
      }
}
async function finalizeAnnounceTurn() {
        if (!beforeAgentFinalizeRevisionReason) {
          await sessionLockController.waitForSessionEvents(activeSession);
          await withOwnedSessionWriteLock(async () => {
            if (shouldPersistCompletedBootstrapTurn({
              shouldRecordCompletedBootstrapTurn,
              promptError,
              aborted: aborted3,
              timedOutDuringCompaction,
              compactionOccurredThisAttempt
            })) return;
          });
        }
}`;

const STRICT_ANNOUNCE = `async function sendSubagentAnnounceDirectly(params) {
  const announceTimeoutMs = 120000;
  const canonicalRequesterSessionKey = "parent";
  const isSubagentCompletion = true;
  const directAgentParams = {};
    const requesterActivity = resolveRequesterSessionActivity(canonicalRequesterSessionKey);
    let directAnnounceResponse = await getDirectAnnounceResponse();
    if (isGatewayAgentRunPending(directAnnounceResponse)) return {
      delivered: true,
      path: "direct"
    };
  return { delivered: true, path: "direct", response: directAnnounceResponse };
}
async function deliverSubagentAnnouncement(params) {
  return await runSubagentAnnounceDispatch({
    expectsCompletionMessage: params.expectsCompletionMessage,
    signal: params.signal,
    steer: async () => await maybeSteerSubagentAnnounce({
      requesterSessionKey: params.requesterSessionKey
    }),
    direct: async () => await sendSubagentAnnounceDirectly({
      sourceTool: params.sourceTool,
      targetRequesterSessionKey: params.targetRequesterSessionKey,
      triggerMessage: params.triggerMessage
    })
  });
}`;

const UNRELATED_NESTED_CALLBACK = `function resolveUnrelatedProvider(options) {
  return resolveDefinition({
    create: ({ provider }) => provider.create({
      enabled: true
    })
  });
}`;

test('reapplying the completion patch does not rewrite a later unrelated callback', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-history-patch-'));
  try {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    fs.writeFileSync(
      bundlePath,
      `${BUNDLE_HISTORY_PROJECTION}\n${STRICT_ANNOUNCE}\n${UNRELATED_NESTED_CALLBACK}`,
      'utf8',
    );
    expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    const once = fs.readFileSync(bundlePath, 'utf8');
    expect(applyPatch(runtimeDir)).toEqual([]);
    const twice = fs.readFileSync(bundlePath, 'utf8');
    expect(twice).toBe(once);
    expect(() => new Function(twice)).not.toThrow();
    const unrelated = twice.slice(twice.indexOf('function resolveUnrelatedProvider'));
    expect(unrelated).not.toContain('strictCompletion');
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('keeps mixed tool calls in authoritative history and defers completion promotion', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-history-patch-'));
  try {
    fs.writeFileSync(
      path.join(runtimeDir, 'gateway-bundle.mjs'),
      `${COMMENTARY_TOOL_VISIBILITY}\n${BUNDLE_HISTORY_PROJECTION}\n${YIELD_REFRESH}\n${STRICT_ANNOUNCE}`,
      'utf8',
    );

    expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    const patched = fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8');
    expect(patched).toContain('displayBlocks.push(block3);');
    const settleYieldSource = patched.match(/async function settleYield[\s\S]*?\n}/)?.[0];
    expect(settleYieldSource).toBeTruthy();
    expect(settleYieldSource).not.toContain('buildSessionContext()');
    expect(patched).toContain('promotePromptReleasedSideBranch() {');
    expect(patched).not.toContain('activeSessionManager.promotePromptReleasedSideBranch();');
    expect(patched).toContain('return hasToolHistoryBlock;');

    const projectionSource = patched.match(
      /function projectAssistantTextFromMixedToolContent[\s\S]*?\n}/,
    )?.[0];
    expect(projectionSource).toBeTruthy();
    const project = new Function(
      'isToolHistoryBlockType',
      'truncateChatHistoryText',
      'stripInlineDirectiveTagsForDisplay',
      `${projectionSource}; return projectAssistantTextFromMixedToolContent;`,
    )(
      (type: string) => type === 'toolCall',
      (text: string) => ({ text }),
      (text: string) => ({ text }),
    ) as (content: unknown[], maxChars: number) => { content: unknown[] };
    const blocks = [
      { type: 'thinking', thinking: 'plan' },
      { type: 'text', text: 'dispatch' },
      { type: 'toolCall', id: 'call-1', name: 'sessions_spawn', arguments: {} },
    ];
    expect(project(blocks, 8000).content).toEqual(blocks);

    const visibilitySource = patched.match(
      /function hasAssistantMixedToolVisibleText[\s\S]*?\n}/,
    )?.[0];
    expect(visibilitySource).toBeTruthy();
    const isVisibleCommentary = new Function(
      'isToolHistoryBlockType',
      'isAssistantTextContentType',
      'isAssistantReasoningContentType',
      `${visibilitySource}; return hasAssistantMixedToolVisibleText;`,
    )(
      (type: string) => type === 'toolCall',
      (type: string) => type === 'text',
      (type: string) => type === 'thinking',
    ) as (message: unknown) => boolean;
    expect(
      isVisibleCommentary({
        role: 'assistant',
        phase: 'commentary',
        content: [{ type: 'toolCall', id: 'call-only', name: 'sessions_spawn' }],
      }),
    ).toBe(true);
    expect(applyPatch(runtimeDir)).toEqual([]);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('promotes a completed announce side branch after outer delivery commit', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-history-patch-'));
  try {
    fs.writeFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), YIELD_REFRESH, 'utf8');
    expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    const patched = fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8');
    const methodSource = patched.match(
      /      promotePromptReleasedSideBranch\(\) \{[\s\S]*?\n      \}/,
    )?.[0];
    expect(methodSource).toBeTruthy();

    const promote = new Function(
      `return class {
        constructor() {
          this.leafId = 'yield-anchor';
          this.appendParentId = 'announce-tool-result';
          this.promptReleasedSideBranchParentId = 'announce-tool-result';
          this.entries = new Map([
            ['yield-anchor', { id: 'yield-anchor', parentId: null }],
            ['announce-tool-call', { id: 'announce-tool-call', parentId: 'yield-anchor' }],
            [
              'announce-tool-result',
              { id: 'announce-tool-result', parentId: 'announce-tool-call' },
            ],
          ]);
          this.persisted = [];
          this.remembered = [];
        }
        branch(id) {
          this.leafId = id;
          this.appendParentId = id;
          this.promptReleasedSideBranchParentId = undefined;
        }
        createLeafControl(parentId) {
          return { type: 'leaf', parentId, targetId: this.leafId };
        }
        buildSessionContext() {
          const ids = [];
          let current = this.entries.get(this.leafId);
          while (current) {
            ids.unshift(current.id);
            current = current.parentId ? this.entries.get(current.parentId) : undefined;
          }
          return { messages: ids };
        }
        persistRecord(entry) { this.persisted.push(entry); }
        rememberLeafControl(entry) { this.remembered.push(entry); }
${methodSource}
      };`,
    )() as new () => {
      leafId: string;
      appendParentId: string;
      persisted: Array<Record<string, string>>;
      remembered: Array<Record<string, string>>;
      buildSessionContext: () => { messages: string[] };
      promotePromptReleasedSideBranch: () => boolean;
    };
    const manager = new promote();
    expect(manager.buildSessionContext().messages).toEqual(['yield-anchor']);
    expect(manager.promotePromptReleasedSideBranch()).toBe(true);
    expect(manager.leafId).toBe('announce-tool-result');
    expect(manager.appendParentId).toBe('announce-tool-result');
    expect(manager.persisted).toEqual([
      {
        type: 'leaf',
        parentId: 'announce-tool-result',
        targetId: 'announce-tool-result',
      },
    ]);
    expect(manager.remembered).toEqual(manager.persisted);
    expect(manager.buildSessionContext().messages).toEqual([
      'yield-anchor',
      'announce-tool-call',
      'announce-tool-result',
    ]);
    expect(manager.promotePromptReleasedSideBranch()).toBe(false);

    expect(patched).not.toContain('const isCompletionAnnounceTurn =');
    expect(applyPatch(runtimeDir)).toEqual([]);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('serializes completion delivery per requester without blocking other parents', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-history-patch-'));
  try {
    fs.writeFileSync(
      path.join(runtimeDir, 'gateway-bundle.mjs'),
      `${BUNDLE_HISTORY_PROJECTION}\n${STRICT_ANNOUNCE}`,
      'utf8',
    );
    applyPatch(runtimeDir);
    const patched = fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8');
    const helperSource = patched.match(
      /const subagentCompletionAnnounceTails[\s\S]*?\n}\nasync function deliverSubagentAnnouncement/,
    )?.[0].replace(/\nasync function deliverSubagentAnnouncement$/, '');
    expect(helperSource).toBeTruthy();
    const withLock = new Function(
      `${helperSource}; return withSubagentCompletionAnnounceLock;`,
    )() as <T>(key: string, task: () => Promise<T>) => Promise<T>;

    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withLock('parent-a', async () => {
      events.push('a1-start');
      await firstGate;
      events.push('a1-end');
    });
    const secondTask = vi.fn(async () => {
      events.push('a2');
    });
    const second = withLock('parent-a', secondTask);
    const other = withLock('parent-b', async () => {
      events.push('b1');
    });

    await other;
    expect(events).toEqual(['a1-start', 'b1']);
    expect(secondTask).not.toHaveBeenCalled();
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['a1-start', 'b1', 'a1-end', 'a2']);

    const deliverySource = patched.slice(
      patched.indexOf('const subagentCompletionAnnounceTails ='),
    );
    const transcript: Array<{ type: string; toolCallId: string }> = [];
    let canonicalLength = 0;
    const observedPrompts: Array<Array<{ type: string; toolCallId: string }>> = [];
    const sendDirect = vi.fn(async (params: { triggerMessage: string }) => {
      observedPrompts.push(transcript.slice(0, canonicalLength));
      if (params.triggerMessage === 'first') {
        await new Promise(resolve => setTimeout(resolve, 5));
        transcript.push(
          { type: 'toolCall', toolCallId: 'spawn-from-first' },
          { type: 'toolResult', toolCallId: 'spawn-from-first' },
        );
      }
      return { delivered: true, path: 'direct' };
    });
    const deliver = new Function(
      'runSubagentAnnounceDispatch',
      'normalizeOptionalLowercaseString',
      'normalizeOptionalString',
      'maybeSteerSubagentAnnounce',
      'sendSubagentAnnounceDirectly',
      'subagentAnnounceDeliveryDeps',
      'resolveRequesterStoreKey',
      'loadRequesterSessionEntry',
      'acquireSessionWriteLock',
      'resolveSessionWriteLockOptions',
      'SessionManager',
      `${deliverySource}; return deliverSubagentAnnouncement;`,
    )(
      async (options: { direct: () => Promise<unknown> }) => await options.direct(),
      (value: unknown) => (typeof value === 'string' ? value.toLowerCase() : undefined),
      (value: unknown) => (typeof value === 'string' ? value : undefined),
      async () => ({ status: 'dropped' }),
      sendDirect,
      { getRuntimeConfig: () => ({}) },
      (_cfg: unknown, key: string) => key,
      () => ({ cfg: {}, entry: { sessionFile: 'parent.jsonl' } }),
      async () => ({ release: async () => {} }),
      () => ({}),
      {
        open: () => ({
          promotePromptReleasedSideBranch: () => {
            canonicalLength = transcript.length;
            return true;
          },
        }),
      },
    ) as (params: Record<string, unknown>) => Promise<unknown>;

    await Promise.all([
      deliver({
        expectsCompletionMessage: true,
        targetRequesterSessionKey: 'parent-c',
        triggerMessage: 'first',
      }),
      deliver({
        expectsCompletionMessage: true,
        targetRequesterSessionKey: 'parent-c',
        triggerMessage: 'second',
      }),
    ]);
    expect(observedPrompts).toEqual([
      [],
      [
        { type: 'toolCall', toolCallId: 'spawn-from-first' },
        { type: 'toolResult', toolCallId: 'spawn-from-first' },
      ],
    ]);
    expect(patched).toContain('async function promoteDeliveredSubagentCompletionBranch(');
    expect(patched).toContain(
      'if (delivery.delivered) await promoteDeliveredSubagentCompletionBranch(key);',
    );
    expect(patched).toContain('reason: "requester_busy"');
    expect(patched).toContain(
      '(normalizeOptionalLowercaseString(params.sourceTool) ?? "subagent_announce") === "subagent_announce"',
    );
    expect(patched).toContain(
      'steer: strictCompletion ? async () => ({ status: "dropped" })',
    );
    expect(patched).toContain('operation: "completion direct announce terminal confirmation"');

    const requesterWaitSource = patched.match(
      /async function waitForSubagentRequesterRunEnd[\s\S]*?\n}/,
    )?.[0];
    expect(requesterWaitSource).toBeTruthy();
    const waitForRequester = new Function(
      'waitForEmbeddedAgentRunEnd',
      `${requesterWaitSource}; return waitForSubagentRequesterRunEnd;`,
    )(() => new Promise<boolean>(() => {})) as (
      sessionId: string,
      timeoutMs: number,
      signal: AbortSignal,
    ) => Promise<boolean>;
    const abortController = new AbortController();
    const abortedWait = waitForRequester('requester-run', 120_000, abortController.signal);
    abortController.abort();
    await expect(abortedWait).resolves.toBe(false);

    const directStart = patched.indexOf('async function sendSubagentAnnounceDirectly');
    const directEnd = patched.indexOf('\nasync function waitForSubagentRequesterRunEnd', directStart);
    const directSource =
      directStart >= 0 && directEnd > directStart
        ? patched.slice(directStart, directEnd)
        : undefined;
    expect(directSource).toBeTruthy();
    let releaseRequester!: () => void;
    const requesterGate = new Promise<boolean>(resolve => {
      releaseRequester = () => resolve(true);
    });
    const terminalResponse = { status: 'completed', result: { payloads: [{ text: 'done' }] } };
    const runAgent = vi.fn(async () => terminalResponse);
    let activityReads = 0;
    const sendPendingDirect = new Function(
      'resolveRequesterSessionActivity',
      'getDirectAnnounceResponse',
      'isGatewayAgentRunPending',
      'waitForSubagentRequesterRunEnd',
      'runAnnounceDeliveryWithRetry',
      'runAnnounceAgentCall',
      `${directSource}; return sendSubagentAnnounceDirectly;`,
    )(
      () => ({ sessionId: 'requester-run', isActive: activityReads++ > 0 }),
      async () => ({ status: 'accepted' }),
      (response: { status: string }) => response.status === 'accepted',
      async () => await requesterGate,
      async ({ run }: { run: () => Promise<unknown> }) => await run(),
      runAgent,
    ) as (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
    let settled = false;
    const pendingDelivery = sendPendingDirect({ expectsCompletionMessage: true }).then(result => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(runAgent).not.toHaveBeenCalled();
    releaseRequester();
    await expect(pendingDelivery).resolves.toMatchObject({ delivered: true, path: 'direct' });
    expect(runAgent).toHaveBeenCalledOnce();
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

const REGISTRY_QUEUE_FIXTURE = `function createSubagentRegistryLifecycleController(params) {
  const finalizeSubagentCleanup = params.finalizeSubagentCleanup;
  const resolveAnnounceRetryDelayMs = () => 0;
  const getDeliveryAttemptCount = () => 0;
  const scheduleResumeSubagentRun = (runId, entry, delayMs) => params.scheduleResumeSubagentRun(runId, entry, delayMs);
  const retryDeferredCompletedAnnounces = runId => params.retryDeferredCompletedAnnounces(runId);
  const beginSubagentCleanup = (runId) => {
    const entry = params.runs.get(runId);
    if (!entry) return false;
    if (entry.cleanupCompletedAt || entry.cleanupHandled) return false;
    entry.cleanupHandled = true;
    params.persist();
    return true;
  };
  const startSubagentAnnounceCleanupFlow2 = (runId, entry) => {
    if (typeof entry.delivery?.announcedAt === "number" || entry.delivery?.status === "delivered") {
      if (!beginSubagentCleanup(runId)) return false;
      finalizeSubagentCleanup(runId, entry.cleanup, true, { skipAnnounce: true }).catch((err3) => {
        const current = params.runs.get(runId);
        if (!current || current.cleanupCompletedAt) return;
        current.cleanupHandled = false;
        params.persist();
      });
      return true;
    }
    if (!beginSubagentCleanup(runId)) return false;
    if (entry.expectsCompletionMessage === false) return true;
    return true;
  };
  const completeSubagentRun2 = async (entry, endedAt) => {
    let mutated = false;
    if (entry.endedAt !== endedAt) {
      entry.endedAt = endedAt;
      entry.execution = {
        ...entry.execution,
        status: "terminal",
        startedAt: entry.startedAt,
        endedAt
      };
      mutated = true;
    }
    return mutated;
  };
  return { startSubagentAnnounceCleanupFlow2, completeSubagentRun2 };
}`;

test('keeps failed completion retries at the persistent per-parent queue head', async () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-history-patch-'));
  try {
    fs.writeFileSync(
      path.join(runtimeDir, 'gateway-bundle.mjs'),
      REGISTRY_QUEUE_FIXTURE,
      'utf8',
    );
    expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    const patched = fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8');
    expect(patched).toContain(
      'scheduleResumeSubagentRun(runId, current, resolveAnnounceRetryDelayMs(getDeliveryAttemptCount(current)))',
    );
    const queueHelpers = patched
      .match(
        /  const ensureCompletionDeliveryQueueSequence[\s\S]*?  const beginSubagentCleanup/,
      )?.[0]
      .replace(/  const beginSubagentCleanup$/, '');
    expect(queueHelpers).toBeTruthy();

    const runs = new Map<string, Record<string, any>>();
    const params = { runs };
    const ensureDeliveryState = (entry: Record<string, any>) => {
      entry.delivery ??= { status: 'pending' };
      return entry.delivery;
    };
    const queue = new Function(
      'params',
      'ensureDeliveryState',
      `${queueHelpers}; return { ensureCompletionDeliveryQueueSequence, hasEarlierPendingCompletionDelivery };`,
    )(params, ensureDeliveryState) as {
      ensureCompletionDeliveryQueueSequence: (entry: Record<string, any>) => boolean;
      hasEarlierPendingCompletionDelivery: (
        runId: string,
        entry: Record<string, any>,
      ) => boolean;
    };
    const first = {
      runId: 'run-a',
      requesterSessionKey: 'parent-a',
      expectsCompletionMessage: true,
      createdAt: 1,
      endedAt: 10,
      delivery: { status: 'pending' },
    };
    const second = {
      runId: 'run-b',
      requesterSessionKey: 'parent-a',
      expectsCompletionMessage: true,
      createdAt: 2,
      endedAt: 20,
      delivery: { status: 'pending' },
    };
    runs.set(first.runId, first);
    queue.ensureCompletionDeliveryQueueSequence(first);
    runs.set(second.runId, second);
    queue.ensureCompletionDeliveryQueueSequence(second);

    expect(queue.hasEarlierPendingCompletionDelivery(first.runId, first)).toBe(false);
    expect(queue.hasEarlierPendingCompletionDelivery(second.runId, second)).toBe(true);
    first.delivery.lastError = 'requester_busy';
    expect(queue.hasEarlierPendingCompletionDelivery(second.runId, second)).toBe(true);

    const restoredRuns = new Map<string, Record<string, any>>(
      JSON.parse(JSON.stringify([...runs.entries()])),
    );
    const restoredQueue = new Function(
      'params',
      'ensureDeliveryState',
      `${queueHelpers}; return { hasEarlierPendingCompletionDelivery };`,
    )({ runs: restoredRuns }, ensureDeliveryState) as {
      hasEarlierPendingCompletionDelivery: (
        runId: string,
        entry: Record<string, any>,
      ) => boolean;
    };
    expect(
      restoredQueue.hasEarlierPendingCompletionDelivery(
        'run-b',
        restoredRuns.get('run-b')!,
      ),
    ).toBe(true);
    restoredRuns.get('run-a')!.delivery.status = 'delivered';
    expect(
      restoredQueue.hasEarlierPendingCompletionDelivery(
        'run-b',
        restoredRuns.get('run-b')!,
      ),
    ).toBe(false);

    first.delivery.status = 'delivered';
    second.delivery.status = 'pending';
    let finalizeAttempts = 0;
    const scheduled: string[] = [];
    const deferredWakes: string[] = [];
    const createController = new Function(
      'ensureDeliveryState',
      'defaultRuntime',
      `${patched}; return createSubagentRegistryLifecycleController;`,
    )(ensureDeliveryState, { log: vi.fn() }) as (params: Record<string, any>) => {
      startSubagentAnnounceCleanupFlow2: (runId: string, entry: Record<string, any>) => boolean;
    };
    const controller = createController({
      runs,
      persist: vi.fn(),
      resumedRuns: new Set(['run-a', 'run-b']),
      finalizeSubagentCleanup: async (runId: string) => {
        finalizeAttempts += 1;
        if (runId === 'run-a' && finalizeAttempts === 1) throw new Error('cleanup failed');
        runs.get(runId)!.cleanupCompletedAt = Date.now();
        runs.get(runId)!.delivery.status = 'delivered';
      },
      scheduleResumeSubagentRun: (runId: string) => scheduled.push(runId),
      retryDeferredCompletedAnnounces: (runId: string) => deferredWakes.push(runId),
    });

    expect(controller.startSubagentAnnounceCleanupFlow2('run-a', first)).toBe(true);
    await vi.waitFor(() => expect(scheduled).toEqual(['run-a']));
    expect(deferredWakes).toEqual(['run-a']);
    expect(first.cleanupHandled).toBe(false);
    expect(controller.startSubagentAnnounceCleanupFlow2('run-a', first)).toBe(true);
    await vi.waitFor(() => expect(first.cleanupCompletedAt).toEqual(expect.any(Number)));

    const runRecoveryEdge = async (
      id: string,
      mutateBeforeThrow: (caseRuns: Map<string, Record<string, any>>, entry: Record<string, any>) => void,
      throwOnRecoveryPersist = false,
    ) => {
      const entry = {
        runId: id,
        requesterSessionKey: 'parent-edge',
        expectsCompletionMessage: true,
        createdAt: 1,
        endedAt: 2,
        cleanup: 'keep',
        delivery: { status: 'delivered', queueSequence: 1 },
      };
      const caseRuns = new Map([[id, entry]]);
      const caseWakes: string[] = [];
      const caseSchedules: string[] = [];
      let persistCalls = 0;
      const edgeController = createController({
        runs: caseRuns,
        resumedRuns: new Set([id]),
        persist: () => {
          persistCalls += 1;
          if (throwOnRecoveryPersist && persistCalls >= 2) throw new Error('persist failed');
        },
        finalizeSubagentCleanup: async () => {
          mutateBeforeThrow(caseRuns, entry);
          throw new Error('bookkeeping persist failed');
        },
        scheduleResumeSubagentRun: (runId: string) => caseSchedules.push(runId),
        retryDeferredCompletedAnnounces: (runId: string) => caseWakes.push(runId),
      });
      expect(edgeController.startSubagentAnnounceCleanupFlow2(id, entry)).toBe(true);
      await vi.waitFor(() => expect(caseWakes).toEqual([id]));
      return caseSchedules;
    };

    await expect(
      runRecoveryEdge('delete-then-persist-fails', caseRuns => {
        caseRuns.delete('delete-then-persist-fails');
      }),
    ).resolves.toEqual([]);
    await expect(
      runRecoveryEdge('complete-then-persist-fails', (_caseRuns, entry) => {
        entry.cleanupCompletedAt = Date.now();
      }),
    ).resolves.toEqual([]);
    await expect(
      runRecoveryEdge('recovery-persist-fails', () => {}, true),
    ).resolves.toEqual(['recovery-persist-fails']);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('does not retry visible stops based on usage metadata', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-history-patch-'));
  try {
    fs.mkdirSync(path.join(runtimeDir, 'dist'));
    fs.writeFileSync(
      path.join(runtimeDir, 'dist', 'runtime.js'),
      `function isZeroOrMissingUsageSnapshot(usage) {
  return usage == null || hasZeroTokenUsageSnapshot(usage);
}
function isZeroUsageEmptyStopAssistantTurn(message2) {
  return Boolean(message2 && message2.stopReason === "stop" && Array.isArray(message2.content) && (message2.content.length === 0 || hasOnlyAssistantReasoningContent(message2)) && hasZeroTokenUsageSnapshot(message2.usage));
}
function isZeroUsageVisibleStopAssistantTurn(message2) {
  return Boolean(message2 && message2.stopReason === "stop" && Array.isArray(message2.content) && message2.content.some((block3) => block3 && typeof block3 === "object" && isAssistantTextContentType(block3.type) && typeof block3.text === "string" && block3.text.trim()) && isZeroOrMissingUsageSnapshot(message2.usage));
}
function resolveZeroUsageVisibleStopRetryInstruction(params) {
  if (params.timedOut) return null;
  return "The previous attempt recorded a partial assistant sentence with zero or missing model token usage before taking the next action.";
}
const retryInstruction = "The previous attempt recorded a partial assistant sentence with zero or missing model token usage before taking the next action.";
const retryLog = "zero/missing-usage visible stop";`,
      'utf8',
    );

    expect(applyPatch(runtimeDir)).toEqual([path.join('dist', 'runtime.js')]);
    const patched = fs.readFileSync(path.join(runtimeDir, 'dist', 'runtime.js'), 'utf8');

    expect(patched).not.toContain('isZeroOrMissingUsageSnapshot');
    expect(patched).toContain(
      'function isZeroUsageVisibleStopAssistantTurn(message2) {\n  return false;\n}',
    );
    expect(patched).toContain('zero model token usage');
    expect(patched).toContain('zero-usage visible stop');
    expect(patched.match(/function resolveZeroUsageVisibleStopRetryInstruction/g)).toHaveLength(1);
    expect(applyPatch(runtimeDir)).toEqual([]);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
