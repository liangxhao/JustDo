import type { SessionDetailStats } from '@shared/cowork/sessionDetails';
import {
  type BeginSessionRunInput,
  SessionRunBeginErrorCode,
  type SessionRuntimeSnapshot,
  type SessionRunTiming,
} from '@shared/cowork/sessionRun';
import { isGatewayToolFailureNotice } from '@shared/cowork/toolFailureNotice';
import type { PermissionMode } from '@shared/openclaw/approvals';
import { isInternalManagedSubagentHandoffError } from '@shared/openclaw/internalRunError';

import {
  addGroup,
  addSession,
  clearCurrentSession,
  clearPendingInteractions,
  deleteGroup as deleteGroupAction,
  deleteSession as deleteSessionAction,
  deleteSessions as deleteSessionsAction,
  dequeuePendingInteraction,
  enqueuePendingInteraction,
  moveSessionToGroup,
  setConfig,
  setCurrentSession,
  setGroups,
  setRemoteManaged,
  setSessionMainRuntimeActivity,
  setSessionRuntimeActivity,
  setSessionRuntimeSnapshot,
  setSessionRunTimings,
  setSessions,
  setStreaming,
  touchSessionActivity,
  updateCurrentSessionPermissionMode,
  updateGroup,
  updateSessionPinned,
  updateSessionStatus,
  updateSessionTitle,
  upsertSessionRunTiming,
} from '@/features/cowork/coworkSlice';
import type {
  CoworkApiConfig,
  CoworkConfigUpdate,
  CoworkInteractionResult,
  CoworkSession,
  CoworkStartOptions,
  CreateGroupInput,
  OpenClawEngineStatus,
  SessionGroup,
  UpdateGroupInput,
} from '@/features/cowork/coworkTypes';
import { i18nService } from '@/services/i18n';
import { store } from '@/store';

type StartSessionHooks = {
  beforeSessionSelected?: (session: CoworkSession) => void;
};

const DEBUG_COWORK_SERVICE =
  typeof import.meta !== 'undefined' && import.meta.env?.VITE_DEBUG_COWORK_SERVICE === 'true';

function debugLog(...args: unknown[]): void {
  if (DEBUG_COWORK_SERVICE) {
    console.debug(...args);
  }
}

type SessionRuntimeStatus = SessionRuntimeSnapshot;

const TERMINAL_IDLE_CONFIRM_DELAY_MS = 750;
const TERMINAL_IDLE_CONFIRM_MAX_ATTEMPTS = 5;

export class CoworkService {
  private streamListenerCleanups: Array<() => void> = [];
  private initialized = false;
  private openClawStatus: OpenClawEngineStatus | null = null;
  private openClawStatusRevision = 0;
  private openClawStatusListeners = new Set<(status: OpenClawEngineStatus) => void>();
  private openClawEngineListenerAttached = false;
  private latestLoadSessionsRequestId = 0;
  private latestLoadSessionRequestId = 0;
  private readonly runtimeIdleConfirmations = new Map<string, number>();
  private readonly runtimeStatusRequestVersions = new Map<string, number>();
  private readonly terminalIdleConfirmationTimers = new Map<string, number>();
  private readonly terminalIdleConfirmationTokens = new Map<string, symbol>();
  private readonly sessionPermissionModeUpdates = new Map<
    string,
    Promise<{ success: boolean; error?: string; engineStatus?: OpenClawEngineStatus }>
  >();
  private readonly temporarySessionPermissionModes = new Map<string, PermissionMode>();

  async init(): Promise<void> {
    if (this.initialized) return;

    // Load initial config
    await this.loadConfig();

    // Load sessions list
    await this.loadSessions();

    // Load session groups
    await this.loadGroups();

    // Set up stream listeners
    this.setupStreamListeners();
    this.setupOpenClawEngineListeners();

    // Load OpenClaw status
    await this.loadOpenClawEngineStatus();

    this.initialized = true;
  }

  private setupStreamListeners(): void {
    const cowork = window.electron?.cowork;
    if (!cowork) return;

    // Clean up any existing listeners
    this.cleanupListeners();

    // Lightweight activity listener. Transcript content comes directly from
    // Gateway WebChat events and never crosses the Electron IPC bridge.
    const activityCleanup = cowork.onSessionActivity(async ({ sessionId, kind, timestamp }) => {
      // Check if session exists in current list
      const state = store.getState().cowork;
      const sessionExists = state.sessions.some(s => s.id === sessionId);
      const currentSessionId = state.currentSession?.id;
      const isCurrentSession = currentSessionId === sessionId;

      debugLog('[CoworkService] ▶ onSessionActivity', {
        sessionId: sessionId.slice(0, 8),
        kind,
        sessionExists,
        isCurrentSession,
        currentSessionId: currentSessionId?.slice?.(0, 8),
        totalSessions: state.sessions.length,
        isStreaming: state.isStreaming,
      });
      if (!sessionExists) {
        // Session was created by IM or another source, refresh the session list
        debugLog(
          '[CoworkService] onSessionActivity: session NOT found in Redux, calling loadSessions...',
        );
        await this.loadSessions();
        const newState = store.getState().cowork;
        const nowExists = newState.sessions.some(s => s.id === sessionId);
        debugLog(
          '[CoworkService] onSessionActivity: after loadSessions, sessionExists=',
          nowExists,
          'totalSessions=',
          newState.sessions.length,
        );
      }

      // A new user turn means this session is actively running again
      // (especially important for IM-triggered turns that do not originate in this renderer).
      if (kind === 'user') {
        this.markSessionInProgress(sessionId);
        store.dispatch(updateSessionStatus({ sessionId, status: 'running' }));
      }

      store.dispatch(touchSessionActivity({ sessionId, timestamp }));
    });
    this.streamListenerCleanups.push(activityCleanup);

    // Extension interaction request listener
    const interactionCleanup = cowork.onStreamInteraction(({ sessionId, request }) => {
      store.dispatch(
        enqueuePendingInteraction({
          sessionId,
          toolName: request.toolName,
          toolInput: request.toolInput,
          requestId: request.requestId,
          toolUseId: request.toolUseId ?? null,
          interactionKind: request.interactionKind,
        }),
      );
    });
    this.streamListenerCleanups.push(interactionCleanup);

    // Interaction dismiss listener (timeout or server-side resolution)
    const interactionDismissCleanup = cowork.onStreamInteractionDismiss(({ requestId }) => {
      store.dispatch(dequeuePendingInteraction({ requestId }));
    });
    this.streamListenerCleanups.push(interactionDismissCleanup);

    // Listener registration happens before replay, so requests created during
    // renderer startup are either received live or deduplicated by request id.
    void cowork.replayPendingInteractions().catch(error => {
      console.error('Failed to replay pending interactions:', error);
    });

    // Complete listener
    const completeCleanup = cowork.onStreamComplete(({ sessionId, finalStatus }) => {
      // Use finalStatus from backend if provided.
      // If not provided, default to 'completed' (backward compatibility)
      const status: 'idle' | 'running' | 'completed' | 'error' = finalStatus ?? 'completed';
      store.dispatch(setSessionMainRuntimeActivity({ sessionId, running: status === 'running' }));
      if (status === 'running') {
        this.markSessionInProgress(sessionId);
      } else if (status === 'error') {
        this.confirmTerminalSessionIdle(sessionId);
      } else {
        // Main completion can precede subagent/announce completion. Confirm the
        // aggregate state twice from fresh Gateway snapshots before clearing the
        // shared UI indicator. The second check is intentionally quicker than
        // the regular running-session poll.
        this.confirmTerminalSessionIdle(sessionId);
      }
      store.dispatch(updateSessionStatus({ sessionId, status }));
    });
    this.streamListenerCleanups.push(completeCleanup);

    // Error listener
    const errorCleanup = cowork.onStreamError(({ sessionId, error }) => {
      // A failed tool call is already represented by its tool_result and does
      // not mean the overall run failed. OpenClaw can forward this synthetic
      // notice after a successfully completed turn.
      if (isGatewayToolFailureNotice(error) || isInternalManagedSubagentHandoffError(error)) {
        return;
      }
      this.confirmTerminalSessionIdle(sessionId);
      store.dispatch(updateSessionStatus({ sessionId, status: 'error' }));
    });
    this.streamListenerCleanups.push(errorCleanup);

    // Sessions changed listener (new channel sessions discovered by polling)
    const sessionsChangedCleanup = cowork.onSessionsChanged(() => {
      const beforeState = store.getState().cowork;
      debugLog(
        '[CoworkService] onSessionsChanged: received IPC event, before sessions:',
        beforeState.sessions.length,
        'sessionIds:',
        beforeState.sessions.map(s => s.id).slice(0, 5),
      );
      void this.loadSessions()
        .then(() => {
          const state = store.getState().cowork;
          debugLog(
            '[CoworkService] onSessionsChanged: loadSessions complete, total sessions:',
            state.sessions.length,
            'sessionIds:',
            state.sessions.map(s => s.id).slice(0, 5),
          );
        })
        .catch(err => {
          console.error('[CoworkService] onSessionsChanged: loadSessions FAILED:', err);
        });
    });
    this.streamListenerCleanups.push(sessionsChangedCleanup);
  }

  private setupOpenClawEngineListeners(): void {
    if (this.openClawEngineListenerAttached) return;
    const engineApi = window.electron?.openclaw?.engine;
    if (!engineApi?.onProgress) return;

    const statusCleanup = engineApi.onProgress(status => {
      this.notifyOpenClawStatus(status);
    });
    this.streamListenerCleanups.push(statusCleanup);
    this.openClawEngineListenerAttached = true;
  }

  private notifyOpenClawStatus(status: OpenClawEngineStatus): void {
    this.openClawStatus = status;
    this.openClawStatusRevision += 1;
    this.openClawStatusListeners.forEach(listener => {
      listener(status);
    });
  }

  private cleanupListeners(): void {
    this.streamListenerCleanups.forEach(cleanup => cleanup());
    this.streamListenerCleanups = [];
    this.terminalIdleConfirmationTimers.forEach(timer => window.clearTimeout(timer));
    this.terminalIdleConfirmationTimers.clear();
    this.terminalIdleConfirmationTokens.clear();
    this.openClawEngineListenerAttached = false;
  }

  async loadSessions(agentId?: string): Promise<void> {
    const requestId = ++this.latestLoadSessionsRequestId;
    const result = await window.electron?.cowork?.listSessions(agentId);
    if (result?.success && result.sessions) {
      // High-frequency IM traffic can trigger overlapping list refreshes.
      // Ignore stale responses so an older snapshot does not hide newer sessions.
      if (requestId !== this.latestLoadSessionsRequestId) {
        return;
      }
      store.dispatch(setSessions(result.sessions));
    }
  }

  async getSessionRuntimeStatus(
    sessionId: string,
    options?: { includeSubagents?: boolean; forceRefresh?: boolean; fullScan?: boolean },
  ): Promise<SessionRuntimeStatus> {
    const cowork = window.electron?.cowork;
    if (!cowork?.getSessionRuntimeStatus) {
      return {
        revision: 0,
        known: false,
        mainRunning: false,
        subagentRunning: false,
        running: false,
      };
    }
    const result = await cowork.getSessionRuntimeStatus(sessionId, options);
    if (!result.success) {
      return {
        revision: 0,
        known: false,
        mainRunning: false,
        subagentRunning: false,
        running: false,
      };
    }
    return {
      known: result.known,
      mainRunning: result.mainRunning,
      subagentRunning: result.subagentRunning,
      running: result.running,
      revision: result.revision ?? 0,
      ...(result.timing ? { timing: result.timing } : {}),
    };
  }

  async refreshSessionRuntimeActivity(
    sessionId: string,
    options?: { includeSubagents?: boolean; forceRefresh?: boolean; fullScan?: boolean },
  ): Promise<SessionRuntimeStatus | null> {
    const requestVersion = this.nextRuntimeStatusRequestVersion(sessionId);
    const status = await this.getSessionRuntimeStatus(sessionId, {
      includeSubagents: options?.includeSubagents === true,
      forceRefresh: options?.forceRefresh === true,
      ...(options?.fullScan ? { fullScan: true } : {}),
    });
    return this.applyRuntimeStatus(sessionId, status, requestVersion) ? status : null;
  }

  async refreshSessionRuntimeActivities(
    sessionIds: string[],
    options?: { fullScan?: boolean },
  ): Promise<void> {
    const uniqueSessionIds = [...new Set(sessionIds.filter(id => !id.startsWith('temp-')))];
    if (uniqueSessionIds.length === 0) return;
    const requestVersions = new Map(
      uniqueSessionIds.map(sessionId => [
        sessionId,
        this.nextRuntimeStatusRequestVersion(sessionId),
      ]),
    );
    const cowork = window.electron?.cowork;
    if (!cowork?.getSessionRuntimeStatuses) {
      await Promise.all(
        uniqueSessionIds.map(sessionId =>
          this.getSessionRuntimeStatus(sessionId, {
            includeSubagents: true,
            ...(options?.fullScan ? { fullScan: true } : {}),
          }).then(status => {
            this.applyRuntimeStatus(sessionId, status, requestVersions.get(sessionId));
          }),
        ),
      );
      return;
    }
    const result = await cowork.getSessionRuntimeStatuses(uniqueSessionIds, {
      includeSubagents: true,
      ...(options?.fullScan ? { fullScan: true } : {}),
    });
    if (!result.success) return;
    for (const sessionId of uniqueSessionIds) {
      const status = result.statuses[sessionId];
      if (status) this.applyRuntimeStatus(sessionId, status, requestVersions.get(sessionId));
    }
  }

  private nextRuntimeStatusRequestVersion(sessionId: string): number {
    const next = (this.runtimeStatusRequestVersions.get(sessionId) ?? 0) + 1;
    this.runtimeStatusRequestVersions.set(sessionId, next);
    return next;
  }

  markSessionInProgress(sessionId: string): void {
    this.cancelTerminalIdleConfirmation(sessionId);
    this.nextRuntimeStatusRequestVersion(sessionId);
    this.runtimeIdleConfirmations.delete(sessionId);
    store.dispatch(setSessionMainRuntimeActivity({ sessionId, running: true }));
    store.dispatch(setSessionRuntimeActivity({ sessionId, running: true }));
  }

  clearSessionInProgress(sessionId: string): void {
    this.cancelTerminalIdleConfirmation(sessionId);
    this.nextRuntimeStatusRequestVersion(sessionId);
    this.runtimeIdleConfirmations.delete(sessionId);
    store.dispatch(setSessionMainRuntimeActivity({ sessionId, running: false }));
    store.dispatch(setSessionRuntimeActivity({ sessionId, running: false }));
  }

  private applyRuntimeStatus(
    sessionId: string,
    status: SessionRuntimeStatus,
    requestVersion?: number,
  ): boolean {
    if (
      requestVersion !== undefined &&
      this.runtimeStatusRequestVersions.get(sessionId) !== requestVersion
    ) {
      return false;
    }
    if (!status.known) {
      this.runtimeIdleConfirmations.delete(sessionId);
      return true;
    }
    // Older preload mocks and downgrade-compatible bridges do not carry a
    // main-process revision. Keep their previous two-snapshot guard locally.
    if (status.revision === 0) {
      store.dispatch(setSessionMainRuntimeActivity({ sessionId, running: status.mainRunning }));
      if (status.running) {
        this.runtimeIdleConfirmations.delete(sessionId);
        store.dispatch(setSessionRuntimeActivity({ sessionId, running: true }));
        return true;
      }
      const confirmations = (this.runtimeIdleConfirmations.get(sessionId) ?? 0) + 1;
      this.runtimeIdleConfirmations.set(sessionId, confirmations);
      if (confirmations >= 2) {
        this.runtimeIdleConfirmations.delete(sessionId);
        store.dispatch(setSessionRuntimeActivity({ sessionId, running: false }));
      }
      return true;
    }
    store.dispatch(setSessionRuntimeSnapshot({ sessionId, snapshot: status }));
    return true;
  }

  private confirmTerminalSessionIdle(sessionId: string): void {
    this.cancelTerminalIdleConfirmation(sessionId);
    this.nextRuntimeStatusRequestVersion(sessionId);
    this.runtimeIdleConfirmations.delete(sessionId);
    const token = Symbol(sessionId);
    this.terminalIdleConfirmationTokens.set(sessionId, token);
    this.runTerminalIdleConfirmation(sessionId, token, 1);
  }

  private runTerminalIdleConfirmation(sessionId: string, token: symbol, attempt: number): void {
    void this.refreshSessionRuntimeActivity(sessionId, {
      includeSubagents: true,
      forceRefresh: true,
      // A truncated first page can prove that the main run ended, but cannot
      // prove that no descendant is still active. Terminal reconciliation must
      // cover the complete parent/child graph before closing the open receipt.
      fullScan: true,
    })
      .catch((): SessionRuntimeStatus => ({
        revision: 0,
        known: false,
        mainRunning: false,
        subagentRunning: false,
        running: false,
      }))
      .then(status => {
        if (this.terminalIdleConfirmationTokens.get(sessionId) !== token) return;
        if (store.getState().cowork.sessionRuntimeActivity[sessionId] !== true) {
          this.terminalIdleConfirmationTokens.delete(sessionId);
          return;
        }
        if (status === null || attempt >= TERMINAL_IDLE_CONFIRM_MAX_ATTEMPTS) {
          this.terminalIdleConfirmationTokens.delete(sessionId);
          return;
        }
        const timer = window.setTimeout(() => {
          this.terminalIdleConfirmationTimers.delete(sessionId);
          if (this.terminalIdleConfirmationTokens.get(sessionId) !== token) return;
          this.runTerminalIdleConfirmation(sessionId, token, attempt + 1);
        }, TERMINAL_IDLE_CONFIRM_DELAY_MS);
        this.terminalIdleConfirmationTimers.set(sessionId, timer);
      });
  }

  private cancelTerminalIdleConfirmation(sessionId: string): void {
    const timer = this.terminalIdleConfirmationTimers.get(sessionId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.terminalIdleConfirmationTimers.delete(sessionId);
    }
    this.terminalIdleConfirmationTokens.delete(sessionId);
  }

  async beginSessionRun(input: BeginSessionRunInput): Promise<SessionRunTiming> {
    this.cancelTerminalIdleConfirmation(input.sessionId);
    this.nextRuntimeStatusRequestVersion(input.sessionId);
    const result = await window.electron.cowork.beginSessionRun(input);
    if (!result.success || !result.timing) {
      if (result.snapshot) {
        this.nextRuntimeStatusRequestVersion(input.sessionId);
        store.dispatch(
          setSessionRuntimeSnapshot({
            sessionId: input.sessionId,
            snapshot: result.snapshot,
          }),
        );
      }
      const localizedError =
        result.errorCode === SessionRunBeginErrorCode.RuntimeActive
          ? i18nService.t('coworkSessionRuntimeActive')
          : result.errorCode === SessionRunBeginErrorCode.RuntimeUnknown
            ? i18nService.t('coworkSessionRuntimeUnknown')
            : result.error;
      throw new Error(localizedError || 'Failed to begin session run');
    }
    this.nextRuntimeStatusRequestVersion(input.sessionId);
    store.dispatch(
      setSessionRuntimeSnapshot({
        sessionId: input.sessionId,
        snapshot:
          result.snapshot ??
          ({
            revision: input.startedAt,
            known: true,
            mainRunning: true,
            subagentRunning: false,
            running: true,
            timing: result.timing,
          } satisfies SessionRuntimeSnapshot),
      }),
    );
    return result.timing;
  }

  async bindSessionRun(id: string, rootRunId: string, sessionId: string): Promise<void> {
    const result = await window.electron.cowork.bindSessionRun({ id, rootRunId });
    if (!result.success || !result.timing) return;
    store.dispatch(
      upsertSessionRunTiming({
        sessionId,
        timing: result.timing,
      }),
    );
  }

  async loadSessionRuns(sessionId: string): Promise<void> {
    const listSessionRuns = window.electron.cowork.listSessionRuns;
    if (!listSessionRuns) return;
    const result = await listSessionRuns(sessionId);
    if (result.success) {
      store.dispatch(setSessionRunTimings({ sessionId, timings: result.timings }));
    }
  }

  async failSessionRun(sessionId: string, id: string): Promise<void> {
    this.nextRuntimeStatusRequestVersion(sessionId);
    const result = await window.electron.cowork.failSessionRun({
      sessionId,
      id,
      endedAt: Date.now(),
    });
    this.nextRuntimeStatusRequestVersion(sessionId);
    if (result.success && result.snapshot) {
      store.dispatch(setSessionRuntimeSnapshot({ sessionId, snapshot: result.snapshot }));
    }
  }

  async loadConfig(): Promise<void> {
    const result = await window.electron?.cowork?.getConfig();
    if (result?.success && result.config) {
      store.dispatch(setConfig(result.config));
    }
  }

  async loadOpenClawEngineStatus(): Promise<OpenClawEngineStatus | null> {
    this.setupOpenClawEngineListeners();
    const engineApi = window.electron?.openclaw?.engine;
    if (!engineApi?.getStatus) {
      return null;
    }
    const statusRevision = this.openClawStatusRevision;
    const result = await engineApi.getStatus();
    if (result?.success && result.status) {
      if (statusRevision !== this.openClawStatusRevision) {
        return this.openClawStatus;
      }
      this.notifyOpenClawStatus(result.status);
      return result.status;
    }
    return this.openClawStatus;
  }

  async startSession(
    options: CoworkStartOptions,
    hooks: StartSessionHooks = {},
  ): Promise<{ session: CoworkSession | null; error?: string }> {
    const cowork = window.electron?.cowork;
    if (!cowork) {
      console.error('Cowork API not available');
      return { session: null, error: 'Cowork API not available' };
    }

    store.dispatch(setStreaming(true));

    const temporarySessionId = store.getState().cowork.currentSession?.id;
    const pendingTemporarySessionId = temporarySessionId?.startsWith('temp-')
      ? temporarySessionId
      : undefined;
    const result = await cowork.startSession(options);
    if (result.success && result.session) {
      const permissionMode = pendingTemporarySessionId
        ? await this.promoteTemporarySessionPermissionMode(
            pendingTemporarySessionId,
            result.session.id,
            result.session.permissionMode,
          )
        : result.session.permissionMode;
      const isRunning = result.timing ? result.timing.state === 'running' : true;
      const runningSession: CoworkSession = {
        ...result.session,
        permissionMode,
        status: isRunning ? 'running' : result.session.status,
      };
      hooks.beforeSessionSelected?.(runningSession);
      store.dispatch(addSession(runningSession));
      if (isRunning) this.markSessionInProgress(runningSession.id);
      if (result.timing) {
        store.dispatch(
          setSessionRuntimeSnapshot({
            sessionId: runningSession.id,
            snapshot: {
              revision: result.timing.startedAt,
              known: true,
              mainRunning: isRunning,
              subagentRunning: false,
              running: isRunning,
              timing: result.timing,
            },
          }),
        );
      }
      return { session: runningSession };
    }

    if (pendingTemporarySessionId) {
      this.temporarySessionPermissionModes.delete(pendingTemporarySessionId);
    }

    if (result.engineStatus) {
      this.notifyOpenClawStatus(result.engineStatus);
    }

    // Show a user-visible error when session start fails
    if (result.error) {
      const errorContent =
        result.code === 'ENGINE_NOT_READY'
          ? i18nService.t('coworkErrorEngineNotReady')
          : result.error;
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: errorContent }));
    }

    store.dispatch(setStreaming(false));
    console.error('Failed to start session:', result.error);
    return { session: null, error: result.error };
  }

  async stopSession(sessionId: string): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork) return false;

    try {
      const result = await cowork.stopSession(sessionId);
      if (result.success) {
        store.dispatch(setStreaming(false));
        this.confirmTerminalSessionIdle(sessionId);
        return true;
      }

      console.error('Failed to stop session:', result.error);
      return false;
    } catch (error) {
      console.error('Failed to stop session:', error);
      return false;
    }
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork) return false;

    const result = await cowork.deleteSession(sessionId);
    if (result.success) {
      store.dispatch(deleteSessionAction(sessionId));
      return true;
    }

    console.error('Failed to delete session:', result.error);
    return false;
  }

  async deleteSessions(sessionIds: string[]): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork) return false;

    const result = await cowork.deleteSessions(sessionIds);
    if (result.success) {
      store.dispatch(deleteSessionsAction(sessionIds));
      return true;
    }

    console.error('Failed to batch delete sessions:', result.error);
    return false;
  }

  async setSessionPinned(sessionId: string, pinned: boolean): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork?.setSessionPinned) return false;

    const result = await cowork.setSessionPinned({ sessionId, pinned });
    if (result.success) {
      store.dispatch(updateSessionPinned({ sessionId, pinned }));
      return true;
    }

    console.error('Failed to update session pin:', result.error);
    return false;
  }

  async renameSession(sessionId: string, title: string): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork?.renameSession) return false;

    const normalizedTitle = title.trim();
    if (!normalizedTitle) return false;

    const result = await cowork.renameSession({ sessionId, title: normalizedTitle });
    if (result.success) {
      store.dispatch(updateSessionTitle({ sessionId, title: normalizedTitle }));
      return true;
    }

    console.error('Failed to rename session:', result.error);
    return false;
  }

  async getSessionDetails(sessionId: string): Promise<{
    session: CoworkSession | null;
    stats?: SessionDetailStats;
    gatewaySessionId?: string;
    error?: string;
  }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.getSessionDetails) {
      return { session: null, error: 'Cowork API not available' };
    }

    const result = await cowork.getSessionDetails(sessionId);
    if (result.success) {
      return {
        session: result.session,
        stats: result.stats,
        ...(result.gatewaySessionId ? { gatewaySessionId: result.gatewaySessionId } : {}),
      };
    }
    return { session: null, error: result.error };
  }

  async loadSession(sessionId: string): Promise<CoworkSession | null> {
    const cowork = window.electron?.cowork;
    if (!cowork) return null;
    const requestId = ++this.latestLoadSessionRequestId;

    const result = await cowork.getSession(sessionId);
    if (result.success && result.session) {
      // Keep only the latest session load result to avoid stale async overwrites.
      if (requestId !== this.latestLoadSessionRequestId) {
        return result.session;
      }
      const mainRuntimeRunning =
        store.getState().cowork.sessionMainRuntimeActivity[sessionId] === true ||
        result.session.status === 'running';
      const session = mainRuntimeRunning
        ? { ...result.session, status: 'running' as const }
        : result.session;
      store.dispatch(setCurrentSession(session));
      void this.loadSessionRuns(sessionId);
      if (mainRuntimeRunning) {
        this.markSessionInProgress(sessionId);
      }
      store.dispatch(setStreaming(mainRuntimeRunning));

      const imResult = await cowork.remoteManaged(sessionId);
      if (requestId === this.latestLoadSessionRequestId) {
        store.dispatch(setRemoteManaged(imResult?.remoteManaged ?? false));
      }

      return result.session;
    }

    console.error('Failed to load session:', result.error);
    return null;
  }

  async respondToInteraction(requestId: string, result: CoworkInteractionResult): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork) return false;

    try {
      const response = await cowork.respondToInteraction({ requestId, result });
      if (response.success) {
        store.dispatch(dequeuePendingInteraction({ requestId }));
        return true;
      }

      console.error('Failed to respond to interaction:', response.error);
      return false;
    } catch (error) {
      console.error('Failed to respond to interaction:', error);
      return false;
    }
  }

  async updateConfig(config: CoworkConfigUpdate): Promise<boolean> {
    return (await this.updateConfigResult(config)).success;
  }

  async updatePermissionMode(
    permissionMode: PermissionMode,
  ): Promise<{ success: boolean; error?: string; engineStatus?: OpenClawEngineStatus }> {
    const currentSession = store.getState().cowork.currentSession;
    if (currentSession) {
      if (currentSession.permissionMode === permissionMode) return { success: true };
      if (currentSession.id.startsWith('temp-')) {
        this.temporarySessionPermissionModes.set(currentSession.id, permissionMode);
        store.dispatch(
          updateCurrentSessionPermissionMode({
            sessionId: currentSession.id,
            permissionMode,
          }),
        );
        return { success: true };
      }

      const previousUpdate = this.sessionPermissionModeUpdates.get(currentSession.id);
      const update = (async () => {
        if (previousUpdate) await previousUpdate;
        const result = await this.setSessionPermissionMode(currentSession.id, permissionMode, true);
        if (result.success) {
          store.dispatch(
            updateCurrentSessionPermissionMode({
              sessionId: currentSession.id,
              permissionMode,
            }),
          );
        }
        return result;
      })();
      this.sessionPermissionModeUpdates.set(currentSession.id, update);
      try {
        return await update;
      } finally {
        if (this.sessionPermissionModeUpdates.get(currentSession.id) === update) {
          this.sessionPermissionModeUpdates.delete(currentSession.id);
        }
      }
    }

    const previousConfig = store.getState().cowork.config;
    if (previousConfig.permissionMode === permissionMode) return { success: true };

    store.dispatch(setConfig({ ...previousConfig, permissionMode }));
    try {
      const result = await this.updateConfigResult({ permissionMode });
      if (!result.success) store.dispatch(setConfig(previousConfig));
      return result;
    } catch (error) {
      const cowork = window.electron?.cowork;
      const authoritative = await cowork?.getConfig().catch(() => null);
      store.dispatch(
        setConfig(
          authoritative?.success && authoritative.config ? authoritative.config : previousConfig,
        ),
      );
      throw error;
    }
  }

  private async promoteTemporarySessionPermissionMode(
    temporarySessionId: string,
    canonicalSessionId: string,
    initialPermissionMode: PermissionMode,
  ): Promise<PermissionMode> {
    let appliedPermissionMode = initialPermissionMode;
    while (true) {
      const requestedPermissionMode = this.temporarySessionPermissionModes.get(temporarySessionId);
      if (!requestedPermissionMode || requestedPermissionMode === appliedPermissionMode) {
        if (
          this.temporarySessionPermissionModes.get(temporarySessionId) === requestedPermissionMode
        ) {
          this.temporarySessionPermissionModes.delete(temporarySessionId);
        }
        return appliedPermissionMode;
      }

      const result = await this.setSessionPermissionMode(
        canonicalSessionId,
        requestedPermissionMode,
        true,
      );
      if (result.success) {
        appliedPermissionMode = requestedPermissionMode;
        continue;
      }
      if (
        this.temporarySessionPermissionModes.get(temporarySessionId) !== requestedPermissionMode
      ) {
        continue;
      }

      this.temporarySessionPermissionModes.delete(temporarySessionId);
      const message = i18nService.t('coworkPermissionModeUpdateFailed');
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
      return appliedPermissionMode;
    }
  }

  async reconcileSessionPermissionMode(
    sessionId: string,
  ): Promise<{ success: boolean; error?: string; engineStatus?: OpenClawEngineStatus }> {
    const pendingUpdate = this.sessionPermissionModeUpdates.get(sessionId);
    if (pendingUpdate) {
      const result = await pendingUpdate;
      if (!result.success) return result;
    }

    const state = store.getState().cowork;
    const session = state.currentSession?.id === sessionId ? state.currentSession : undefined;
    if (!session) return { success: false, error: 'Session not found' };
    return this.setSessionPermissionMode(sessionId, session.permissionMode);
  }

  private async setSessionPermissionMode(
    sessionId: string,
    permissionMode: PermissionMode,
    deferIfActive = false,
  ): Promise<{ success: boolean; error?: string; engineStatus?: OpenClawEngineStatus }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.setSessionPermissionMode) {
      return { success: false, error: 'Cowork API not available' };
    }
    const result = await cowork.setSessionPermissionMode({
      sessionId,
      permissionMode,
      deferIfActive,
    });
    if (result.engineStatus) this.notifyOpenClawStatus(result.engineStatus);
    return result;
  }

  async updateConfigResult(
    config: CoworkConfigUpdate,
  ): Promise<{ success: boolean; error?: string; engineStatus?: OpenClawEngineStatus }> {
    const cowork = window.electron?.cowork;
    if (!cowork) return { success: false };

    const currentConfig = store.getState().cowork.config;
    const engineChanged =
      config.agentEngine !== undefined && config.agentEngine !== currentConfig.agentEngine;
    const result = await cowork.setConfig(config);
    if (result.success) {
      const authoritative = await cowork.getConfig().catch(() => null);
      store.dispatch(
        setConfig(
          authoritative?.success && authoritative.config
            ? authoritative.config
            : { ...store.getState().cowork.config, ...config },
        ),
      );
      if (engineChanged) {
        store.dispatch(clearPendingInteractions());
        store.dispatch(setStreaming(false));
      }
      return result;
    }

    console.error('Failed to update config:', result.error);
    return result;
  }

  async getApiConfig(): Promise<CoworkApiConfig | null> {
    if (!window.electron?.getApiConfig) {
      return null;
    }
    return window.electron.getApiConfig();
  }

  async checkApiConfig(options?: {
    probeModel?: boolean;
  }): Promise<{ hasConfig: boolean; config: CoworkApiConfig | null; error?: string } | null> {
    if (!window.electron?.checkApiConfig) {
      return null;
    }
    return window.electron.checkApiConfig(options);
  }

  async saveApiConfig(
    config: CoworkApiConfig,
  ): Promise<{ success: boolean; error?: string } | null> {
    if (!window.electron?.saveApiConfig) {
      return null;
    }
    return window.electron.saveApiConfig(config);
  }

  onOpenClawEngineStatus(callback: (status: OpenClawEngineStatus) => void): () => void {
    this.setupOpenClawEngineListeners();
    this.openClawStatusListeners.add(callback);
    if (this.openClawStatus) {
      callback(this.openClawStatus);
    }
    return () => {
      this.openClawStatusListeners.delete(callback);
    };
  }

  async getOpenClawEngineStatus(): Promise<OpenClawEngineStatus | null> {
    return this.loadOpenClawEngineStatus();
  }

  async restartOpenClawGateway(): Promise<OpenClawEngineStatus | null> {
    const engineApi = window.electron?.openclaw?.engine;
    if (!engineApi?.restartGateway) {
      return null;
    }
    const result = await engineApi.restartGateway();
    if (result?.status) {
      this.notifyOpenClawStatus(result.status);
      return result.status;
    }
    return this.openClawStatus;
  }

  async generateSessionTitle(prompt: string | null, sessionId: string): Promise<string | null> {
    if (!window.electron?.generateSessionTitle) {
      return null;
    }
    return window.electron.generateSessionTitle({ userInput: prompt, sessionId });
  }

  async patchSessionModel(options: {
    sessionId: string;
    model: string;
    agentId?: string;
  }): Promise<{
    success: boolean;
    modelRef?: string;
    appliesTo?: 'next-turn' | 'subsequent-calls';
    source?: 'gateway' | 'local-cache' | 'agent-default';
    error?: string;
  }> {
    if (!window.electron?.cowork?.patchSessionModel) {
      return { success: false, error: 'patchSessionModel API not available' };
    }
    return window.electron.cowork.patchSessionModel(options);
  }

  async getSessionModel(options: { sessionId: string; agentId?: string }): Promise<{
    success: boolean;
    modelRef?: string;
    source?: 'gateway' | 'local-cache' | 'agent-default';
    error?: string;
  }> {
    if (!window.electron?.cowork?.getSessionModel) {
      return { success: false, error: 'getSessionModel API not available' };
    }
    return window.electron.cowork.getSessionModel(options);
  }

  async setDefaultModel(options: {
    modelId: string;
    providerKey?: string;
    modelRef?: string;
    agentId?: string;
  }): Promise<{ success: boolean; error?: string }> {
    if (!window.electron?.cowork?.setDefaultModel) {
      return { success: false, error: 'setDefaultModel API not available' };
    }
    return window.electron.cowork.setDefaultModel(options);
  }

  async getRecentCwds(limit?: number): Promise<string[]> {
    if (!window.electron?.getRecentCwds) {
      return [];
    }
    return window.electron.getRecentCwds(limit);
  }

  clearSession(): void {
    this.latestLoadSessionRequestId += 1;
    store.dispatch(clearCurrentSession());
  }

  // Session Group methods
  async loadGroups(): Promise<void> {
    if (!window.electron?.sessionGroup?.list) return;
    const result = await window.electron.sessionGroup.list();
    if (result.success && result.groups) {
      store.dispatch(setGroups(result.groups));
    }
  }

  // Get subagent status for a session
  async getSubTaskStatus(
    sessionId?: string,
    forceRefresh = false,
  ): Promise<{
    subagents?: Array<{
      id: string;
      taskName: string;
      sessionKey: string;
      sessionId?: string;
      label: string;
      labelSource: 'taskName' | 'label' | 'task';
      status: 'pending' | 'running' | 'done' | 'failed' | 'killed' | 'timeout';
      task?: string;
      model?: string;
      startedAt?: number;
      updatedAt?: number;
      endedAt?: number;
      runtimeMs?: number;
      totalTokens?: number;
      progressSummary?: string;
      terminalSummary?: string;
      error?: string;
      lastActivity?: string;
      lastToolName?: string;
      toolUseCount?: number;
    }>;
  }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.getSubTaskStatus) {
      return { subagents: [] };
    }

    const result = forceRefresh
      ? await cowork.getSubTaskStatus(sessionId, true)
      : await cowork.getSubTaskStatus(sessionId);
    if (result.success) {
      return {
        subagents: result.subagents,
      };
    }
    return { subagents: [] };
  }

  async createGroup(input: CreateGroupInput): Promise<SessionGroup | null> {
    if (!window.electron?.sessionGroup?.create) return null;
    const result = await window.electron.sessionGroup.create(input);
    if (result.success && result.group) {
      store.dispatch(addGroup(result.group));
      return result.group;
    }
    return null;
  }

  async updateGroup(id: string, input: UpdateGroupInput): Promise<SessionGroup | null> {
    if (!window.electron?.sessionGroup?.update) return null;
    const result = await window.electron.sessionGroup.update(id, input);
    if (result.success && result.group) {
      store.dispatch(updateGroup({ id, updates: input }));
      return result.group;
    }
    return null;
  }

  async deleteGroup(id: string): Promise<boolean> {
    if (!window.electron?.sessionGroup?.delete) return false;
    const result = await window.electron.sessionGroup.delete(id);
    if (result.success) {
      store.dispatch(deleteGroupAction(id));
      return true;
    }
    return false;
  }

  async moveSessionToGroup(sessionId: string, groupId: string | null): Promise<boolean> {
    if (!window.electron?.sessionGroup?.moveSession) return false;
    const result = await window.electron.sessionGroup.moveSession(sessionId, groupId);
    if (result.success) {
      store.dispatch(moveSessionToGroup({ sessionId, groupId }));
      return true;
    }
    return false;
  }

  async reorderGroups(groupIds: string[]): Promise<boolean> {
    if (!window.electron?.sessionGroup?.reorder) return false;
    const result = await window.electron.sessionGroup.reorder(groupIds);
    return result.success;
  }

  destroy(): void {
    this.cleanupListeners();
    this.openClawStatusListeners.clear();
    this.initialized = false;
  }
}

export const coworkService = new CoworkService();
