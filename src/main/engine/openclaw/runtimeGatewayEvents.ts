import { BrowserWindow } from 'electron';

import { SessionGoalIpc } from '../../../shared/cowork/sessionGoal';
import {
  normalizeAgentEvent,
  normalizeChatEvent,
  type NormalizedAgentEvent,
} from '../../../shared/openclaw/agentEvent';
import { ApprovalKind, OpenClawApprovalIpc } from '../../../shared/openclaw/approvals';
import { AskUserQuestionGateway, PlanModeGateway } from '../../../shared/openclaw/extensions';
import { isInternalManagedSubagentHandoffError } from '../../../shared/openclaw/internalRunError';
import type { MessageDomainAdmission } from '../../../shared/openclaw/messageDomain';
import {
  classifyChatEvent,
  normalizeMessageSessionKey,
  normalizeToolEvent,
} from '../../../shared/openclaw/messageDomain';
import { WORKBOARD_CHANGED_EVENT } from '../../../shared/openclaw/workboard';
import { coworkLog } from '../../cowork/coworkLogger';
import type { CoworkSessionStatus, CoworkStore } from '../../data/coworkStore';
import { GoalContinuationCoordinator } from '../../openclaw/goals/goalContinuationCoordinator';
import { SessionExecApprovalGrants } from '../../openclaw/permissions/sessionExecApprovalGrants';
import { isRecord } from '../gateway/helpers';
import type { GatewayEventFrame, SessionTurn } from '../gateway/types';
import { ERROR_TERMINAL_SESSION_STATUSES } from './runtimeAdapterSupport';
import { type GatewaySubagent } from './subagentGateway';
import { parseTaskEventV2026_9_2 } from './wire/v2026_9_2';
export interface RuntimeGatewayEventsContext {
  readonly emit: (eventName: string | symbol, ...args: unknown[]) => boolean;
  lastTickTimestamp: number;
  readonly handleChatEvent: (payload: unknown, frameSeq?: number) => void;
  lastAgentActivityTimestamp: number;
  readonly handleAgentEvent: (
    deliveryEvent: 'agent' | 'session.tool',
    payload: unknown,
    frameSeq?: number,
  ) => void;
  readonly handleSessionMessageEvent: (payload: unknown) => void;
  readonly handleAskUserRequested: (payload: unknown) => void;
  readonly handleAskUserResolved: (payload: unknown) => void;
  readonly handlePlanModeRequested: (payload: unknown) => Promise<void>;
  readonly handlePlanModeResolved: (payload: unknown) => Promise<void>;
  readonly handleExecApprovalRequested: (payload: unknown) => Promise<void>;
  readonly broadcastApproval: (channel: string, kind: ApprovalKind, payload: unknown) => void;
  readonly handlePluginApprovalRequested: (payload: unknown) => void;
  readonly handleTaskEvent: (payload: unknown) => void;
  readonly handleSessionOperationEvent: (payload: unknown) => void;
  readonly handleSessionsChangedEvent: (payload: unknown) => void;
  readonly resolveSessionIdBySessionKey: (sessionKey: string) => string | null;
  readonly invalidateSubagentStatusSnapshot: (sessionId: string) => void;
  readonly subagentStatusCache: Map<string, { expiresAt: number; subagents: GatewaySubagent[] }>;
  readonly subagentDetailCache: Map<string, { expiresAt: number; subagents: GatewaySubagent[] }>;
  readonly subagentStatusRefreshes: Map<string, Promise<GatewaySubagent[]>>;
  readonly invalidateSubagentStatus: (sessionId: string) => void;
  readonly sessionIdByRunId: Map<string, string>;
  readonly isRecentTerminalRun: (runId: string) => boolean;
  readonly isAnnounceRunId: (runId: string) => boolean;
  readonly ensureActiveTurn: (sessionId: string, sessionKey: string, runId: string) => void;
  readonly activeTurns: Map<string, SessionTurn>;
  readonly unknownSessionRuns: Map<
    string,
    { runId: string; cancelled: boolean; onConfirmed?: () => void }
  >;
  readonly reconcileDisconnectedTurn: (sessionId: string) => Promise<void>;
  readonly confirmUnknownSessionRunAdmission: (sessionId: string, turn: SessionTurn) => void;
  readonly rememberTerminalTurn: (turn: SessionTurn) => void;
  readonly cleanupSessionTurn: (sessionId: string) => void;
  readonly store: CoworkStore;
  readonly terminalLifecycleSessionIds: Set<string>;
  readonly terminalLifecycleErrorSessionIds: Set<string>;
  readonly resolveTurn: (sessionId: string) => void;
  legacyAgentSequence: number;
  readonly goalContinuationCoordinator: GoalContinuationCoordinator;
  readonly classifyMainAgentEvent: (
    turn: SessionTurn,
    event: NormalizedAgentEvent,
  ) => MessageDomainAdmission;
  readonly rootRunIdBySession: Map<string, string>;
  readonly handleCompactionPhase: (
    sessionId: string,
    phase: string,
    turn: SessionTurn | undefined,
  ) => void;
  readonly scheduleLifecycleEndFallback: (sessionId: string, turn: SessionTurn) => void;
  readonly sessionExecApprovalGrants: SessionExecApprovalGrants;
  readonly clearCompactionInFlight: (sessionId: string) => void;
  readonly compactionInFlightSessionIds: Set<string>;
  readonly lifecycleEndFallbackTimers: Map<string, NodeJS.Timeout>;
  readonly invalidateRuntimeSessionSnapshot: () => void;
}

export function handleGatewayEvent(
  this: RuntimeGatewayEventsContext,
  event: GatewayEventFrame,
): void {
  this.emit('gatewayEvent', event);
  if (event.event === 'tick') {
    this.lastTickTimestamp = Date.now();
    return;
  }

  if (event.event === 'chat') {
    this.handleChatEvent(event.payload, event.seq);
    return;
  }

  if (event.event === 'agent') {
    this.lastAgentActivityTimestamp = Date.now();
    this.handleAgentEvent('agent', event.payload, event.seq);
    return;
  }

  if (event.event === 'session.tool') {
    this.lastAgentActivityTimestamp = Date.now();
    this.handleAgentEvent('session.tool', event.payload, event.seq);
    return;
  }

  if (event.event === 'session.message') {
    this.handleSessionMessageEvent(event.payload);
    return;
  }

  if (event.event === AskUserQuestionGateway.REQUESTED_EVENT) {
    this.handleAskUserRequested(event.payload);
    return;
  }

  if (event.event === AskUserQuestionGateway.RESOLVED_EVENT) {
    this.handleAskUserResolved(event.payload);
    return;
  }

  if (event.event === PlanModeGateway.REQUESTED_EVENT) {
    void this.handlePlanModeRequested(event.payload).catch(error => {
      coworkLog('ERROR', 'OpenClawRuntime', 'Failed to handle Plan mode request event', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return;
  }

  if (event.event === PlanModeGateway.RESOLVED_EVENT) {
    void this.handlePlanModeResolved(event.payload).catch(error => {
      coworkLog('ERROR', 'OpenClawRuntime', 'Failed to handle Plan mode resolved event', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return;
  }

  if (event.event === 'exec.approval.requested') {
    void this.handleExecApprovalRequested(event.payload);
    return;
  }

  if (event.event === 'exec.approval.resolved') {
    this.broadcastApproval(OpenClawApprovalIpc.Resolved, ApprovalKind.Exec, event.payload);
    return;
  }

  if (event.event === 'plugin.approval.requested') {
    void this.handlePluginApprovalRequested(event.payload);
    return;
  }

  if (event.event === 'plugin.approval.resolved') {
    this.broadcastApproval(OpenClawApprovalIpc.Resolved, ApprovalKind.Plugin, event.payload);
    return;
  }

  if (event.event === 'cron') {
    this.emit('cronChanged', event.payload);
    return;
  }

  if (event.event === WORKBOARD_CHANGED_EVENT) {
    this.emit('workboardChanged', event.payload);
    return;
  }

  if (event.event === 'task') {
    this.handleTaskEvent(event.payload);
    return;
  }

  if (event.event === 'session.operation') {
    this.handleSessionOperationEvent(event.payload);
    return;
  }

  if (event.event === 'sessions.changed') {
    this.handleSessionsChangedEvent(event.payload);
    return;
  }
}

export function handleTaskEvent(this: RuntimeGatewayEventsContext, payload: unknown): void {
  try {
    const event = parseTaskEventV2026_9_2(payload);
    if (event.action === 'upserted') {
      const sessionIds = new Set<string>();
      for (const sessionKey of [
        event.task.sessionKey,
        event.task.childSessionKey,
        event.task.ownerKey,
      ]) {
        if (sessionKey) {
          const sessionId = this.resolveSessionIdBySessionKey(sessionKey);
          if (sessionId) sessionIds.add(sessionId);
        }
      }
      if (sessionIds.size > 0) {
        for (const sessionId of sessionIds) {
          this.invalidateSubagentStatusSnapshot(sessionId);
          this.emit('taskChanged', { sessionId });
        }
        return;
      }
    }
    // Deleted events intentionally expose only taskId, while a restored ledger can affect
    // every requester. Invalidate all known parent snapshots for both event shapes.
    for (const sessionId of new Set([
      ...this.subagentStatusCache.keys(),
      ...this.subagentDetailCache.keys(),
      ...this.subagentStatusRefreshes.keys(),
    ])) {
      if (event.action === 'upserted') {
        this.invalidateSubagentStatusSnapshot(sessionId);
      } else {
        this.invalidateSubagentStatus(sessionId);
      }
    }
    this.emit('taskChanged', {});
  } catch (error) {
    coworkLog('WARN', 'OpenClawRuntime', 'Ignored malformed v2026.9.2 task event', {
      error: String(error),
    });
  }
}

export function handleChatEvent(
  this: RuntimeGatewayEventsContext,
  payload: unknown,
  frameSeq?: number,
): void {
  const event = normalizeChatEvent({ payload, frameSeq });
  if (!event) return;
  const sessionKey = event.sessionKey;
  const runId = event.runId ?? '';

  let sessionId = runId ? (this.sessionIdByRunId.get(runId) ?? null) : null;
  if (!sessionId && sessionKey) {
    sessionId = this.resolveSessionIdBySessionKey(sessionKey);
  }
  if (!sessionId) return;
  // Gateway reconnects can replay a terminal run. Reject it before creating
  // local lifecycle state; otherwise a late delta/start can strand the
  // session in running even though its final event was already accepted.
  if (runId && this.isRecentTerminalRun(runId)) return;
  if (sessionKey && runId && !this.isAnnounceRunId(runId)) {
    this.ensureActiveTurn(sessionId, sessionKey, runId);
  }

  const turn = this.activeTurns.get(sessionId);
  if (!turn) return;

  const admission = classifyChatEvent({
    selected: { sessionKey: turn.sessionKey, sessionId: turn.gatewaySessionId },
    activeRun: turn,
    event,
  });
  if (admission === 'ignored-session') return;

  if (runId && turn.runId !== runId && this.isAnnounceRunId(runId)) {
    if (event.state !== 'delta') turn.knownRunIds.add(runId);
    return;
  }
  if (turn.runId && !runId) return;
  if (admission === 'ignored-run') return;
  if (this.unknownSessionRuns.get(sessionId)?.cancelled && event.state === 'delta') {
    void this.reconcileDisconnectedTurn(sessionId);
  }
  if (admission === 'bind-provisional-run' && runId) {
    this.sessionIdByRunId.delete(turn.runId);
    turn.runId = runId;
    turn.knownRunIds.add(runId);
    this.sessionIdByRunId.set(runId, sessionId);
  }
  this.confirmUnknownSessionRunAdmission(sessionId, turn);
  if (!turn.gatewaySessionId && event.sessionId) turn.gatewaySessionId = event.sessionId;
  if (!turn.lifecycleGeneration && event.lifecycleGeneration) {
    turn.lifecycleGeneration = event.lifecycleGeneration;
  }

  if (event.state === 'delta') return;

  const finish = (status: 'idle' | 'error'): void => {
    this.rememberTerminalTurn(turn);
    this.cleanupSessionTurn(sessionId);
    this.store.updateSession(sessionId, { status });
    this.terminalLifecycleSessionIds.add(sessionId);
    if (status === 'error') {
      this.terminalLifecycleErrorSessionIds.add(sessionId);
    } else {
      this.terminalLifecycleErrorSessionIds.delete(sessionId);
    }
    this.resolveTurn(sessionId);
    this.emit('complete', sessionId, status);
  };

  if (event.state === 'final' || event.state === 'aborted') {
    finish('idle');
    return;
  }
  if (event.state !== 'error') return;
  if (isInternalManagedSubagentHandoffError(event.errorMessage)) {
    coworkLog('WARN', 'OpenClawRuntime', 'Suppressed internal managed handoff run error', {
      sessionId,
      runId,
    });
    finish('idle');
    return;
  }
  finish('error');
  this.emit('error', sessionId, event.errorMessage ?? 'chat error');
}

export function handleAgentEvent(
  this: RuntimeGatewayEventsContext,
  deliveryEvent: 'agent' | 'session.tool',
  payload: unknown,
  frameSeq?: number,
): void {
  let normalized = normalizeAgentEvent({ deliveryEvent, payload, frameSeq });
  if (normalized.reason === 'missing-sequence' && isRecord(payload)) {
    normalized = normalizeAgentEvent({
      deliveryEvent,
      payload: {
        ...payload,
        seq: frameSeq ?? ++this.legacyAgentSequence,
      },
      frameSeq,
    });
  }
  const event = normalized.event;
  if (!event) return;

  const { runId, stream } = event;
  const sessionKey = event.sessionKey ?? '';
  const data = event.data;
  if (stream === 'tool' && sessionKey) {
    const tool = normalizeToolEvent(data);
    this.goalContinuationCoordinator.handleToolEvent({
      runId,
      sessionKey,
      spawnedBy: event.spawnedBy,
      name: tool.name,
      toolCallId: tool.toolCallId,
      ...(tool.input === undefined ? {} : { input: tool.input }),
      ...(tool.output === null ? {} : { output: tool.output }),
      status: tool.status,
      failed: tool.failed,
    });
  }
  if (stream === 'lifecycle' && sessionKey) {
    const phase = typeof data.phase === 'string' ? data.phase : '';
    if (phase === 'start' || phase === 'end' || phase === 'error') {
      void this.goalContinuationCoordinator.handleLifecycle({
        runId,
        sessionKey,
        spawnedBy: event.spawnedBy,
        phase,
        ...(typeof data.aborted === 'boolean' ? { aborted: data.aborted } : {}),
        ...(typeof data.error === 'string' ? { error: data.error } : {}),
      });
    }
  }

  // Goal continuation consumes the complete tool/lifecycle sequence even
  // when chat final already settled the local UI lifecycle. Only suppress
  // replay before it can recreate an active Main-process turn.
  if (this.isRecentTerminalRun(runId)) return;

  let sessionId = runId ? (this.sessionIdByRunId.get(runId) ?? null) : null;
  if (!sessionId && sessionKey) {
    sessionId = this.resolveSessionIdBySessionKey(sessionKey);
  }
  if (!sessionId || event.spawnedBy || this.isAnnounceRunId(runId)) return;

  if (!this.activeTurns.has(sessionId) && stream === 'lifecycle' && data.phase === 'start') {
    this.ensureActiveTurn(sessionId, sessionKey, runId);
  }
  const turn = this.activeTurns.get(sessionId);
  if (!turn) return;

  const admission = this.classifyMainAgentEvent(turn, event);
  if (
    admission === 'ignored-session' ||
    admission === 'ignored-run' ||
    admission === 'ignored-sequence' ||
    admission === 'ignored-terminal'
  ) {
    return;
  }
  if (admission === 'bind-provisional-run') {
    this.sessionIdByRunId.delete(turn.runId);
    turn.runId = runId;
    this.rootRunIdBySession.set(sessionId, runId);
    const timing = this.store.getLatestSessionRun(sessionId);
    if (timing?.state === 'running') this.store.bindSessionRunRootRun(timing.id, runId);
  }
  if (!turn.gatewaySessionId && event.sessionId) turn.gatewaySessionId = event.sessionId;
  if (!turn.lifecycleGeneration && event.lifecycleGeneration) {
    turn.lifecycleGeneration = event.lifecycleGeneration;
  }
  turn.lastAgentSeq = event.agentSeq;
  turn.knownRunIds.add(runId);
  this.sessionIdByRunId.set(runId, sessionId);
  this.confirmUnknownSessionRunAdmission(sessionId, turn);

  if (
    this.unknownSessionRuns.get(sessionId)?.cancelled &&
    !(stream === 'lifecycle' && (data.phase === 'end' || data.phase === 'error'))
  ) {
    void this.reconcileDisconnectedTurn(sessionId);
  }
  if (stream === 'compaction') {
    const phase = typeof data.phase === 'string' ? data.phase : '';
    this.handleCompactionPhase(sessionId, phase, turn);
    return;
  }
  if (stream !== 'lifecycle') return;

  const phase = typeof data.phase === 'string' ? data.phase : '';
  const internalManagedHandoffError =
    phase === 'error' && isInternalManagedSubagentHandoffError(data.error);
  if (phase === 'end' || phase === 'error') {
    this.terminalLifecycleSessionIds.add(sessionId);
  }
  if (phase === 'error') {
    if (internalManagedHandoffError) {
      this.terminalLifecycleErrorSessionIds.delete(sessionId);
    } else {
      this.terminalLifecycleErrorSessionIds.add(sessionId);
    }
    this.scheduleLifecycleEndFallback(sessionId, turn);
  } else if (phase === 'end') {
    this.terminalLifecycleErrorSessionIds.delete(sessionId);
    this.scheduleLifecycleEndFallback(sessionId, turn);
  }
}

export function handleSessionMessageEvent(
  this: RuntimeGatewayEventsContext,
  payload: unknown,
): void {
  if (!isRecord(payload)) return;
  const sessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey.trim() : '';
  if (!sessionKey) return;
  const sessionId = this.resolveSessionIdBySessionKey(sessionKey);
  if (!sessionId) return;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(SessionGoalIpc.Changed, { sessionId });
    }
  }
}

export function handleSessionOperationEvent(
  this: RuntimeGatewayEventsContext,
  payload: unknown,
): void {
  if (!isRecord(payload)) return;
  const sessionKey = typeof payload.sessionKey === 'string' ? payload.sessionKey.trim() : '';
  if (!sessionKey) return;
  if (payload.operation === 'reset' || payload.operation === 'delete') {
    this.sessionExecApprovalGrants.clearSession(sessionKey);
    const sessionId = this.resolveSessionIdBySessionKey(sessionKey);
    if (sessionId) this.clearCompactionInFlight(sessionId);
    return;
  }
  if (payload.operation !== 'compact') return;
  const sessionId = this.resolveSessionIdBySessionKey(sessionKey);
  if (!sessionId) return;
  const phase = typeof payload.phase === 'string' ? payload.phase : '';
  this.handleCompactionPhase(sessionId, phase, this.activeTurns.get(sessionId));
}

export function handleCompactionPhase(
  this: RuntimeGatewayEventsContext,
  sessionId: string,
  phase: string,
  turn: SessionTurn | undefined,
): void {
  if (phase === 'start') {
    this.clearCompactionInFlight(sessionId);
    this.compactionInFlightSessionIds.add(sessionId);
    // The native watchdog resets with progress. Elapsed time cannot prove
    // compaction ended; terminal events and transport/session cleanup own it.
    const timer = this.lifecycleEndFallbackTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.lifecycleEndFallbackTimers.delete(sessionId);
    }
    return;
  }
  if (phase !== 'end' && phase !== 'error' && phase !== 'failed') return;
  this.clearCompactionInFlight(sessionId);
  if (turn && this.terminalLifecycleSessionIds.has(sessionId)) {
    this.scheduleLifecycleEndFallback(sessionId, turn);
  }
}

export function clearCompactionInFlight(
  this: RuntimeGatewayEventsContext,
  sessionId: string,
): void {
  this.compactionInFlightSessionIds.delete(sessionId);
}

export function clearAllCompactionInFlight(this: RuntimeGatewayEventsContext): void {
  this.compactionInFlightSessionIds.clear();
}

export function handleSessionsChangedEvent(
  this: RuntimeGatewayEventsContext,
  payload: unknown,
): void {
  if (!isRecord(payload)) return;
  this.invalidateRuntimeSessionSnapshot();
  const source = isRecord(payload.session) ? payload.session : payload;
  const sessionKey =
    (typeof source.key === 'string' && source.key.trim()) ||
    (typeof payload.sessionKey === 'string' && payload.sessionKey.trim()) ||
    (typeof payload.key === 'string' && payload.key.trim()) ||
    '';
  if (!sessionKey) return;
  const reason = typeof payload.reason === 'string' ? payload.reason.trim().toLowerCase() : '';
  if (reason === 'delete' || reason === 'reset' || reason === 'new') {
    this.sessionExecApprovalGrants.clearSession(sessionKey);
    const resetSessionId = this.resolveSessionIdBySessionKey(sessionKey);
    if (resetSessionId) this.clearCompactionInFlight(resetSessionId);
  }
  const sessionId = this.resolveSessionIdBySessionKey(sessionKey);
  if (!sessionId) return;

  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(SessionGoalIpc.Changed, { sessionId });
    }
  }

  const turn = this.activeTurns.get(sessionId);
  const hasActiveRun = source.hasActiveRun === true;
  const status = typeof source.status === 'string' ? source.status.trim().toLowerCase() : '';
  const eventMatchesTurn = Boolean(
    turn && normalizeMessageSessionKey(turn.sessionKey) === normalizeMessageSessionKey(sessionKey),
  );
  const isCreationSnapshot = reason === 'create' || reason === 'new';
  const shouldClearRun =
    eventMatchesTurn && !isCreationSnapshot && !hasActiveRun && status && status !== 'running';
  if (!shouldClearRun) return;

  const terminalStatus: CoworkSessionStatus = ERROR_TERMINAL_SESSION_STATUSES.has(status)
    ? 'error'
    : 'idle';
  this.rememberTerminalTurn(turn);
  this.cleanupSessionTurn(sessionId);
  this.store.updateSession(sessionId, { status: terminalStatus });
  this.resolveTurn(sessionId);
  this.emit('complete', sessionId, terminalStatus);
}
