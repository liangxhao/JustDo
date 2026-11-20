import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const { transform, TARGET } = require('../../../../scripts/patches/v2026.10.7/042-subagent-settle-deduplication.cjs').__testing as {
  transform: (source: string, file?: string) => string;
  TARGET: string;
};
const { functionRange } = require('../../../../scripts/patches/v2026.10.7/prepared-read-patch-shapes.js') as {
  functionRange: (source: string, name: string) => { text: string };
};

const explicitRuntime = process.env.OPENCLAW_PRISTINE_DIR;
const runtime = explicitRuntime ?? ['build/upgrade-audit/v2026.10.7/dependency-snapshot', 'vendor/openclaw-runtime/current']
  .find(dir => fs.existsSync(path.join(dir, TARGET)));
const required = process.env.OPENCLAW_RUNTIME_CONTRACT_REQUIRED === '1';
const parentKey = 'agent:main:main';
const finishedAt = 1_000;

type WakeState = {
  status: string;
  attemptCount: number;
  requesterYieldBatch?: boolean;
  rearmGeneration?: number;
  batchRunIds?: string[];
  nextAttemptAt?: number;
  deferralCount?: number;
};

function completed(runId: string, status = 'delivered', interruptionReason?: 'gateway-restart') {
  return {
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    createdAt: finishedAt - 100,
    expectsCompletionMessage: true,
    execution: { status: 'terminal', endedAt: finishedAt, interruptionReason },
    delivery: { status },
    completion: {
      resultText: `finding:${runId}`,
      terminalReply: { disposition: 'visible', modelRouteChange: `route:${runId}` },
    },
    requesterSettleWake: { status: 'pending', attemptCount: 0 } as WakeState,
  };
}

type Child = ReturnType<typeof completed>;
type Invoke = () => Promise<unknown>;
type ParentHandoff = { triggerMessage: string; settleWakeSourceSessionKeys: string[]; requireVisibleReply?: boolean };
type Settle = (params: {
  requesterSessionKey: string;
  settledEntry: Child;
  isSourceCurrent: () => boolean;
  transitionBatch: (rows: Child[], state: WakeState, publish: (rows: Child[]) => void) => Promise<void>;
  completeBatch: (rows: Child[], generation?: number, delivery?: { delivered: boolean }) => Promise<void>;
}) => Promise<boolean>;

type DescendantFixture = {
  siblingRunning?: boolean;
  confirmDeliveryDuringDeferral?: boolean;
  confirmDeliveryOnFinalRead?: string;
  confirmDeliveryOnReservation?: string;
};

class PreparationConflict extends Error {}

function readNativeSource() {
  if (!runtime) throw new Error('Requester settlement validation needs an OpenClaw runtime');
  const metadata = JSON.parse(fs.readFileSync(path.join(runtime, 'package.json'), 'utf8'));
  expect([metadata.name, metadata.version]).toEqual(['openclaw', '2026.10.7']);
  return fs.readFileSync(path.join(runtime, TARGET), 'utf8');
}

// Execute the two actual native owners. Supply the registry snapshot, clock and
// transport boundaries in memory so these cases need neither Gateway nor a model.
async function settle(source: string, children: Child[], {
  siblingRunning = false, confirmDeliveryDuringDeferral = false, confirmDeliveryOnFinalRead, confirmDeliveryOnReservation,
}: DescendantFixture = {}) {
  const requester = { entry: { sessionId: 'parent-session', lifecycleRevision: 'original' } };
  const owned = () => true;
  const absent = () => undefined;
  let currentRows = children;
  let descendantReads = 0;
  const now = finishedAt + 30 * 60_000 + 1;
  const confirmDelivery = (runId: string) => {
    currentRows = currentRows.map(row => row.runId === runId ? { ...row, delivery: { status: 'delivered' } } : row);
  };
  const readFindings = vi.fn(async (rows: Child[]) => ({
    text: rows.map(entry => entry.completion.resultText).join('\n') || undefined,
    isCurrent: owned,
  }));
  const send = vi.fn(async (_params: ParentHandoff) => ({ delivered: true, path: 'direct' }));
  const dependencies = {
    getRuntimeConfig: () => ({}),
    resolveSubagentRequesterAgentId: () => 'main',
    isCronSessionKey: () => false,
    listSubagentRunsForRequester: () => currentRows,
    isSameSubagentRunOwner: (left: Child, right: Child) => left.runId === right.runId,
    hasSubagentRunEnded: (entry: Child) => entry.execution.status === 'terminal',
    selectConnectedSettledSubagentWave: (rows: Child[]) => rows,
    getSharedGatewayContextResolver: absent,
    readSharedBatchState: (rows: Child[]) => rows[0].requesterSettleWake,
    buildRequesterSettleWakeIdentity: () => ({ batchKey: 'batch', runId: 'settlement-run' }),
    createRequesterSettleBatchClaim: () => ({ claim: owned, release: absent, isGatewayClosed: () => false }),
    createRequesterDescendantReader: () => async () => {
      descendantReads += 1;
      if (descendantReads === 2) {
        const confirmation = confirmDeliveryDuringDeferral ? children[0].runId : confirmDeliveryOnFinalRead;
        if (confirmation) confirmDelivery(confirmation);
      }
      return { unsettled: siblingRunning || confirmDeliveryDuringDeferral, active: Number(siblingRunning) };
    },
    isSystemEventStoreCurrent: owned,
    getFollowupForCohort: absent,
    getLatestLiveSubagentRunByChildSessionKey: absent,
    captureRequesterRunOwner: () => owned,
    isQuietSubagentRestartContinuation: () => false,
    getSubagentDepthFromSessionStore: () => 0,
    hasRequesterCompletionCohort: () => false,
    selectCurrentRequesterCompletionRows: ({ rows }: { rows: Child[] }) => rows,
    resolveCurrentRequesterSettleWakeBatch: ({ currentRuns }: { currentRuns: Child[] }) => currentRuns,
    loadRequesterSessionEntry: () => requester,
    hasUsableSessionEntry: owned,
    resolvePrivateSettlePolicy: (_rows: Child[], yielded: boolean) => ({
      privateRows: [], requireVisibleReply: yielded, parentOnly: false, privateBinding: {}, admissionMarker: {},
    }),
    matchesSubagentRequesterSession: owned,
    readChildCompletionFindings: readFindings,
    normalizeDeliveryContext: absent,
    resolveAnnounceOrigin: absent,
    normalizeMessageChannel: absent,
    REQUESTER_SETTLE_WAKE_ROUTE_NOTICE_MAX_CHARS: 1_024,
    ROUTE_NOTICE_TRUNCATION: '\n[truncated]',
    buildSubagentRestartRecoveryRoster: (rows: Child[]) => rows
      .filter(row => row.execution.interruptionReason === 'gateway-restart')
      .map(row => `recover:${row.runId}`).join('\n'),
    SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION: 'Completion outcomes',
    SUBAGENT_RESTART_RECOVERY_INSTRUCTION: 'Recover interrupted work',
    REQUESTER_SETTLE_WAKE_MAX_ATTEMPTS: 3,
    REQUESTER_SETTLE_WAKE_MAX_DEFERRALS: 10,
    REQUESTER_SETTLE_WAKE_RETRY_DELAYS_MS: [30_000, 120_000],
    retainedYieldIdentity: absent,
    logWarn: absent,
    SubagentAnnouncePreparationConflictError: PreparationConflict,
    deferRequesterSettleWakePreparation: (state: WakeState) => ({ ...state, nextAttemptAt: now + 30_000 }),
    startRequesterSettleWakeAttempt: (state: WakeState) => ({
      ...state, status: 'dispatching', attemptCount: state.attemptCount + 1,
    }),
    createRequesterSettleReceiptAdmission: () => ({ isStoreCurrent: owned, isRequesterCurrent: owned }),
    transferRequesterFinalAttachment: absent,
    subagentRuns: { runWithCompletionBatchAuthority: (_rows: Child[], run: Invoke) => run() },
    withRequesterCronAuthority: (_scope: unknown, run: Invoke) => run(),
    withSubagentProgressDraft: (_rows: Child[], _runId: string, run: Invoke) => run(),
    deliverSubagentAnnouncement: send,
    Date: { now: () => now },
  };
  const names = ['buildRequesterSettleWakeMessage'];
  if (source.includes('function needsRequesterSettleFindings(')) names.unshift('needsRequesterSettleFindings');
  const owners = names.map(name => functionRange(source, name).text);
  const wake = 'maybeWakeRequesterAfterAllChildrenSettled';
  owners.push(`async ${functionRange(source, wake).text}`);
  const invoke = new Function(...Object.keys(dependencies), `${owners.join('\n')}\nreturn ${wake};`)(
    ...Object.values(dependencies),
  ) as Settle;
  const complete = vi.fn(async (_rows: Child[], _generation?: number, _delivery?: { delivered: boolean }) => {});
  const transition = vi.fn(async (rows: Child[], state: WakeState, publish: (rows: Child[]) => void) => {
    currentRows = rows.map(row => ({ ...row, requesterSettleWake: state }));
    publish(currentRows);
    if (state.status === 'dispatching' && confirmDeliveryOnReservation) confirmDelivery(confirmDeliveryOnReservation);
  });
  let preparationConflict: PreparationConflict | undefined;
  const delivered = await invoke({
    requesterSessionKey: parentKey, settledEntry: children[0], isSourceCurrent: owned,
    completeBatch: complete, transitionBatch: transition,
  }).catch((error: unknown) => {
    if (!(error instanceof PreparationConflict)) throw error;
    preparationConflict = error;
    return false;
  });
  return { delivered, complete, transition, readFindings, send, preparationConflict, handoff: send.mock.calls[0]?.[0] };
}

describe.skipIf(!runtime && !required)('native requester settlement', () => {
  it.each([
    { title: 'one delivered child with a running sibling', ids: ['short'], siblingRunning: true },
    { title: 'a fully delivered non-yielded wave', ids: ['first', 'second'], siblingRunning: false },
  ])('retires $title without another requester turn', async ({ ids, siblingRunning }) => {
    const rows = ids.map(id => completed(id));
    const observed = await settle(transform(readNativeSource()), rows, { siblingRunning });

    expect(observed.delivered).toBe(false);
    expect(observed.complete).toHaveBeenCalledExactlyOnceWith(rows, undefined, undefined, expect.any(Function));
    expect(observed.readFindings).not.toHaveBeenCalled();
    expect(observed.send).not.toHaveBeenCalled();
  });

  it('waits for an active descendant before delivering only the owed result and model notice', async () => {
    const rows = [completed('consumed'), completed('owed', 'pending')];
    const batchRunIds = rows.map(row => row.runId);
    for (const row of rows) row.requesterSettleWake.batchRunIds = batchRunIds;
    const source = transform(readNativeSource());

    const waiting = await settle(source, rows, { siblingRunning: true });
    const drained = await settle(source, rows);

    expect(waiting.complete).not.toHaveBeenCalled();
    expect(waiting.send).not.toHaveBeenCalled();
    expect(waiting.transition.mock.calls[0]?.[1]).toMatchObject({
      status: 'pending', batchRunIds, nextAttemptAt: expect.any(Number),
    });
    expect(drained.send).toHaveBeenCalledOnce();
    expect(drained.handoff?.settleWakeSourceSessionKeys).toEqual(rows.map(row => row.childSessionKey));
    expect(drained.handoff?.triggerMessage).toContain('Already delivered child results (not repeated): consumed.');
    expect(drained.handoff?.triggerMessage).toContain('finding:owed');
    expect(drained.handoff?.triggerMessage).toContain('route:owed');
    expect(drained.handoff?.triggerMessage).not.toMatch(/(?:finding|route):consumed/u);
  });

  it('retires a frozen result delivered while the descendant deferral reaches its limit', async () => {
    const child = completed('confirmed-during-deferral', 'pending');
    child.requesterSettleWake.batchRunIds = [child.runId];
    child.requesterSettleWake.deferralCount = 10;

    const observed = await settle(transform(readNativeSource()), [child], { confirmDeliveryDuringDeferral: true });

    expect(observed.delivered).toBe(false);
    expect(observed.complete).toHaveBeenCalledExactlyOnceWith(
      [expect.objectContaining({ delivery: { status: 'delivered' } })], undefined, undefined, expect.any(Function),
    );
    expect(observed.send).not.toHaveBeenCalled();
  });

  it('retries preparation when a mixed wake gains an independent delivery during the final descendant read', async () => {
    const [confirmed, owed] = [completed('confirmed-on-read', 'pending'), completed('still-owed', 'pending')];
    const source = transform(readNativeSource());

    const observed = await settle(source, [confirmed, owed], { confirmDeliveryOnFinalRead: confirmed.runId });

    expect(observed.preparationConflict).toBeInstanceOf(PreparationConflict);
    expect(observed.transition).not.toHaveBeenCalled();
    expect(observed.send).not.toHaveBeenCalled();
  });

  it('restores the unspent attempt when independent delivery changes the findings during reservation', async () => {
    const [confirmed, owed] = [completed('confirmed-on-reserve', 'pending'), completed('still-owed', 'pending')];
    const source = transform(readNativeSource());

    const observed = await settle(source, [confirmed, owed], { confirmDeliveryOnReservation: confirmed.runId });

    expect(observed.transition.mock.calls.map(([, state]) => state)).toEqual([
      expect.objectContaining({ status: 'dispatching', attemptCount: 1 }),
      expect.objectContaining({ status: 'pending', attemptCount: 0, nextAttemptAt: expect.any(Number) }),
    ]);
    expect(observed.send).not.toHaveBeenCalled();
  });

  it('continues an explicit yield without resending already delivered material', async () => {
    const child = completed('yielded');
    child.requesterSettleWake = {
      status: 'pending', attemptCount: 0, requesterYieldBatch: true, rearmGeneration: 1, batchRunIds: [child.runId],
    };

    const observed = await settle(transform(readNativeSource()), [child]);

    expect(observed.delivered).toBe(true);
    expect(observed.send).toHaveBeenCalledOnce();
    expect(observed.handoff?.requireVisibleReply).toBe(true);
    expect(observed.handoff?.triggerMessage).not.toMatch(/(?:finding|route):yielded/u);
  });

  it('retains an interrupted child’s recovery roster, findings and model notice despite earlier delivery', async () => {
    const child = completed('interrupted', 'delivered', 'gateway-restart');

    const observed = await settle(transform(readNativeSource()), [child]);

    expect(observed.send).toHaveBeenCalledOnce();
    expect(observed.handoff?.triggerMessage).toContain('recover:interrupted');
    expect(observed.handoff?.triggerMessage).toContain('finding:interrupted');
    expect(observed.handoff?.triggerMessage).toContain('route:interrupted');
    expect(observed.handoff?.triggerMessage).not.toContain('Already delivered child results');
  });

  it('reproduces the stuck and repeated outcomes before applying the patch', async ({ skip }) => {
    const source = readNativeSource();
    if (transform(source) === source) return skip();

    const busy = await settle(source, [completed('short')], { siblingRunning: true });
    const deliveredWave = await settle(source, [completed('first'), completed('second')]);

    expect(busy.complete).not.toHaveBeenCalled();
    expect(deliveredWave.send).toHaveBeenCalledOnce();
    expect(deliveredWave.handoff?.triggerMessage).toContain('finding:first');
    expect(deliveredWave.handoff?.triggerMessage).toContain('finding:second');
  });

  it('recognizes a complete transform and rejects a partial result filter', () => {
    const patched = transform(readNativeSource());
    const partial = patched.replace('completionRows.filter(needsRequesterSettleFindings)', 'completionRows');

    expect(transform(patched)).toBe(patched);
    expect(partial).not.toBe(patched);
    expect(() => transform(partial)).toThrow('requester settlement still contains pristine decisions');
  });

  it('verifies generated bundle bindings and rejects mismatched references', () => {
    const patched = transform(readNativeSource());
    const { text: predicate } = functionRange(patched, 'needsRequesterSettleFindings');
    const { text: wake } = functionRange(patched, 'maybeWakeRequesterAfterAllChildrenSettled');
    const bundle = patched.replace(predicate, predicate.replace(/\bentry\b/gu, 'entry2'))
      .replace(wake, wake.replace(/\bstate\b/gu, 'state27'));
    const wrongBinding = bundle.replace('entry2.delivery?.status', 'entry.delivery?.status');
    const wrongState = bundle.replace('completeBatch(settledBatch, state27);', 'completeBatch(settledBatch, state);');

    expect(transform(bundle, 'gateway-bundle.mjs')).toBe(bundle);
    expect(() => transform(wrongBinding, 'gateway-bundle.mjs')).toThrow('settlement findings predicate changed');
    expect(() => transform(wrongState, 'gateway-bundle.mjs')).toThrow('anchor count is 0');
  });
});
