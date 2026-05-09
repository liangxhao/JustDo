import { flushSync } from 'react-dom';

import { classifyErrorKey } from '../../common/coworkErrorClassify';
import { store } from '../store';
import {
  addGroup,
  addMessage,
  addSession,
  clearCurrentSession,
  clearPendingPermissions,
  deleteGroup as deleteGroupAction,
  deleteMessage as deleteMessageAction,
  deleteSession as deleteSessionAction,
  deleteSessions as deleteSessionsAction,
  dequeuePendingPermission,
  enqueuePendingPermission,
  moveSessionToGroup,
  setConfig,
  setCurrentSession,
  setGroups,
  setRemoteManaged,
  setSessions,
  setStreaming,
  updateGroup,
  updateMessageContent,
  updateMessageMetadata,
  updateMessageThinkingContent,
  updateMessageUsage,
  updateSessionPinned,
  updateSessionStatus,
  updateSessionTitle,
} from '../store/slices/coworkSlice';
import type {
  CoworkApiConfig,
  CoworkConfigUpdate,
  CoworkContinueOptions,
  CoworkMessage,
  CoworkPermissionResult,
  CoworkSession,
  CoworkStartOptions,
  CreateGroupInput,
  OpenClawEngineStatus,
  SessionGroup,
  UpdateGroupInput,
} from '../types/cowork';
import { i18nService } from './i18n';

const classifyError = (error: string): string => {
  const key = classifyErrorKey(error);
  return key ? i18nService.t(key) : error;
};

class CoworkService {
  private streamListenerCleanups: Array<() => void> = [];
  private initialized = false;
  private openClawStatus: OpenClawEngineStatus | null = null;
  private openClawStatusListeners = new Set<(status: OpenClawEngineStatus) => void>();
  private openClawEngineListenerAttached = false;
  private latestLoadSessionsRequestId = 0;
  private latestLoadSessionRequestId = 0;

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
      // Debug: log user messages to check if imageAttachments are preserved
      if (message.type === 'user') {
        const meta = message.metadata as Record<string, unknown> | undefined;
        console.log('[CoworkService] onStreamMessage received user message', {
          sessionId,
          messageId: message.id,
          hasMetadata: !!meta,
          metadataKeys: meta ? Object.keys(meta) : [],
          hasImageAttachments: !!meta?.imageAttachments,
          imageAttachmentsCount: Array.isArray(meta?.imageAttachments)
            ? (meta.imageAttachments as unknown[]).length
            : 0,
        });
      }
      // Check if session exists in current list
      const state = store.getState().cowork;
      const sessionExists = state.sessions.some(s => s.id === sessionId);

      console.log(
        '[CoworkService] onStreamMessage: sessionId=',
        sessionId,
        'type=',
        message.type,
        'sessionExists=',
        sessionExists,
        'totalSessions=',
        state.sessions.length,
      );
      if (!sessionExists) {
        // Session was created by IM or another source, refresh the session list
        console.log(
          '[CoworkService] onStreamMessage: session NOT found in Redux, calling loadSessions...',
        );
        await this.loadSessions();
        const newState = store.getState().cowork;
        const nowExists = newState.sessions.some(s => s.id === sessionId);
        console.log(
          '[CoworkService] onStreamMessage: after loadSessions, sessionExists=',
          nowExists,
          'totalSessions=',
          newState.sessions.length,
        );
      }

      // A new user turn means this session is actively running again
      // (especially important for IM-triggered turns that do not call continueSession from renderer).
      if (message.type === 'user') {
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

    // Permission request listener
    const permissionCleanup = cowork.onStreamPermission(({ sessionId, request }) => {
      store.dispatch(
        enqueuePendingPermission({
          sessionId,
          toolName: request.toolName,
          toolInput: request.toolInput,
          requestId: request.requestId,
          toolUseId: request.toolUseId ?? null,
        }),
      );
    });
    this.streamListenerCleanups.push(permissionCleanup);

    // Permission dismiss listener (timeout or server-side resolution)
    const permissionDismissCleanup = cowork.onStreamPermissionDismiss(({ requestId }) => {
      store.dispatch(dequeuePendingPermission({ requestId }));
    });
    this.streamListenerCleanups.push(permissionDismissCleanup);

    // Complete listener
    const completeCleanup = cowork.onStreamComplete(({ sessionId, finalStatus }) => {
      // Use finalStatus from backend if provided (includes subagent status check)
      // If not provided, default to 'completed' (backward compatibility)
      const status: 'idle' | 'running' | 'completed' | 'error' = finalStatus ?? 'completed';
      store.dispatch(updateSessionStatus({ sessionId, status }));
    });
    this.streamListenerCleanups.push(completeCleanup);

    // Error listener
    const errorCleanup = cowork.onStreamError(({ sessionId, error }) => {
      store.dispatch(updateSessionStatus({ sessionId, status: 'error' }));
      // Surface the error as a visible message so the user knows what happened.
      if (error) {
        store.dispatch(
          addMessage({
            sessionId,
            message: {
              id: `error-${Date.now()}`,
              type: 'system',
              content: classifyError(error),
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
      console.log(
        '[CoworkService] onSessionsChanged: received IPC event, before sessions:',
        beforeState.sessions.length,
        'sessionIds:',
        beforeState.sessions.map(s => s.id).slice(0, 5),
      );
      void this.loadSessions()
        .then(() => {
          const state = store.getState().cowork;
          console.log(
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

    store.dispatch(setStreaming(true));

    const result = await cowork.startSession(options);
    if (result.success && result.session) {
      store.dispatch(addSession(result.session));
      if (result.session.status !== 'running') {
        store.dispatch(setStreaming(false));
      }
      return { session: result.session };
    }

    if (result.engineStatus) {
      this.notifyOpenClawStatus(result.engineStatus);
    }

    // Show a user-visible error when session start fails
    if (result.error) {
      const errorContent =
        result.code === 'ENGINE_NOT_READY'
          ? i18nService.t('coworkErrorEngineNotReady')
          : classifyError(result.error);
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
    store.dispatch(updateSessionStatus({ sessionId: options.sessionId, status: 'running' }));

    const result = await cowork.continueSession({
      sessionId: options.sessionId,
      prompt: options.prompt,
      activeSkillIds: options.activeSkillIds,
      imageAttachments: options.imageAttachments,
    });
    if (!result.success) {
      store.dispatch(setStreaming(false));
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
            : classifyError(result.error);
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

    const result = await cowork.stopSession(sessionId);
    if (result.success) {
      store.dispatch(setStreaming(false));
      store.dispatch(updateSessionStatus({ sessionId, status: 'idle' }));
      return true;
    }

    console.error('Failed to stop session:', result.error);
    return false;
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

  async exportSessionResultImage(options: {
    rect: { x: number; y: number; width: number; height: number };
    defaultFileName?: string;
  }): Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.exportResultImage) {
      return { success: false, error: 'Cowork export API not available' };
    }

    try {
      const result = await cowork.exportResultImage(options);
      return result ?? { success: false, error: 'Failed to export session image' };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to export session image',
      };
    }
  }

  async captureSessionImageChunk(options: {
    rect: { x: number; y: number; width: number; height: number };
  }): Promise<{
    success: boolean;
    width?: number;
    height?: number;
    pngBase64?: string;
    error?: string;
  }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.captureImageChunk) {
      return { success: false, error: 'Cowork capture API not available' };
    }

    try {
      const result = await cowork.captureImageChunk(options);
      return result ?? { success: false, error: 'Failed to capture session image chunk' };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to capture session image chunk',
      };
    }
  }

  async saveSessionResultImage(options: {
    pngBase64: string;
    defaultFileName?: string;
  }): Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.saveResultImage) {
      return { success: false, error: 'Cowork save image API not available' };
    }

    try {
      const result = await cowork.saveResultImage(options);
      return result ?? { success: false, error: 'Failed to save session image' };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save session image',
      };
    }
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
      store.dispatch(setCurrentSession(result.session));
      store.dispatch(setStreaming(result.session.status === 'running'));

      const imResult = await cowork.remoteManaged(sessionId);
      if (requestId === this.latestLoadSessionRequestId) {
        store.dispatch(setRemoteManaged(imResult?.remoteManaged ?? false));
      }

      return result.session;
    }

    console.error('Failed to load session:', result.error);
    return null;
  }

  async respondToPermission(requestId: string, result: CoworkPermissionResult): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork) return false;

    const response = await cowork.respondToPermission({ requestId, result });
    if (response.success) {
      store.dispatch(dequeuePendingPermission({ requestId }));
      return true;
    }

    console.error('Failed to respond to permission:', response.error);
    return false;
  }

  async updateConfig(config: CoworkConfigUpdate): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork) return false;

    const currentConfig = store.getState().cowork.config;
    const engineChanged =
      config.agentEngine !== undefined && config.agentEngine !== currentConfig.agentEngine;
    const result = await cowork.setConfig(config);
    if (result.success) {
      store.dispatch(setConfig({ ...currentConfig, ...config }));
      if (engineChanged) {
        store.dispatch(clearPendingPermissions());
        store.dispatch(setStreaming(false));
      }
      return true;
    }

    console.error('Failed to update config:', result.error);
    return false;
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

  async installOpenClawEngine(): Promise<OpenClawEngineStatus | null> {
    const engineApi = window.electron?.openclaw?.engine;
    if (!engineApi?.install) {
      return null;
    }
    const result = await engineApi.install();
    if (result?.status) {
      this.notifyOpenClawStatus(result.status);
      return result.status;
    }
    return this.openClawStatus;
  }

  async retryOpenClawInstall(): Promise<OpenClawEngineStatus | null> {
    const engineApi = window.electron?.openclaw?.engine;
    if (!engineApi?.retryInstall) {
      return null;
    }
    const result = await engineApi.retryInstall();
    if (result?.status) {
      this.notifyOpenClawStatus(result.status);
      return result.status;
    }
    return this.openClawStatus;
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

  async generateSessionTitle(prompt: string | null): Promise<string | null> {
    if (!window.electron?.generateSessionTitle) {
      return null;
    }
    return window.electron.generateSessionTitle(prompt);
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

  // Subagent streaming listeners - for use by SubTaskDetailDrawer
  // Returns cleanup functions to be called when drawer closes
  setupSubagentListeners(
    parentSessionId: string,
    callbacks: {
      onMessage: (agentId: string, message: CoworkMessage) => void;
      onMessageUpdate: (agentId: string, messageId: string, content: string) => void;
      onThinkingUpdate: (agentId: string, messageId: string, thinkingDelta: string) => void;
      onToolResult: (agentId: string, toolUseId: string, result: string, isError: boolean) => void;
    },
  ): () => void {
    const cowork = window.electron?.cowork;
    if (!cowork) return () => {};

    const cleanups: Array<() => void> = [];

    // Subagent message listener
    const messageCleanup = cowork.onSubagentMessage(data => {
      if (data.parentSessionId === parentSessionId) {
        callbacks.onMessage(data.agentId, data.message);
      }
    });
    cleanups.push(messageCleanup);

    // Subagent message update listener
    const messageUpdateCleanup = cowork.onSubagentMessageUpdate(data => {
      if (data.parentSessionId === parentSessionId) {
        callbacks.onMessageUpdate(data.agentId, data.messageId, data.content);
      }
    });
    cleanups.push(messageUpdateCleanup);

    // Subagent thinking update listener
    const thinkingUpdateCleanup = cowork.onSubagentThinkingUpdate(data => {
      if (data.parentSessionId === parentSessionId) {
        callbacks.onThinkingUpdate(data.agentId, data.messageId, data.thinkingDelta);
      }
    });
    cleanups.push(thinkingUpdateCleanup);

    // Subagent tool result listener
    const toolResultCleanup = cowork.onSubagentToolResult(data => {
      if (data.parentSessionId === parentSessionId) {
        callbacks.onToolResult(data.agentId, data.toolUseId, data.result, data.isError);
      }
    });
    cleanups.push(toolResultCleanup);

    // Return cleanup function
    return () => {
      cleanups.forEach(cleanup => cleanup());
    };
  }

  // Get subagent history (returns full CoworkMessage[])
  async getSubTaskHistory(options: {
    parentSessionId: string;
    agentId: string;
    sessionKey?: string;
  }): Promise<CoworkMessage[]> {
    const cowork = window.electron?.cowork;
    if (!cowork?.getSubTaskHistory) return [];

    const result = await cowork.getSubTaskHistory(options);
    if (result.success && result.messages) {
      return result.messages;
    }
    return [];
  }

  // Get subagent status for a session
  async getSubTaskStatus(sessionId?: string): Promise<{
    statuses: Record<string, 'pending' | 'running' | 'done' | 'failed'>;
    displayLabels?: Record<string, string>;
  }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.getSubTaskStatus) {
      return { statuses: {} };
    }

    const result = await cowork.getSubTaskStatus(sessionId);
    if (result.success) {
      return { statuses: result.statuses, displayLabels: result.displayLabels };
    }
    return { statuses: {} };
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
