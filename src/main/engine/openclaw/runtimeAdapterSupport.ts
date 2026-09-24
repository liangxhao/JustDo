import fs from 'fs';
import path from 'path';

import {
  type SessionGoalMutationOutcome,
  type SessionGoalMutationRequest,
} from '../../../shared/cowork/sessionGoal';
import type { SessionTurn } from '../gateway/types';

export const STOP_COOLDOWN_MS = 10_000;

export const RACE_RESOLUTION_MS = 1_000;

export const FULL_HISTORY_SYNC_LIMIT = 1000;

export const TICK_WATCHDOG_INTERVAL_MS = 60_000;

export const TICK_TIMEOUT_MS = 90_000;

export const AGENT_ACTIVITY_ALIVE_WINDOW_MS = 60_000;

export const CLIENT_TIMEOUT_GRACE_MS = 30_000;

export const GATEWAY_RECONNECT_DELAYS = [2_000, 5_000, 10_000, 15_000, 30_000];

export const GATEWAY_CONNECT_RETRY_DELAYS = [500, 1_500, 3_000];

export const SUBAGENT_STATUS_CACHE_TTL_MS = 8_000;

export const SUBAGENT_DETAIL_CACHE_TTL_MS = 60_000;

export const RUNTIME_SESSION_SNAPSHOT_TTL_MS = 2_000;

export const ASK_USER_TERMINAL_CACHE_SIZE = 256;

export const TITLE_SESSION_ID_RESOLUTION_TIMEOUT_MS = 30_000;

export const TITLE_SESSION_ID_POLL_INTERVAL_MS = 100;

export const TITLE_SESSION_ID_SNAPSHOT_INTERVAL_MS = 2_000;

export const LIFECYCLE_END_FALLBACK_MS = 1_500;

export const AUTOMATION_PERMISSION_POLICY_ID = 'native-session-automation-permission';

export const ERROR_TERMINAL_SESSION_STATUSES = new Set([
  'aborted',
  'cancelled',
  'error',
  'failed',
  'killed',
  'timed_out',
  'timeout',
]);

export type SessionAbortResponse = {
  ok?: boolean;
  abortedRunId?: string | null;
  status?: 'aborted' | 'no-active-run';
};

export const RUNTIME_STATUS_WARNING_INTERVAL_MS = 30_000;

export const FULL_HISTORY_SNAPSHOT_MAX_ATTEMPTS = 3;

export const SESSION_HISTORY_SNAPSHOT_CACHE_LIMIT = 16;

export const readHistoryRecordIdentity = (message: unknown): string | undefined => {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined;
  const metadata = (message as Record<string, unknown>).__openclaw;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const record = metadata as Record<string, unknown>;
  if (typeof record.id === 'string' && record.id) return `id:${record.id}`;
  return typeof record.seq === 'number' && Number.isFinite(record.seq)
    ? `seq:${record.seq}`
    : undefined;
};

export const mergeGatewayHistoryPages = (older: unknown[], newer: unknown[]): unknown[] => {
  const olderBoundary = readHistoryRecordIdentity(older[older.length - 1]);
  const newerBoundary = readHistoryRecordIdentity(newer[0]);
  if (!olderBoundary || olderBoundary !== newerBoundary) return [...older, ...newer];
  let retainedFrom = 0;
  while (
    retainedFrom < newer.length &&
    readHistoryRecordIdentity(newer[retainedFrom]) === newerBoundary
  ) {
    retainedFrom += 1;
  }
  return [...older, ...newer.slice(retainedFrom)];
};

export type SessionRuntimeStatus = {
  known: boolean;
  mainRunning: boolean;
  subagentRunning: boolean;
  running: boolean;
  rootRunId?: string;
};

export type RuntimeSessionSnapshot = {
  known: boolean;
  sessions: Array<Record<string, unknown>>;
  hasMore: boolean;
};

export type PendingTurnStart = {
  cancelled: boolean;
  cancellationAbortError?: unknown;
  phase: 'preparing' | 'sending' | 'settled';
  settled: Promise<void>;
  resolveSettled: () => void;
  turn?: SessionTurn;
};

export interface RetainedSessionGoalMutation {
  request: SessionGoalMutationRequest;
  signature: string;
  params: Record<string, unknown>;
  promise?: Promise<SessionGoalMutationOutcome>;
}

export const readActiveRunIds = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === 'string')
        .map(entry => entry.trim())
        .filter(Boolean)
    : [];

export const normalizeWorkspacePath = (workspace: string): string => {
  const normalized = path.normalize(path.resolve(workspace));
  try {
    // Preserve per-directory case-sensitive semantics on Windows while still
    // collapsing aliases, junctions, and ordinary case-only spelling changes.
    return fs.realpathSync.native(normalized);
  } catch {
    // A missing/unreadable path is not safe to case-fold: updating the Gateway
    // again is preferable to treating two distinct paths as equivalent.
    return normalized;
  }
};

export const areWorkspacePathsEquivalent = (left: string, right: string): boolean =>
  normalizeWorkspacePath(left) === normalizeWorkspacePath(right);

export class HistorySnapshotChangedError extends Error {
  constructor() {
    super('chat.history changed while its pages were being read');
    this.name = 'HistorySnapshotChangedError';
  }
}
