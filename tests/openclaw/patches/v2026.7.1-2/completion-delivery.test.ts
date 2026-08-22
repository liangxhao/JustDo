import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';
const branchPatch =
  require('../../../../scripts/patches/v2026.7.1-2/015-completion-branch-promotion.cjs') as {
    shouldPromoteCommittedCompletion: (
      strictCompletion: boolean,
      delivery: { delivered?: boolean },
    ) => boolean;
    transformSessionManager: (content: string, filePath: string) => string;
  };
const queuePatch = require('../../../../scripts/patches/v2026.7.1-2/016-completion-delivery-queue.cjs') as {
  LOCK_HELPER: string;
  QUEUE_HELPERS: string;
  transformOrigin: (content: string, filePath: string) => string;
  transformRegistry: (content: string, filePath: string) => string;
};

describe('OpenClaw v2026.7.1-2 completion delivery capabilities', () => {
  test('keeps native sessions_yield resumable for active descendants and pending delivery', async () => {
    // This is the target tarball's complete execute policy: unlike old 006 it
    // does not gate on a child endedAt/delivery status, so both wake sources
    // reach the same persisted yield callback.
    const nativeToolSource = `function createSessionsYieldTool(opts) {
\treturn {
\t\texecute: async (_toolCallId, args) => {
\t\t\tconst message = readStringParam(args, "message") || "Turn yielded.";
\t\t\tif (!opts?.sessionId) return jsonResult({ status: "error", error: "No session context" });
\t\t\tif (!opts?.onYield) return jsonResult({ status: "error", error: "Yield not supported in this context" });
\t\t\tawait opts.onYield(message);
\t\t\treturn jsonResult({ status: "yielded", message });
\t\t}
\t};
}`;
    const createSessionsYieldTool = new Function(
      'readStringParam',
      'jsonResult',
      `${nativeToolSource}; return createSessionsYieldTool;`,
    )(
      (args: Record<string, unknown>, key: string) => args[key],
      (value: unknown) => value,
    ) as (opts: Record<string, unknown>) => {
      execute: (
        toolCallId: string,
        args: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
    };

    for (const wakeSource of ['active-descendant', 'pending-completion-delivery']) {
      const run: Record<string, unknown> =
        wakeSource === 'active-descendant'
          ? { endedAt: undefined, delivery: { status: 'pending' } }
          : { endedAt: 10, delivery: { status: 'in_progress' } };
      const tool = createSessionsYieldTool({
        sessionId: 'requester-session-id',
        onYield: async () => {
          // Mirrors markSubagentRunPausedAfterYield: the target persists an
          // ended-but-paused generation and clears stale terminal delivery.
          run.endedAt = 20;
          run.pauseReason = 'sessions_yield';
          run.delivery = undefined;
        },
      });
      await expect(tool.execute('yield-call', { message: wakeSource })).resolves.toEqual({
        status: 'yielded',
        message: wakeSource,
      });
      expect(run).toMatchObject({ endedAt: 20, pauseReason: 'sessions_yield' });

      // The target's reactivateCompletedSubagentSession admits any persisted
      // ended generation (including sessions_yield) and swaps in the terminal
      // completion agent call's run id, reopening delivery as a new turn.
      const terminalDelivery = { runId: `resume-${wakeSource}` };
      const reactivated = typeof run.endedAt === 'number' && Boolean(terminalDelivery.runId.trim());
      expect(reactivated).toBe(true);
    }
  });

  test('requires a visible result when managed join recovery falls back to subagent completion', () => {
    const acceptsIntentionalSilentCompletion = (
      hasIntentionalSilentPayload: boolean,
      isSubagentCompletion: boolean,
    ) => hasIntentionalSilentPayload && !isSubagentCompletion;

    expect(acceptsIntentionalSilentCompletion(true, false)).toBe(true);
    expect(acceptsIntentionalSilentCompletion(true, true)).toBe(false);
    const patchFiles = fs.readdirSync(path.join(process.cwd(), 'scripts/patches/v2026.7.1-2'));
    expect(patchFiles.some(name => name.endsWith('subagent-completion-response-policy.cjs'))).toBe(
      false,
    );
  });

  test('keeps managed sessions_yield internal and leaves native CLI gap-fill unchanged', async () => {
    const evidenceSource = `function hasMessagingToolDeliveryEvidence() { return false; }
function hasAcceptedSessionSpawn() { return false; }
function hasPositiveNumber() { return false; }
function hasCommittedOutboundDeliveryEvidence(result) {
\treturn hasMessagingToolDeliveryEvidence(result) || Array.isArray(result.acceptedSessionSpawns) && hasAcceptedSessionSpawn(result.acceptedSessionSpawns) || hasPositiveNumber(result.successfulCronAdds);
}`;
    const hasCommittedOutboundDeliveryEvidence = new Function(
      `${evidenceSource}; return hasCommittedOutboundDeliveryEvidence;`,
    )() as (result: unknown) => boolean;
    const managedYieldToolResult = { meta: { toolSummary: { tools: ['sessions_yield'] } } };
    expect(hasCommittedOutboundDeliveryEvidence(managedYieldToolResult)).toBe(false);

    const gapFillSource = `function resolveCliTranscriptReplyText(result) { return result.replyText; }
async function persistTextTurnTranscript(params) { return params; }
async function persistCliTurnTranscript(params) {
\tconst replyText = resolveCliTranscriptReplyText(params.result);
\tconst provider = "cli";
\tconst model = "default";
\tconst gapFill = params.embeddedAssistantGapFill ?? false;
\tconst skipUserTurn = gapFill || params.skipUserTurn === true;
\treturn await persistTextTurnTranscript({
\t\tbody: skipUserTurn ? "" : params.body,
\t\ttranscriptBody: skipUserTurn ? void 0 : params.transcriptBody,
\t\t...!skipUserTurn && params.userMessage ? { userMessage: params.userMessage } : {},
\t\tfinalText: replyText,
\t\tsessionId: params.sessionId,
\t\tprovider,
\t\tmodel
\t});
    }`;
    const persistCliTurnTranscript = new Function(
      `${gapFillSource}; return persistCliTurnTranscript;`,
    )() as (params: Record<string, unknown>) => Promise<{ finalText: string }>;
    await expect(
      persistCliTurnTranscript({
        embeddedAssistantGapFill: true,
        result: { replyText: 'native yielded reply', meta: { yielded: true } },
      }),
    ).resolves.toMatchObject({ finalText: 'native yielded reply' });
    const patchFiles = fs.readdirSync(path.join(process.cwd(), 'scripts/patches/v2026.7.1-2'));
    expect(patchFiles.some(name => name.endsWith('yielded-transcript-handling.cjs'))).toBe(false);
  });

  test('promotes the side branch only when explicitly committed', () => {
    const source = `class SessionManager {
\tconstructor() { this.leafId = "active"; this.promptReleasedSideBranchParentId = "side"; this.persisted = []; }
\tbranch(id) { this.leafId = id; }
\tcreateLeafControl(id) { return { id: "leaf-control", parentId: id }; }
\tpersistRecord(entry) { this.persisted.push(entry); }
\trememberLeafControl(entry) { this.remembered = entry; }
\tgetLeafId() {
\t\treturn this.leafId;
\t}
\tgetLeafEntry() { return null; }
}`;
    const transformed = branchPatch.transformSessionManager(source, 'session-manager.js');
    const SessionManager = new Function(`${transformed}; return SessionManager;`)() as new () => {
      leafId: string;
      promptReleasedSideBranchParentId?: string;
      persisted: unknown[];
      promotePromptReleasedSideBranch: () => boolean;
    };
    const manager = new SessionManager();
    expect(manager.leafId).toBe('active');
    expect(manager.promotePromptReleasedSideBranch()).toBe(true);
    expect(manager.leafId).toBe('side');
    expect(manager.persisted).toHaveLength(1);
    expect(manager.promotePromptReleasedSideBranch()).toBe(false);
    expect(manager.persisted).toHaveLength(1);
  });

  test('opens the promotion fence only for a committed outer completion delivery', () => {
    expect(branchPatch.shouldPromoteCommittedCompletion(true, { delivered: false })).toBe(false);
    expect(branchPatch.shouldPromoteCommittedCompletion(false, { delivered: true })).toBe(false);
    expect(branchPatch.shouldPromoteCommittedCompletion(true, { delivered: true })).toBe(true);
  });

  test('serializes one requester, permits parallel requesters and retains a failed FIFO head', async () => {
    const withLock = new Function(
      `${queuePatch.LOCK_HELPER}; return withSubagentCompletionDeliveryLock;`,
    )() as <T>(key: string, task: () => Promise<T>) => Promise<T>;
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const first = withLock('requester-a', async () => {
      events.push('a1-start');
      await firstGate;
      events.push('a1-end');
    });
    const second = withLock('requester-a', async () => {
      events.push('a2');
    });
    const parallel = withLock('requester-b', async () => {
      events.push('b1');
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toContain('a1-start');
    expect(events).toContain('b1');
    expect(events).not.toContain('a2');
    releaseFirst();
    await Promise.all([first, second, parallel]);
    expect(events.indexOf('a2')).toBeGreaterThan(events.indexOf('a1-end'));

    const runs = new Map([
      [
        'first',
        {
          runId: 'first',
          requesterSessionKey: 'same',
          expectsCompletionMessage: true,
          endedAt: 1,
          delivery: { queueSequence: 1, status: 'failed' },
        },
      ],
      [
        'second',
        {
          runId: 'second',
          requesterSessionKey: 'same',
          expectsCompletionMessage: true,
          endedAt: 2,
          delivery: { queueSequence: 2, status: 'pending' },
        },
      ],
      [
        'other',
        {
          runId: 'other',
          requesterSessionKey: 'other',
          expectsCompletionMessage: true,
          endedAt: 1,
          delivery: { queueSequence: 1, status: 'pending' },
        },
      ],
    ]);
    const policy = new Function(
      'params',
      'ensureDeliveryState',
      'ANNOUNCE_COMPLETION_HARD_EXPIRY_MS',
      `${queuePatch.QUEUE_HELPERS}; return { hasEarlierPendingCompletionDelivery, isCompletionDeliveryHardExpired };`,
    )({ runs }, (entry: { delivery: Record<string, unknown> }) => entry.delivery, 30 * 60_000) as {
      hasEarlierPendingCompletionDelivery: (runId: string, entry: unknown) => boolean;
      isCompletionDeliveryHardExpired: (
        entry: { expectsCompletionMessage?: boolean; endedAt?: number; pauseReason?: string },
        now?: number,
      ) => boolean;
    };
    expect(policy.hasEarlierPendingCompletionDelivery('second', runs.get('second'))).toBe(true);
    expect(policy.hasEarlierPendingCompletionDelivery('other', runs.get('other'))).toBe(false);
    runs.get('first')!.delivery.status = 'delivered';
    expect(policy.hasEarlierPendingCompletionDelivery('second', runs.get('second'))).toBe(false);

    const now = 2_000_000;
    expect(
      policy.isCompletionDeliveryHardExpired(
        { expectsCompletionMessage: true, endedAt: now - 30 * 60_000 - 1 },
        now,
      ),
    ).toBe(true);
    expect(
      policy.isCompletionDeliveryHardExpired(
        { expectsCompletionMessage: true, endedAt: now - 30 * 60_000 },
        now,
      ),
    ).toBe(false);
    expect(
      policy.isCompletionDeliveryHardExpired(
        { expectsCompletionMessage: false, endedAt: now - 31 * 60_000 },
        now,
      ),
    ).toBe(false);
    expect(
      policy.isCompletionDeliveryHardExpired(
        {
          expectsCompletionMessage: true,
          endedAt: now - 31 * 60_000,
          pauseReason: 'sessions_yield',
        },
        now,
      ),
    ).toBe(false);
  });

  test('rejects partially patched completion registries instead of upgrading them in place', () => {
    expect(() =>
      queuePatch.transformRegistry(
        'function partial() { hasEarlierPendingCompletionDelivery(runId, entry); delivery.queueSequence = next; }',
        'subagent-registry.js',
      ),
    ).toThrow('partial completion delivery queue patch detected');
  });

  test('keeps restart hard-expiry checks independent of lifecycle-controller scope', () => {
    const upgraded = queuePatch.transformRegistry(
      [
        'hasEarlierPendingCompletionDelivery(runId, entry)',
        'delivery.queueSequence = next',
        'isCompletionDeliveryHardExpired',
        'completion-hard-expired',
        '\tif (isCompletionDeliveryHardExpired(entry)) {',
      ].join('\n'),
      'subagent-registry.js',
    );

    expect(upgraded).not.toContain('\tif (isCompletionDeliveryHardExpired(entry))');
    expect(upgraded).toContain('Date.now() - entry.endedAt > ANNOUNCE_COMPLETION_HARD_EXPIRY_MS');
  });

  test('waits for the Gateway request context before a recovered completion dispatch', () => {
    const runtimeSource = `import { i as dispatchGatewayMethodInProcess } from "./server-plugins-XoQmHCe9.js";
async function runAnnounceAgentCall(params) {
  return await subagentAnnounceDeliveryDeps.dispatchGatewayMethodInProcess("agent", params.agentParams);
}
async function previouslyPatchedDelivery() {
  await withSubagentCompletionDeliveryLock(key, commit);
  return "completion direct announce terminal confirmation";
}`;
    const patched = queuePatch.transformOrigin(runtimeSource, 'subagent-announce-origin.js');

    expect(patched).toContain(
      'i as dispatchGatewayMethodInProcess, s as hasInProcessGatewayContext',
    );
    expect(patched).toContain('while (!hasInProcessGatewayContext())');
    expect(patched.indexOf('waitForSubagentAnnounceGatewayContext(params.timeoutMs)')).toBeLessThan(
      patched.indexOf('subagentAnnounceDeliveryDeps.dispatchGatewayMethodInProcess("agent"'),
    );
  });
});
