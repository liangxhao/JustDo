import { isGatewayToolFailureNotice } from '@shared/cowork/toolFailureNotice';
import { DEFAULT_PERMISSION_MODE, type PermissionMode } from '@shared/openclaw/approvals';
import { flushSync } from 'react-dom';

import {
  addGroup,
  addMessage,
  addSession,
  clearCurrentSession,
  clearPendingInteractions,
  deleteGroup as deleteGroupAction,
  deleteMessage as deleteMessageAction,
  deleteMessagesFrom as deleteMessagesFromAction,
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
  setSessions,
  setStreaming,
  updateConfig,
  updateCurrentSessionPermissionMode,
  updateGroup,
  updateMessageContent,
  updateMessageMetadata,
  updateMessageThinkingContent,
  updateMessageUsage,
  updateSessionPinned,
  updateSessionStatus,
  updateSessionTitle,
} from '@/features/cowork/coworkSlice';
import type {
  CoworkApiConfig,
  CoworkConfigUpdate,
  CoworkContinueOptions,
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

const DEBUG_COWORK_SERVICE =
  typeof import.meta !== 'undefined' && import.meta.env?.VITE_DEBUG_COWORK_SERVICE === 'true';

function debugLog(...args: unknown[]): void {
  if (DEBUG_COWORK_SERVICE) {
    console.debug(...args);
  }
}

type SessionRuntimeStatus = {
  known: boolean;
  mainRunning: boolean;
  subagentRunning: boolean;
  running: boolean;
};

const TERMINAL_IDLE_CONFIRM_DELAY_MS = 750;
const TERMINAL_IDLE_CONFIRM_MAX_ATTEMPTS = 5;

class CoworkService {
  private streamListenerCleanups: Array<() => void> = [];
  private initialized = false;
  private openClawStatus: OpenClawEngineStatus | null = null;
  private openClawStatusListeners = new Set<(status: OpenClawEngineStatus) => void>();
  private openClawEngineListenerAttached = false;
  private latestLoadSessionsRequestId = 0;
  private latestLoadSessionRequestId = 0;
  private readonly runtimeIdleConfirmations = new Map<string, number>();
  private readonly runtimeStatusRequestVersions = new Map<string, number>();
  private readonly terminalIdleConfirmationTimers = new Map<string, number>();
  private readonly terminalIdleConfirmationTokens = new Map<string, symbol>();

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

    // Message listener - also check if session exists (for IM-created sessions)
    const messageCleanup = cowork.onStreamMessage(async ({ sessionId, message }) => {
      // Debug: log user messages to check if attachments are preserved
      if (message.type === 'user') {
        const meta = message.metadata as Record<string, unknown> | undefined;
        debugLog('[CoworkService] onStreamMessage received user message', {
          sessionId,
          messageId: message.id,
          hasMetadata: !!meta,
          metadataKeys: meta ? Object.keys(meta) : [],
          hasAttachments: !!meta?.attachments,
          attachmentsCount: Array.isArray(meta?.attachments)
            ? (meta.attachments as unknown[]).length
            : 0,
        });
      }
      // Check if session exists in current list
      const state = store.getState().cowork;
      const sessionExists = state.sessions.some(s => s.id === sessionId);
      const currentSessionId = state.currentSession?.id;
      const isCurrentSession = currentSessionId === sessionId;

      // Summarize message content for logging
      const msg = message as unknown as Record<string, unknown>;
      const contentPreview =
        typeof msg.content === 'string'
          ? msg.content.slice(0, 80)
          : Array.isArray(msg.content)
            ? `[${(msg.content as unknown[]).length} blocks]`
            : String(msg.content ?? '').slice(0, 80);

      debugLog('[CoworkService] ▶ onStreamMessage', {
        sessionId: sessionId.slice(0, 8),
        type: message.type,
        messageId: message.id?.slice?.(0, 8),
        sessionExists,
        isCurrentSession,
        currentSessionId: currentSessionId?.slice?.(0, 8),
        totalSessions: state.sessions.length,
        isStreaming: state.isStreaming,
        contentPreview,
      });
      if (!sessionExists) {
        // Session was created by IM or another source, refresh the session list
        debugLog(
          '[CoworkService] onStreamMessage: session NOT found in Redux, calling loadSessions...',
        );
        await this.loadSessions();
        const newState = store.getState().cowork;
        const nowExists = newState.sessions.some(s => s.id === sessionId);
        debugLog(
          '[CoworkService] onStreamMessage: after loadSessions, sessionExists=',
          nowExists,
          'totalSessions=',
          newState.sessions.length,
        );
      }

      // A new user turn means this session is actively running again
      // (especially important for IM-triggered turns that do not call continueSession from renderer).
      if (message.type === 'user') {
        this.markSessionInProgress(sessionId);
        store.dispatch(updateSessionStatus({ sessionId, status: 'running' }));
      }

      // Do not force status back to "running" on arbitrary messages.
      // Late stream chunks can arrive after an error/complete event.
      store.dispatch(addMessage({ sessionId, message }));
    });
    this.streamListenerCleanups.push(messageCleanup);

    // Message update listener (for streaming content updates)
    const messageUpdateCleanup = cowork.onStreamMessageUpdate(
      ({ sessionId, messageId, content }) => {
        store.dispatch(updateMessageContent({ sessionId, messageId, content }));
      },
    );
    this.streamListenerCleanups.push(messageUpdateCleanup);

    // Thinking update listener (for streaming thinking content)
    // Use flushSync to force immediate rendering for each delta update
    // This ensures the user sees the thinking content stream in real-time
    const thinkingUpdateCleanup = cowork.onStreamThinkingUpdate(
      ({ sessionId, messageId, thinkingDelta }) => {
        // Use flushSync to bypass React's automatic batching and render immediately
        flushSync(() => {
          store.dispatch(updateMessageThinkingContent({ sessionId, messageId, thinkingDelta }));
        });
      },
    );
    this.streamListenerCleanups.push(thinkingUpdateCleanup);

    // Message metadata update listener (for status changes like isStreaming)
    // Also carries optional usage data from reconcileWithHistory.
    const messageMetadataUpdateCleanup = cowork.onStreamMessageMetadataUpdate(
      ({ sessionId, messageId, metadata, usage }) => {
        flushSync(() => {
          store.dispatch(updateMessageMetadata({ sessionId, messageId, metadata }));
          if (usage) {
            store.dispatch(updateMessageUsage({ sessionId, messageId, usage }));
          }
        });
      },
    );
    this.streamListenerCleanups.push(messageMetadataUpdateCleanup);

    // Message delete listener (for removing messages like filtered "NO_REPLY" markers)
    const messageDeleteCleanup = cowork.onStreamMessageDelete(({ sessionId, messageId }) => {
      flushSync(() => {
        store.dispatch(deleteMessageAction({ sessionId, messageId }));
      });
    });
    this.streamListenerCleanups.push(messageDeleteCleanup);

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
        this.clearSessionInProgress(sessionId);
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
      if (isGatewayToolFailureNotice(error)) {
        return;
      }
      this.clearSessionInProgress(sessionId);
      store.dispatch(updateSessionStatus({ sessionId, status: 'error' }));
      // Surface the error as a visible message so the user knows what happened.
      if (error) {
        store.dispatch(
          addMessage({
            sessionId,
            message: {
              id: `error-${Date.now()}`,
              type: 'system',
              content: error,
              timestamp: Date.now(),
            },
          }),
        );
      }
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
    options?: { includeSubagents?: boolean; forceRefresh?: boolean },
  ): Promise<{
    known: boolean;
    mainRunning: boolean;
    subagentRunning: boolean;
    running: boolean;
  }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.getSessionRuntimeStatus) {
      return { known: false, mainRunning: false, subagentRunning: false, running: false };
    }
    const result = await cowork.getSessionRuntimeStatus(sessionId, options);
    if (!result.success) {
      return { known: false, mainRunning: false, subagentRunning: false, running: false };
    }
    return {
      known: result.known,
      mainRunning: result.mainRunning,
      subagentRunning: result.subagentRunning,
      running: result.running,
    };
  }

  async refreshSessionRuntimeActivity(
    sessionId: string,
    options?: { includeSubagents?: boolean; forceRefresh?: boolean },
  ): Promise<SessionRuntimeStatus | null> {
    const requestVersion = this.nextRuntimeStatusRequestVersion(sessionId);
    const status = await this.getSessionRuntimeStatus(sessionId, {
      includeSubagents: options?.includeSubagents === true,
      forceRefresh: options?.forceRefresh === true,
    });
    return this.applyRuntimeStatus(sessionId, status, requestVersion) ? status : null;
  }

  async refreshSessionRuntimeActivities(sessionIds: string[]): Promise<void> {
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
          this.getSessionRuntimeStatus(sessionId, { includeSubagents: true }).then(status => {
            this.applyRuntimeStatus(sessionId, status, requestVersions.get(sessionId));
          }),
        ),
      );
      return;
    }
    const result = await cowork.getSessionRuntimeStatuses(uniqueSessionIds, {
      includeSubagents: true,
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
    store.dispatch(setSessionMainRuntimeActivity({ sessionId, running: status.mainRunning }));
    if (status.running) {
      this.runtimeIdleConfirmations.delete(sessionId);
      store.dispatch(setSessionRuntimeActivity({ sessionId, running: true }));
      return true;
    }
    const idleConfirmations = (this.runtimeIdleConfirmations.get(sessionId) ?? 0) + 1;
    this.runtimeIdleConfirmations.set(sessionId, idleConfirmations);
    if (idleConfirmations >= 2) {
      this.runtimeIdleConfirmations.delete(sessionId);
      store.dispatch(setSessionRuntimeActivity({ sessionId, running: false }));
    }
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
    })
      .catch((): SessionRuntimeStatus => ({
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

  async loadConfig(): Promise<void> {
    const result = await window.electron?.cowork?.getConfig();
    if (result?.success && result.config) {
      if (!store.getState().cowork.currentSession) {
        store.dispatch(setConfig({ ...result.config, permissionMode: DEFAULT_PERMISSION_MODE }));
        if (result.config.permissionMode !== DEFAULT_PERMISSION_MODE) {
          await this.updateConfigResult({ permissionMode: DEFAULT_PERMISSION_MODE });
        }
      } else {
        store.dispatch(setConfig(result.config));
      }
    }
  }

  async loadOpenClawEngineStatus(): Promise<OpenClawEngineStatus | null> {
    this.setupOpenClawEngineListeners();
    const engineApi = window.electron?.openclaw?.engine;
    if (!engineApi?.getStatus) {
      return null;
    }
    const result = await engineApi.getStatus();
    if (result?.success && result.status) {
      this.notifyOpenClawStatus(result.status);
      return result.status;
    }
    return this.openClawStatus;
  }

  async startSession(
    options: CoworkStartOptions,
  ): Promise<{ session: CoworkSession | null; error?: string }> {
    const cowork = window.electron?.cowork;
    if (!cowork) {
      console.error('Cowork API not available');
      return { session: null, error: 'Cowork API not available' };
    }

    const activeSession = store.getState().cowork.currentSession;
    const permissionMode =
      activeSession?.permissionMode ?? store.getState().cowork.config.permissionMode;

    store.dispatch(setStreaming(true));

    const result = await cowork.startSession({ ...options, permissionMode });
    if (result.success && result.session) {
      const runningSession: CoworkSession = { ...result.session, status: 'running' };
      store.dispatch(addSession(runningSession));
      this.markSessionInProgress(runningSession.id);
      return { session: runningSession };
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

  async continueSession(options: CoworkContinueOptions): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork) {
      console.error('Cowork API not available');
      return false;
    }

    store.dispatch(setStreaming(true));
    if (options.sessionId) {
      this.markSessionInProgress(options.sessionId);
    }
    store.dispatch(updateSessionStatus({ sessionId: options.sessionId, status: 'running' }));

    const result = await cowork.continueSession({
      sessionId: options.sessionId,
      prompt: options.prompt,
      activeSkillIds: options.activeSkillIds,
      attachments: options.attachments,
    });
    if (!result.success) {
      store.dispatch(setStreaming(false));
      this.clearSessionInProgress(options.sessionId);
      if (result.engineStatus) {
        this.notifyOpenClawStatus(result.engineStatus);
      }
      if (result.code !== 'ENGINE_NOT_READY') {
        store.dispatch(updateSessionStatus({ sessionId: options.sessionId, status: 'error' }));
        if (result.error) {
          store.dispatch(
            addMessage({
              sessionId: options.sessionId,
              message: {
                id: `error-${Date.now()}`,
                type: 'system',
                content: i18nService
                  .t('coworkErrorSessionContinueFailed')
                  .replace('{error}', result.error),
                timestamp: Date.now(),
              },
            }),
          );
        }
      }
      // Show a user-visible error message in the session
      if (result.error) {
        const errorContent =
          result.code === 'ENGINE_NOT_READY'
            ? i18nService.t('coworkErrorEngineNotReady')
            : result.error;
        store.dispatch(
          addMessage({
            sessionId: options.sessionId,
            message: {
              id: `error-${Date.now()}`,
              type: 'system',
              content: errorContent,
              timestamp: Date.now(),
            },
          }),
        );
      }
      console.error('Failed to continue session:', result.error);
      return false;
    }

    return true;
  }

  async stopSession(sessionId: string): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork) return false;

    try {
      const result = await cowork.stopSession(sessionId);
      if (result.success) {
        store.dispatch(setStreaming(false));
        this.clearSessionInProgress(sessionId);
        store.dispatch(updateSessionStatus({ sessionId, status: 'idle' }));
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

  async deleteMessage(sessionId: string, messageId: string): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork) return false;

    const result = await cowork.deleteMessage(sessionId, messageId);
    if (result.success) {
      store.dispatch(deleteMessageAction({ sessionId, messageId }));
      return true;
    }

    console.error('Failed to delete message:', result.error);
    return false;
  }

  async deleteMessagesFrom(sessionId: string, messageId: string): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork?.deleteMessagesFrom) return false;

    const result = await cowork.deleteMessagesFrom(sessionId, messageId);
    if (result.success) {
      store.dispatch(deleteMessagesFromAction({ sessionId, messageId }));
      return true;
    }

    console.error('Failed to delete messages:', result.error);
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

  async getSessionDetails(
    sessionId: string,
  ): Promise<{ session: CoworkSession | null; error?: string }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.getSession) {
      return { session: null, error: 'Cowork API not available' };
    }

    const result = await cowork.getSession(sessionId);
    if (result.success && result.session) {
      return { session: result.session };
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

    const response = await cowork.respondToInteraction({ requestId, result });
    if (response.success) {
      store.dispatch(dequeuePendingInteraction({ requestId }));
      return true;
    }

    console.error('Failed to respond to interaction:', response.error);
    return false;
  }

  async updateConfig(config: CoworkConfigUpdate): Promise<boolean> {
    return (await this.updateConfigResult(config)).success;
  }

  async updatePermissionMode(
    permissionMode: PermissionMode,
  ): Promise<{ success: boolean; error?: string; engineStatus?: OpenClawEngineStatus }> {
    const session = store.getState().cowork.currentSession;
    if (!session || session.id.startsWith('temp-')) {
      const result = await this.updateConfigResult({ permissionMode });
      if (!result.success) return result;
      if (!session) return result;
      store.dispatch(
        updateCurrentSessionPermissionMode({ sessionId: session.id, permissionMode }),
      );
      return result;
    }

    const persisted = await window.electron.cowork.setSessionPermissionMode({
      sessionId: session.id,
      permissionMode,
    });
    if (!persisted.success) return persisted;

    const authoritative = await window.electron.cowork.getConfig();
    if (authoritative.success && authoritative.config) {
      store.dispatch(setConfig(authoritative.config));
    } else {
      store.dispatch(updateConfig({ permissionMode }));
    }
    store.dispatch(
      updateCurrentSessionPermissionMode({ sessionId: session.id, permissionMode }),
    );
    return { success: true };
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
      const authoritative = await cowork.getConfig();
      store.dispatch(
        setConfig(
          authoritative.success && authoritative.config
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
  }): Promise<{ success: boolean; error?: string }> {
    if (!window.electron?.cowork?.patchSessionModel) {
      return { success: false, error: 'patchSessionModel API not available' };
    }
    return window.electron.cowork.patchSessionModel(options);
  }

  async setDefaultModel(options: {
    modelId: string;
    providerKey?: string;
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
    void this.updateConfigResult({ permissionMode: DEFAULT_PERMISSION_MODE });
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
  async getSubTaskStatus(sessionId?: string): Promise<{
    subagents?: Array<{
      id: string;
      sessionKey: string;
      sessionId?: string;
      label: string;
      status: 'running' | 'done' | 'failed' | 'killed' | 'timeout';
      task?: string;
      model?: string;
      startedAt?: number;
      endedAt?: number;
      runtimeMs?: number;
      totalTokens?: number;
    }>;
  }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.getSubTaskStatus) {
      return { subagents: [] };
    }

    const result = await cowork.getSubTaskStatus(sessionId);
    if (result.success) {
      return {
        subagents: result.subagents,
      };
    }
    return { subagents: [] };
  }

  async getSubTaskSession(sessionKey: string): Promise<CoworkSession | null> {
    const cowork = window.electron?.cowork;
    if (!cowork?.getSubTaskSession) {
      return null;
    }

    const result = await cowork.getSubTaskSession(sessionKey);
    if (result.success) {
      return result.session ?? null;
    }
    return null;
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
