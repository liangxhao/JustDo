import { GoalExecutionPhase } from '../../../shared/cowork/sessionGoal';
import type { CoworkStore } from '../../data/coworkStore';
import { GoalContinuationCoordinator } from '../../openclaw/goals/goalContinuationCoordinator';
import type { GatewayClientLike } from '../gateway/types';
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
export interface RuntimeSessionStatusContext {
  readonly invalidateSubagentStatus: (sessionId: string) => void;
  readonly subagentStatusCache: Map<string, { expiresAt: number; subagents: GatewaySubagent[] }>;
  readonly subagentStatusRefreshes: Map<string, Promise<GatewaySubagent[]>>;
  readonly refreshSubagentStatuses: (sessionId: string) => Promise<GatewaySubagent[]>;
  readonly ensureGatewayClientReady: () => Promise<void>;
  readonly gatewayClient: GatewayClientLike | null;
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
  if (forceRefresh) this.invalidateSubagentStatus(sessionId);
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
  const detailHydrationRequested = !retained || retained.expiresAt <= now;
  const listing = await listGatewaySubagentsWithMetadata({
    client: this.gatewayClient,
    parentKeys: this.getSessionKeysForSession(sessionId),
    // Session lifecycle is authoritative for reactivated terminal tasks, so
    // refresh it with every status snapshot. Task detail hydration remains
    // disabled and the longer-lived cache still supplies rich task metadata.
    hydrateDetails: true,
    hydrateTaskDetails: false,
  });
  let current = listing.subagents;
  let taskLedgerComplete = !detailHydrationRequested || listing.taskLedgerComplete;
  const currentKeys = new Set(current.map(subagent => subagent.sessionKey));
  const retainedActiveMissing = retained?.subagents.some(
    subagent =>
      (subagent.status === SUBAGENT_STATUSES.PENDING ||
        subagent.status === SUBAGENT_STATUSES.RUNNING) &&
      !currentKeys.has(subagent.sessionKey),
  );
  if (!detailHydrationRequested && retainedActiveMissing) {
    const hydrated = await listGatewaySubagentsWithMetadata({
      client: this.gatewayClient,
      parentKeys: this.getSessionKeysForSession(sessionId),
      hydrateTaskDetails: false,
    });
    current = mergeGatewaySubagentSnapshots(hydrated.subagents, current);
    taskLedgerComplete = hydrated.taskLedgerComplete;
  }
  const replaceRetainedDetails = detailHydrationRequested && taskLedgerComplete;
  const currentWithRetainedDetails = retained
    ? current.map(subagent => {
        const previous = retained.subagents.find(candidate => candidate.id === subagent.id);
        return previous
          ? (mergeGatewaySubagentSnapshots([previous], [subagent])[0] ?? subagent)
          : subagent;
      })
    : current;
  const subagents =
    replaceRetainedDetails || !retained
      ? currentWithRetainedDetails
      : mergeGatewaySubagentSnapshots(retained.subagents, current);
  if (
    (this.subagentStatusGenerations.get(sessionId) ?? 0) !== refreshGeneration ||
    !this.store.getSession(sessionId)
  ) {
    return subagents;
  }
  this.subagentDetailCache.set(sessionId, {
    expiresAt: replaceRetainedDetails
      ? now + SUBAGENT_DETAIL_CACHE_TTL_MS
      : (retained?.expiresAt ?? now),
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
  options?: { includeSubagents?: boolean; forceRefresh?: boolean; fullScan?: boolean },
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
    const parent =
      this.runtimeRowString(row.spawnedBy) || this.runtimeRowString(row.parentSessionKey);
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
    const pendingSnapshot = await this.runtimeSessionSnapshotPromise;
    return forceRefresh || (fullScan && pendingSnapshot.hasMore)
      ? this.getRuntimeSessionSnapshot(forceRefresh, fullScan)
      : pendingSnapshot;
  }
  const client = this.gatewayClient;
  if (!client) return { known: false, sessions: [], hasMore: false };
  const snapshotGeneration = this.runtimeSessionSnapshotGeneration;

  this.runtimeSessionSnapshotPromise = (async (): Promise<RuntimeSessionSnapshot> => {
    const sessions: Array<Record<string, unknown>> = [];
    let offset = 0;
    while (true) {
      const result = await client.request<{
        sessions?: Array<Record<string, unknown>>;
        hasMore?: boolean;
      }>('sessions.list', {
        limit: 500,
        ...(offset > 0 ? { offset } : {}),
      });
      const page = result.sessions ?? [];
      sessions.push(...page);
      const hasMore =
        result.hasMore === true || (result.hasMore === undefined && page.length >= 500);
      if (!fullScan || !hasMore) {
        return { known: true, sessions, hasMore };
      }
      if (page.length === 0) {
        return { known: true, sessions, hasMore: true };
      }
      offset += page.length;
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
      if (snapshotGeneration !== this.runtimeSessionSnapshotGeneration) {
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
