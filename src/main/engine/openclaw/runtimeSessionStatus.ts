import { GoalExecutionPhase } from '../../../shared/cowork/sessionGoal';
import type { CoworkStore } from '../../data/coworkStore';
import { GoalContinuationCoordinator } from '../../openclaw/goals/goalContinuationCoordinator';
import { buildManagedSessionKey, isTeamDiscussionHoldingSessionKey } from '../../openclaw/sessions/openclawSessionKeys';
import { invalidateSessionListRequests } from '../gateway/sessionListClient';
import type { GatewayClientLike, GatewayResponseContext } from '../gateway/types';
import type { CoworkRuntimeStatusOptions } from '../types';
import {
  RUNTIME_SESSION_SNAPSHOT_TTL_MS,
  RUNTIME_STATUS_WARNING_INTERVAL_MS,
  RuntimeSessionSnapshot,
  SessionRuntimeStatus,
  SUBAGENT_DETAIL_CACHE_TTL_MS,
  SUBAGENT_STATUS_CACHE_TTL_MS,
} from './runtimeAdapterSupport';
import {
  type GatewaySubagent,
  listGatewaySubagentsWithMetadata,
  mergeGatewaySubagentSnapshots,
  SUBAGENT_STATUSES,
} from './subagentGateway';
import { OPENCLAW_COMPACT_SESSION_ROW_MODE } from './wire/v2026_10_6';
export interface RuntimeSessionStatusContext {
  readonly invalidateSubagentStatus: (sessionId: string) => void;
  readonly subagentStatusCache: Map<string, { expiresAt: number; subagents: GatewaySubagent[] }>;
  readonly subagentStatusRefreshes: Map<string, Promise<GatewaySubagent[]>>;
  readonly refreshSubagentStatuses: (sessionId: string) => Promise<GatewaySubagent[]>;
  readonly ensureGatewayClientReady: () => Promise<void>;
  readonly gatewayClient: GatewayClientLike | null;
  readonly gatewayClientGeneration: number;
  readonly captureGatewayResponseContext: () => GatewayResponseContext | null;
  readonly targetedSessionStatusChecks: Map<string, Set<symbol>>;
  readonly unknownSessionRuns: ReadonlyMap<string, unknown>;
  readonly subagentStatusGenerations: Map<string, number>;
  readonly subagentDetailCache: Map<string, { expiresAt: number; subagents: GatewaySubagent[] }>;
  readonly getSessionKeysForSession: (sessionId: string) => string[];
  readonly store: CoworkStore;
  readonly invalidateSubagentStatusSnapshot: (sessionId: string) => void;
  readonly getSessionRuntimeStatuses: (
    sessionIds: string[],
    options?: { includeSubagents?: boolean; forceRefresh?: boolean; fullScan?: boolean },
  ) => Promise<Record<string, SessionRuntimeStatus>>;
  readonly disconnectedSessionIds: Set<string>;
  readonly disconnectedRecoveryPromises: Map<string, Promise<void>>;
  readonly reconcileDisconnectedTurn: (sessionId: string) => Promise<void>;
  readonly goalContinuationCoordinator: GoalContinuationCoordinator;
  readonly isSessionActive: (sessionId: string) => boolean;
  readonly compactionInFlightSessionIds: Set<string>;
  readonly rootRunIdBySession: Map<string, string>;
  readonly getRuntimeSessionSnapshot: (
    forceRefresh?: boolean,
    fullScan?: boolean,
  ) => Promise<RuntimeSessionSnapshot>;
  readonly runtimeRowString: (value: unknown) => string;
  readonly isRuntimeSessionRowMainActive: (row: Record<string, unknown>) => boolean;
  readonly isRuntimeSessionRowActive: (row: Record<string, unknown>) => boolean;
  runtimeSessionSnapshot: (RuntimeSessionSnapshot & { expiresAt: number }) | null;
  runtimeSessionSnapshotGeneration: number;
  runtimeSessionSnapshotPromise: Promise<RuntimeSessionSnapshot> | null;
  runtimeSessionSnapshotQueuedRefresh: {
    forceRefresh: boolean;
    fullScan: boolean;
    promise: Promise<RuntimeSessionSnapshot>;
  } | null;
  lastRuntimeStatusWarningAt: number;
}

export async function getSubagentStatuses(
  this: RuntimeSessionStatusContext,
  sessionId?: string,
  forceRefresh = false,
): Promise<{
  subagents: GatewaySubagent[];
}> {
  if (!sessionId) return { subagents: [] };
  if (forceRefresh) {
    invalidateSessionListRequests(this.gatewayClient);
    this.invalidateSubagentStatus(sessionId);
  }
  const cached = this.subagentStatusCache.get(sessionId);
  if (cached && cached.expiresAt > Date.now()) {
    return { subagents: cached.subagents };
  }

  let refresh = this.subagentStatusRefreshes.get(sessionId);
  if (!refresh) {
    refresh = this.refreshSubagentStatuses(sessionId);
    this.subagentStatusRefreshes.set(sessionId, refresh);
    const clearRefresh = () => {
      if (this.subagentStatusRefreshes.get(sessionId) === refresh) {
        this.subagentStatusRefreshes.delete(sessionId);
      }
    };
    void refresh.then(clearRefresh, clearRefresh);
  }
  const subagents = await refresh;
  return {
    subagents,
  };
}

export async function refreshSubagentStatuses(
  this: RuntimeSessionStatusContext,
  sessionId: string,
): Promise<GatewaySubagent[]> {
  await this.ensureGatewayClientReady();
  if (!this.gatewayClient) return [];

  const now = Date.now();
  const refreshGeneration = this.subagentStatusGenerations.get(sessionId) ?? 0;
  const retained = this.subagentDetailCache.get(sessionId);
  const listing = await listGatewaySubagentsWithMetadata({
    client: this.gatewayClient,
    parentKeys: this.getSessionKeysForSession(sessionId),
  });
  // A complete native session read replaces membership immediately. Keep prior
  // rows only when the Gateway reports an incomplete read; never invent closure.
  const subagents =
    listing.sessionListComplete || !retained
      ? listing.subagents
      : mergeGatewaySubagentSnapshots(retained.subagents, listing.subagents);
  if (
    (this.subagentStatusGenerations.get(sessionId) ?? 0) !== refreshGeneration ||
    !this.store.getSession(sessionId)
  ) {
    return subagents;
  }
  this.subagentDetailCache.set(sessionId, {
    expiresAt: now + SUBAGENT_DETAIL_CACHE_TTL_MS,
    subagents,
  });
  this.subagentStatusCache.set(sessionId, {
    expiresAt: now + SUBAGENT_STATUS_CACHE_TTL_MS,
    subagents,
  });
  return subagents;
}

export function invalidateSubagentStatusSnapshot(
  this: RuntimeSessionStatusContext,
  sessionId: string,
): void {
  this.subagentStatusCache.delete(sessionId);
  // Let the next caller start an authoritative read even if an older snapshot
  // is still in flight. The generation guard prevents that stale request from
  // repopulating either cache when it eventually resolves.
  this.subagentStatusRefreshes.delete(sessionId);
  this.subagentStatusGenerations.set(
    sessionId,
    (this.subagentStatusGenerations.get(sessionId) ?? 0) + 1,
  );
}

export function invalidateSubagentStatus(
  this: RuntimeSessionStatusContext,
  sessionId: string,
): void {
  this.invalidateSubagentStatusSnapshot(sessionId);
  this.subagentDetailCache.delete(sessionId);
}

export async function getSessionRuntimeStatus(
  this: RuntimeSessionStatusContext,
  sessionId: string,
  options?: CoworkRuntimeStatusOptions,
): Promise<{
  known: boolean;
  mainRunning: boolean;
  subagentRunning: boolean;
  running: boolean;
  rootRunId?: string;
}> {
  if (!sessionId) {
    return { known: true, mainRunning: false, subagentRunning: false, running: false };
  }
  if (options?.targeted) return getTargetedSessionRuntimeStatus.call(this, sessionId, options);
  const statuses = await this.getSessionRuntimeStatuses([sessionId], options);
  return (
    statuses[sessionId] ?? {
      known: false,
      mainRunning: false,
      subagentRunning: false,
      running: false,
    }
  );
}

const TargetedStatusReason = {
  SourceUnavailable: 'source-unavailable',
  SourceChanged: 'source-changed',
  ConnectionUnavailable: 'connection-unavailable',
  ConnectionChanged: 'connection-changed',
  UnknownCustody: 'unconfirmed-custody',
  NativeReadFailed: 'native-read-failed',
  NativeRowMissing: 'native-row-missing',
  NativeRowInvalid: 'native-row-invalid',
  NativeSessionMismatch: 'native-session-mismatch',
  NativeRevisionMismatch: 'native-revision-mismatch',
  NativeAgentMismatch: 'native-agent-mismatch',
  EventRetired: 'event-retired',
  EventReobserve: 'event-reobserve',
  RetryIdentityMissing: 'retry-identity-missing',
} as const;

/** A native current-row observation is independent of unrelated roster invalidations. */
async function getTargetedSessionRuntimeStatus(
  this: RuntimeSessionStatusContext,
  sessionId: string,
  options: CoworkRuntimeStatusOptions,
): Promise<SessionRuntimeStatus> {
  const source = this.store.getSession(sessionId);
  const key = source && !source.external
    ? source.nativeSessionKey || buildManagedSessionKey(sessionId, source.agentId) : undefined;
  const expectedSessionId = options.expectedSessionId ?? source?.historyBinding?.nativeSessionId;
  const expectedLifecycleRevision = options.expectedLifecycleRevision;
  let attempt = 0;
  let observedIdentity: { sessionId: string; lifecycleRevision: string | null | undefined } | undefined;
  const diagnose = (reason: typeof TargetedStatusReason[keyof typeof TargetedStatusReason]) => {
    console.warn('[OpenClawRuntime] Targeted session status observation', {
      reason, sessionId, key, expectedSessionId: observedIdentity?.sessionId ?? expectedSessionId ?? null, attempt,
    });
  };
  const unknown = (reason: typeof TargetedStatusReason[keyof typeof TargetedStatusReason]): SessionRuntimeStatus => {
    diagnose(reason);
    return { known: false, mainRunning: false, subagentRunning: false, running: false };
  };
  if (!source || source.external || !key) return unknown(TargetedStatusReason.SourceUnavailable);
  const identityOf = (row: typeof source) => JSON.stringify([row.agentId, row.cwd, row.permissionMode,
    row.nativeSessionKey, row.historyBinding, row.status, row.nativeParentSessionId,
    row.forkSource, row.handoffSource, row.branchCreationPending]);
  const identity = identityOf(source);
  const blocked = () => this.disconnectedSessionIds.has(sessionId) ||
    this.disconnectedRecoveryPromises.has(sessionId) || this.unknownSessionRuns.has(sessionId);
  const local = () => {
    const phase = this.goalContinuationCoordinator.getSnapshot(sessionId)?.phase;
    return this.isSessionActive(sessionId) || this.compactionInFlightSessionIds.has(sessionId) ||
      phase === GoalExecutionPhase.Continuing || phase === GoalExecutionPhase.Retrying;
  };
  if (blocked()) return unknown(TargetedStatusReason.UnknownCustody);
  if (local()) return { known: true, mainRunning: true, subagentRunning: false, running: true };
  try { await this.ensureGatewayClientReady(); } catch { return unknown(TargetedStatusReason.ConnectionUnavailable); }
  const client = this.gatewayClient;
  if (!client) return unknown(TargetedStatusReason.ConnectionUnavailable);
  const generation = this.gatewayClientGeneration;
  const sourceCurrent = () => {
    const row = this.store.getSession(sessionId);
    return !!row && !row.external && identityOf(row) === identity;
  };
  const connectionCurrent = () => this.gatewayClient === client && this.gatewayClientGeneration === generation;
  for (attempt = 1; attempt <= 2; attempt += 1) {
    const checks = this.targetedSessionStatusChecks.get(key) ?? new Set<symbol>();
    const token = Symbol();
    checks.add(token);
    this.targetedSessionStatusChecks.set(key, checks);
    const eventCurrent = () => this.targetedSessionStatusChecks.get(key) === checks && checks.has(token);
    try {
      if (!sourceCurrent()) return unknown(TargetedStatusReason.SourceChanged);
      if (!connectionCurrent()) return unknown(TargetedStatusReason.ConnectionChanged);
      if (blocked()) return unknown(TargetedStatusReason.UnknownCustody);
      if (local()) return { known: true, mainRunning: true, subagentRunning: false, running: true };
      const described = await client.request<{ session?: Record<string, unknown> | null }>(
        'sessions.describe', { key, agentId: source.agentId },
      );
      if (!sourceCurrent()) return unknown(TargetedStatusReason.SourceChanged);
      if (!connectionCurrent()) return unknown(TargetedStatusReason.ConnectionChanged);
      if (blocked()) return unknown(TargetedStatusReason.UnknownCustody);
      if (local()) return { known: true, mainRunning: true, subagentRunning: false, running: true };
      const row = described?.session;
      if (row === null) {
        if (!eventCurrent()) return unknown(TargetedStatusReason.RetryIdentityMissing);
        const fresh = !expectedSessionId && !observedIdentity && !source.nativeSessionKey && !source.historyBinding &&
          source.status === 'idle' && !source.forkSource && !source.handoffSource &&
          !source.nativeParentSessionId && !source.branchCreationPending &&
          this.store.getSessionRuns(sessionId).length === 0 &&
          /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(sessionId);
        return fresh ? { known: true, mainRunning: false, subagentRunning: false, running: false }
          : unknown(TargetedStatusReason.NativeRowMissing);
      }
      if (!row || row.key !== key || typeof row.sessionId !== 'string' || !row.sessionId ||
        typeof row.hasActiveRun !== 'boolean' ||
        (row.hasActiveSubagentRun !== undefined && typeof row.hasActiveSubagentRun !== 'boolean'))
        return unknown(TargetedStatusReason.NativeRowInvalid);
      if ((expectedSessionId !== undefined && row.sessionId !== expectedSessionId) ||
        (observedIdentity && row.sessionId !== observedIdentity.sessionId))
        return unknown(TargetedStatusReason.NativeSessionMismatch);
      if ((expectedLifecycleRevision !== undefined && row.lifecycleRevision !== expectedLifecycleRevision) ||
        (observedIdentity && row.lifecycleRevision !== observedIdentity.lifecycleRevision))
        return unknown(TargetedStatusReason.NativeRevisionMismatch);
      if (row.agentId !== undefined && row.agentId !== source.agentId)
        return unknown(TargetedStatusReason.NativeAgentMismatch);
      if (!eventCurrent()) {
        if (attempt === 2) return unknown(TargetedStatusReason.EventRetired);
        if (!(row.lifecycleRevision === undefined || row.lifecycleRevision === null ||
          (typeof row.lifecycleRevision === 'string' && row.lifecycleRevision.length > 0)))
          return unknown(TargetedStatusReason.RetryIdentityMissing);
        // sessions.create responds before its asynchronous change publication.
        // Discard the retired response and observe once more, within the same
        // product, transport and native incarnation. No write is replayed.
        observedIdentity = { sessionId: row.sessionId, lifecycleRevision: row.lifecycleRevision as string | null | undefined };
        diagnose(TargetedStatusReason.EventReobserve);
        continue;
      }
      // Native omits hasActiveSubagentRun when its complete descendant projection is inactive.
      const mainRunning = row.hasActiveRun;
      const subagentRunning = options.includeSubagents === true && row.hasActiveSubagentRun === true;
      return { known: true, mainRunning, subagentRunning, running: mainRunning || subagentRunning };
    } catch {
      return unknown(TargetedStatusReason.NativeReadFailed);
    } finally {
      checks.delete(token);
      if (!checks.size && this.targetedSessionStatusChecks.get(key) === checks)
        this.targetedSessionStatusChecks.delete(key);
    }
  }
  return unknown(TargetedStatusReason.EventRetired);
}

/** Native child notifications need not name every ancestor; ambiguous lineage retires all readers. */
export function invalidateTargetedSessionStatusChecks(checks: Map<string, Set<symbol>>, payload: Record<string, unknown>): void {
  const session = payload.session;
  const row = session && typeof session === 'object' && !Array.isArray(session)
    ? session as Record<string, unknown> : payload;
  const key = [row.key, payload.key, payload.sessionKey].find((value): value is string => typeof value === 'string' && value.length > 0);
  const owners = [row.spawnedBy, row.parentSessionKey, row.controlOwnerSessionKey,
    payload.spawnedBy, payload.parentSessionKey, payload.controlOwnerSessionKey,
    ...(Array.isArray(row.childOwnerSessionKeys) ? row.childOwnerSessionKeys : []),
    ...(Array.isArray(payload.childOwnerSessionKeys) ? payload.childOwnerSessionKeys : [])];
  const controlOwner = Object.hasOwn(row, 'controlOwnerSessionKey') ? row.controlOwnerSessionKey : payload.controlOwnerSessionKey;
  // A full native root publication explicitly says it has no control owner.
  // G -> C does not prove C has no parent S, even when neither event field names S.
  if (!key || controlOwner !== null || owners.some(value => typeof value === 'string' && value.length > 0)) {
    checks.clear(); return;
  }
  checks.delete(key);
}

export async function getSessionRuntimeStatuses(
  this: RuntimeSessionStatusContext,
  sessionIds: string[],
  options?: { includeSubagents?: boolean; forceRefresh?: boolean; fullScan?: boolean },
): Promise<Record<string, SessionRuntimeStatus>> {
  const uniqueSessionIds = [...new Set(sessionIds.filter(Boolean))];
  const disconnected = uniqueSessionIds.filter(
    sessionId =>
      this.disconnectedSessionIds.has(sessionId) ||
      this.disconnectedRecoveryPromises.has(sessionId),
  );
  if (disconnected.length > 0) {
    await Promise.all(disconnected.map(sessionId => this.reconcileDisconnectedTurn(sessionId)));
  }
  const goalScheduling = new Map(
    uniqueSessionIds.map(sessionId => {
      const phase = this.goalContinuationCoordinator.getSnapshot(sessionId)?.phase;
      return [
        sessionId,
        phase === GoalExecutionPhase.Continuing || phase === GoalExecutionPhase.Retrying,
      ];
    }),
  );
  const localMainRunning = new Map(
    uniqueSessionIds.map(sessionId => [
      sessionId,
      (!this.disconnectedSessionIds.has(sessionId) && this.isSessionActive(sessionId)) ||
        this.compactionInFlightSessionIds.has(sessionId),
    ]),
  );
  const statuses: Record<string, SessionRuntimeStatus> = {};
  if (
    options?.includeSubagents !== true &&
    uniqueSessionIds.every(sessionId => localMainRunning.get(sessionId) === true)
  ) {
    for (const sessionId of uniqueSessionIds) {
      statuses[sessionId] = {
        known: true,
        mainRunning: true,
        subagentRunning: false,
        running: true,
        ...(this.rootRunIdBySession.get(sessionId)
          ? { rootRunId: this.rootRunIdBySession.get(sessionId) }
          : {}),
      };
    }
    return statuses;
  }

  const snapshot = await this.getRuntimeSessionSnapshot(
    options?.forceRefresh === true,
    options?.fullScan === true,
  );
  const parentByKey = new Map<string, string>();
  for (const row of snapshot.sessions) {
    const key = this.runtimeRowString(row.key);
    const parent = this.runtimeRowString(row.spawnedBy);
    if (key && parent) parentByKey.set(key, parent);
  }

  for (const sessionId of uniqueSessionIds) {
    const localRunning = localMainRunning.get(sessionId) === true;
    const scheduling = goalScheduling.get(sessionId) === true;
    if (!snapshot.known && !localRunning && !scheduling) {
      statuses[sessionId] = {
        known: false,
        mainRunning: false,
        subagentRunning: false,
        running: false,
      };
      continue;
    }

    const sessionKeys = new Set(this.getSessionKeysForSession(sessionId));
    const hasMainSessionRow = snapshot.sessions.some(row =>
      sessionKeys.has(this.runtimeRowString(row.key)),
    );
    const mainRunning =
      localRunning ||
      snapshot.sessions.some(row => {
        const key = this.runtimeRowString(row.key);
        return sessionKeys.has(key) && this.isRuntimeSessionRowMainActive(row);
      });
    let subagentRunning = false;
    if (options?.includeSubagents) {
      subagentRunning = snapshot.sessions.some(
        row => sessionKeys.has(this.runtimeRowString(row.key)) && row.hasActiveSubagentRun === true,
      );
      subagentRunning ||= snapshot.sessions.some(row => {
        if (!this.isRuntimeSessionRowActive(row)) return false;
        let parent = parentByKey.get(this.runtimeRowString(row.key));
        const visited = new Set<string>();
        while (parent && !visited.has(parent)) {
          if (sessionKeys.has(parent)) return true;
          visited.add(parent);
          parent = parentByKey.get(parent);
        }
        return false;
      });
      const cachedSubagents = this.subagentStatusCache.get(sessionId);
      if (cachedSubagents && cachedSubagents.expiresAt > Date.now()) {
        subagentRunning ||= cachedSubagents.subagents.some(
          subagent =>
            subagent.status === SUBAGENT_STATUSES.PENDING ||
            subagent.status === SUBAGENT_STATUSES.RUNNING,
        );
      }
    }
    const requestedStateIsCovered =
      mainRunning ||
      !snapshot.hasMore ||
      (hasMainSessionRow && options?.includeSubagents !== true) ||
      subagentRunning;
    const known =
      localRunning ||
      scheduling ||
      (snapshot.known &&
        requestedStateIsCovered &&
        (!this.disconnectedSessionIds.has(sessionId) || mainRunning || subagentRunning));
    statuses[sessionId] = {
      known,
      mainRunning,
      subagentRunning,
      running: mainRunning || subagentRunning || scheduling,
      ...(mainRunning || subagentRunning || scheduling
        ? (() => {
            const rootRunId = this.rootRunIdBySession.get(sessionId);
            return rootRunId ? { rootRunId } : {};
          })()
        : {}),
    };
  }
  return statuses;
}

export function runtimeRowString(this: RuntimeSessionStatusContext, value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function isRuntimeSessionRowMainActive(
  this: RuntimeSessionStatusContext,
  row: Record<string, unknown>,
): boolean {
  return (
    row.hasActiveRun === true ||
    row.runState === 'active' ||
    // Current Gateway activity flags outrank persisted status strings.
    (row.hasActiveRun === undefined &&
      row.runState === undefined &&
      (row.status === 'pending' || row.status === 'running'))
  );
}

export function isRuntimeSessionRowActive(
  this: RuntimeSessionStatusContext,
  row: Record<string, unknown>,
): boolean {
  return (
    this.isRuntimeSessionRowMainActive(row) ||
    row.hasActiveSubagentRun === true ||
    row.subagentRunState === 'active' ||
    row.subagentRunState === 'pending'
  );
}

export function invalidateRuntimeSessionSnapshot(this: RuntimeSessionStatusContext): void {
  this.runtimeSessionSnapshot = null;
  this.runtimeSessionSnapshotGeneration += 1;
}

const SNAPSHOT_RECOVERY_DELAYS_MS = [250, 750, 1_500, 2_500] as const;
const SNAPSHOT_RECOVERY_BUDGET_MS = 10_000;

function isRetiredPluginResponse(error: unknown, getResponse: () => GatewayResponseContext | null): boolean {
  if (!(error instanceof Error)) return false;
  const { gatewayCode, code } = error as Error & { gatewayCode?: unknown; code?: unknown };
  if ((gatewayCode ?? code) !== 'UNAVAILABLE' ||
    !/^PluginInstanceUnavailableError: Plugin [^\s]{1,128} was reloaded or disabled; use its current tools\.$/.test(error.message)) return false;
  const response = getResponse();
  return response?.isCurrent() === true && response.isResponseError(error);
}

export async function getRuntimeSessionSnapshot(
  this: RuntimeSessionStatusContext,
  forceRefresh = false,
  fullScan = false,
): Promise<RuntimeSessionSnapshot> {
  const now = Date.now();
  if (
    !forceRefresh &&
    this.runtimeSessionSnapshot &&
    this.runtimeSessionSnapshot.expiresAt > now &&
    (!fullScan || !this.runtimeSessionSnapshot.hasMore)
  ) {
    return this.runtimeSessionSnapshot;
  }
  if (this.runtimeSessionSnapshotPromise) {
    if (!forceRefresh && !fullScan) return this.runtimeSessionSnapshotPromise;
    let queued = this.runtimeSessionSnapshotQueuedRefresh;
    if (!queued) {
      const pending = this.runtimeSessionSnapshotPromise;
      queued = {
        forceRefresh,
        fullScan,
        promise: pending,
      };
      const request = queued;
      this.runtimeSessionSnapshotQueuedRefresh = request;
      request.promise = pending.then(snapshot => {
        // Release the queued slot before starting the next read. Notifications
        // arriving during that read must still be able to request a newer one.
        if (this.runtimeSessionSnapshotQueuedRefresh === request) {
          this.runtimeSessionSnapshotQueuedRefresh = null;
        }
        return request.forceRefresh || (request.fullScan && snapshot.hasMore)
          ? this.getRuntimeSessionSnapshot(request.forceRefresh, request.fullScan)
          : snapshot;
      }).finally(() => {
        if (this.runtimeSessionSnapshotQueuedRefresh === request) {
          this.runtimeSessionSnapshotQueuedRefresh = null;
        }
      });
    } else {
      queued.forceRefresh ||= forceRefresh;
      queued.fullScan ||= fullScan;
    }
    return queued.promise;
  }
  const client = this.gatewayClient;
  if (!client) return { known: false, sessions: [], hasMore: false };
  if (forceRefresh) invalidateSessionListRequests(client);
  const clientGeneration = this.gatewayClientGeneration;
  const connectionCurrent = () => this.gatewayClient === client && this.gatewayClientGeneration === clientGeneration;
  let snapshotGeneration = this.runtimeSessionSnapshotGeneration;

  this.runtimeSessionSnapshotPromise = (async (): Promise<RuntimeSessionSnapshot> => {
    let recoveryDeadline: number | undefined;
    for (let attempt = 0; ; attempt += 1) {
      // Every recovery is a new scan: never combine pages across a plugin reload.
      const sessions: Array<Record<string, unknown>> = [];
      let offset = 0;
      try {
        while (true) {
          if (!connectionCurrent() || snapshotGeneration !== this.runtimeSessionSnapshotGeneration) {
            return { known: false, sessions: [], hasMore: false };
          }
          const remaining = recoveryDeadline === undefined ? undefined
            : Math.ceil(recoveryDeadline - performance.now());
          if (remaining !== undefined && remaining <= 0) throw new Error('Session snapshot recovery timed out');
          const args: Parameters<GatewayClientLike['request']> = ['sessions.list', {
            rowMode: OPENCLAW_COMPACT_SESSION_ROW_MODE,
            limit: 500,
            ...(offset > 0 ? { offset } : {}),
          }];
          if (remaining !== undefined) args[2] = { timeoutMs: remaining, signal: AbortSignal.timeout(remaining) };
          const result = await client.request<{
            sessions?: Array<Record<string, unknown>>;
            hasMore?: boolean;
          }>(...args);
          if (!connectionCurrent() || snapshotGeneration !== this.runtimeSessionSnapshotGeneration) {
            return { known: false, sessions: [], hasMore: false };
          }
          if (recoveryDeadline !== undefined && performance.now() >= recoveryDeadline) {
            throw new Error('Session snapshot recovery timed out');
          }
          const page = result.sessions ?? [];
          sessions.push(
            ...page.filter(
              row =>
                !isTeamDiscussionHoldingSessionKey(typeof row.key === 'string' ? row.key : undefined),
            ),
          );
          const hasMore =
            result.hasMore === true || (result.hasMore === undefined && page.length >= 500);
          if (!fullScan || !hasMore) return { known: true, sessions, hasMore };
          if (page.length === 0) return { known: true, sessions, hasMore: true };
          offset += page.length;
        }
      } catch (error) {
        if (!connectionCurrent()) return { known: false, sessions: [], hasMore: false };
        if (attempt >= SNAPSHOT_RECOVERY_DELAYS_MS.length ||
          !isRetiredPluginResponse(error, () => this.captureGatewayResponseContext())) throw error;
        recoveryDeadline ??= performance.now() + SNAPSHOT_RECOVERY_BUDGET_MS;
        const delay = SNAPSHOT_RECOVERY_DELAYS_MS[attempt];
        if (performance.now() + delay >= recoveryDeadline) throw error;
        await new Promise(resolve => setTimeout(resolve, delay));
        if (!connectionCurrent()) return { known: false, sessions: [], hasMore: false };
        if (performance.now() >= recoveryDeadline) throw error;
        invalidateSessionListRequests(client);
        // A fresh first page covers earlier invalidations; later events still retire it.
        snapshotGeneration = this.runtimeSessionSnapshotGeneration;
      }
    }
  })()
    .catch((error): RuntimeSessionSnapshot => {
      if (now - this.lastRuntimeStatusWarningAt >= RUNTIME_STATUS_WARNING_INTERVAL_MS) {
        this.lastRuntimeStatusWarningAt = now;
        console.warn('[OpenClawRuntime] Failed to query session runtime snapshot', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return { known: false, sessions: [], hasMore: false };
    })
    .then(snapshot => {
      if (!connectionCurrent() || snapshotGeneration !== this.runtimeSessionSnapshotGeneration) {
        return { known: false, sessions: [], hasMore: false };
      }

      this.runtimeSessionSnapshot = {
        ...snapshot,
        expiresAt: Date.now() + RUNTIME_SESSION_SNAPSHOT_TTL_MS,
      };
      return snapshot;
    })
    .finally(() => {
      this.runtimeSessionSnapshotPromise = null;
    });
  return this.runtimeSessionSnapshotPromise;
}
