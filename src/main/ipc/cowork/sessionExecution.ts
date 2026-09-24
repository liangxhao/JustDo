import { BrowserWindow, ipcMain } from 'electron';

import { MAIN_USER_AGENT_ID } from '../../../shared/agents/agents';
import type { CoworkAttachmentPayload } from '../../../shared/cowork/attachments';
import { hasMessageInput } from '../../../shared/cowork/messageInput';
import { type CancelSessionStartInput, SessionStartIpc } from '../../../shared/cowork/sessionStart';
import { resolvePermissionMode } from '../../../shared/openclaw/approvals';
import { resolveTaskWorkingDirectory } from '../../core/filesystem/taskWorkspace';
import type { CoworkStore } from '../../data/coworkStore';
import type { CoworkEngineRouter } from '../../engine';
import type { OpenClawEngineStatus } from '../../openclaw/runtime/openclawEngineManager';

interface SessionExecutionHandlerDependencies {
  ensureEngineRunning: () => Promise<OpenClawEngineStatus>;
  getCoworkStore: () => CoworkStore;
  getCoworkEngineRouter: () => CoworkEngineRouter;
  waitForConfigUpdates: () => Promise<void>;
  getEngineNotReadyResponse: (status: OpenClawEngineStatus) => {
    success: boolean;
    code: string;
    error: string;
    engineStatus: OpenClawEngineStatus;
  };
}

interface StartSessionOptions {
  prompt: string;
  gatewayPrompt?: string;
  cwd?: string;
  title?: string;
  activeSkillIds?: string[];
  attachments?: CoworkAttachmentPayload[];
  agentId?: string;
  clientTurnId?: string;
  startedAt?: number;
  planMode?: boolean;
}

const broadcastSessionError = (sessionId: string, error: unknown): void => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  BrowserWindow.getAllWindows().forEach(window => {
    if (window.isDestroyed()) return;
    window.webContents.send('cowork:stream:error', { sessionId, error: errorMessage });
  });
};

export const registerCoworkSessionExecutionHandlers = ({
  ensureEngineRunning,
  getCoworkStore,
  getCoworkEngineRouter,
  waitForConfigUpdates,
  getEngineNotReadyResponse,
}: SessionExecutionHandlerDependencies): void => {
  type PendingStart = {
    cancelled: boolean;
    sessionId?: string;
    cancelBeforeAdmission: () => void;
    cancellation: Promise<void>;
    confirmCancellation?: () => void;
    stopping?: Promise<{ success: boolean; error?: string }>;
  };
  const pendingStarts = new Map<string, PendingStart>();
  ipcMain.handle(SessionStartIpc.Cancel, async (_event, input: CancelSessionStartInput) => {
    if (!input || typeof input.clientTurnId !== 'string' || !input.clientTurnId.trim()) {
      return { success: false, error: 'Invalid start operation.' };
    }
    const operation = pendingStarts.get(input.clientTurnId);
    if (!operation) {
      // Admission may have replied immediately before this IPC was delivered.
      // An old cancellation must never abort a later turn in the same session.
      const store = getCoworkStore();
      const timing = store.getSessionRunByClientTurnId(input.clientTurnId);
      if (!timing) return { success: false, error: 'Unknown start operation.' };
      if (timing.state !== 'running') return { success: true };
      if (store.getLatestSessionRun(timing.sessionId)?.id !== timing.id) {
        return { success: false, error: 'The start operation is no longer current.' };
      }
      try {
        await getCoworkEngineRouter().stopSession(timing.sessionId);
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to stop session' };
      }
    }
    operation.cancelled = true;
    if (!operation.sessionId) {
      operation.cancelBeforeAdmission();
      return { success: true };
    }
    if (operation.stopping) return operation.stopping;
    const stopping = (async () => {
      try {
        await getCoworkEngineRouter().stopSession(operation.sessionId!);
        operation.confirmCancellation?.();
        return { success: true };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to stop session' };
      } finally {
        operation.stopping = undefined;
      }
    })();
    operation.stopping = stopping;
    return stopping;
  });
  ipcMain.handle('cowork:session:start', async (_event, options: StartSessionOptions) => {
    let operation: PendingStart | undefined;
    try {
      if (!options || typeof options.prompt !== 'string' || !hasMessageInput(options)) {
        return { success: false, error: 'Prompt is required.' };
      }
      if (
        options.gatewayPrompt !== undefined &&
        (typeof options.gatewayPrompt !== 'string' || !options.gatewayPrompt.trim())
      ) {
        return { success: false, error: 'Gateway prompt is invalid.' };
      }
      if (options.agentId && options.agentId !== MAIN_USER_AGENT_ID) {
        return { success: false, error: 'agentUnavailable' };
      }
      if (options.clientTurnId) {
        if (pendingStarts.has(options.clientTurnId)) {
          return { success: false, error: 'The start operation is already pending.' };
        }
        let cancelBeforeAdmission!: () => void;
        const cancellation = new Promise<void>(resolve => { cancelBeforeAdmission = resolve; });
        operation = { cancelled: false, cancelBeforeAdmission, cancellation };
        pendingStarts.set(options.clientTurnId, operation);
      }
      await Promise.race([waitForConfigUpdates(), ...(operation ? [operation.cancellation] : [])]);
      if (operation?.cancelled) return { success: false, cancelled: true };
      const store = getCoworkStore();
      const existingTiming = options.clientTurnId
        ? store.getSessionRunByClientTurnId(options.clientTurnId)
        : undefined;
      if (existingTiming) {
        const existingSession = store.getSession(existingTiming.sessionId);
        if (existingSession?.agentId === MAIN_USER_AGENT_ID) {
          return { success: true, session: existingSession, timing: existingTiming };
        }
      }
      const engineStatus = await Promise.race([
        ensureEngineRunning(),
        ...(operation ? [operation.cancellation.then((): null => null)] : []),
      ]);
      if (!engineStatus || operation?.cancelled) return { success: false, cancelled: true };
      if (engineStatus.phase !== 'running') {
        return getEngineNotReadyResponse(engineStatus);
      }

      const config = store.getConfig();
      const permissionMode = resolvePermissionMode(config.permissionMode);
      const selectedWorkspaceRoot = (options.cwd || config.workingDirectory || '').trim();
      if (!selectedWorkspaceRoot) {
        return { success: false, error: 'Please select a task folder before submitting.' };
      }

      const fallbackTitle = options.prompt.split('\n')[0].slice(0, 50) || 'New Session';
      const agentId = MAIN_USER_AGENT_ID;
      const agent = store.getAgent(agentId);
      if (!agent || !agent.enabled) return { success: false, error: 'agentUnavailable' };
      const initialModelRef = agentId === 'main' ? undefined : agent.model.trim() || undefined;
      const resolvedWorkspaceRoot = resolveTaskWorkingDirectory(selectedWorkspaceRoot);
      const session = store.createSession(
        options.title?.trim() || fallbackTitle,
        resolvedWorkspaceRoot,
        config.executionMode || 'local',
        options.activeSkillIds || [],
        agentId,
        permissionMode,
        initialModelRef,
      );
      store.updateSession(session.id, { status: 'running' });
      const timing =
        options.clientTurnId && Number.isFinite(options.startedAt)
          ? store.beginSessionRun({
              sessionId: session.id,
              clientTurnId: options.clientTurnId,
              startedAt: options.startedAt!,
            })
          : undefined;

      let resolveAdmission!: () => void;
      let rejectAdmission!: (error: unknown) => void;
      let admissionSettled = false;
      const admission = new Promise<void>((resolve, reject) => {
        resolveAdmission = resolve;
        rejectAdmission = reject;
      });
      const run = getCoworkEngineRouter().startSession(
        session.id,
        options.gatewayPrompt ?? options.prompt,
        {
          skillIds: options.activeSkillIds,
          workspaceRoot: resolvedWorkspaceRoot,
          confirmationMode: 'modal',
          attachments: options.attachments,
          agentId,
          clientTurnId: options.clientTurnId,
          planMode: options.planMode === true,
          onAccepted: () => {
            admissionSettled = true;
            resolveAdmission();
          },
        },
      );
      if (operation) {
        operation.sessionId = session.id;
        operation.confirmCancellation = () => {
          if (timing) store.finishSessionRun(timing.id, 'aborted', Date.now());
          if (!admissionSettled) {
            admissionSettled = true;
            resolveAdmission();
          }
        };
      }
      void run
        .then(() => {
          if (!admissionSettled) {
            admissionSettled = true;
            resolveAdmission();
          }
        })
        .catch(error => {
          if (!admissionSettled) {
            admissionSettled = true;
            rejectAdmission(error);
          }
          console.error('[Cowork] session error:', error);
          try {
            if (store.getSession(session.id)?.status !== 'error') {
              store.updateSession(session.id, { status: 'error' });
              broadcastSessionError(session.id, error);
            }
          } catch (handlerError) {
            console.error('[Cowork] failed to send error notification to renderer:', handlerError);
          }
        });
      await admission;

      return {
        success: true,
        session: store.getSession(session.id) || { ...session, status: 'running' as const },
        ...(timing ? { timing: store.getSessionRunByClientTurnId(timing.clientTurnId) ?? timing } : {}),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to start session',
      };
    } finally {
      if (operation && pendingStarts.get(options.clientTurnId!) === operation) {
        pendingStarts.delete(options.clientTurnId!);
      }
    }
  });
};
